import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { createBuiltInMcpServer } from '@mcp/runtime/createBuiltInMcpServer.js'
import type { AiWorkspaceRegistry } from '@main/aiWorkspace/AiWorkspaceRegistry.js'
import type { OrchestrationBridge } from '@main/orchestration/OrchestrationBridge.js'
import type { SessionManager } from '@main/sessionManager.js'
import {
  normalizeBuiltInMcpDomains,
  type BuiltInMcpDomain,
  type BuiltInMcpServerConfig,
  type McpSessionScope,
} from '@mcp/shared/types.js'

type SessionRegistration = {
  token: string
  scope: McpSessionScope
  server: McpServer
  inFlightRequests: number
  requestQueue: Promise<void>
  revoked: boolean
  closePromise: Promise<void> | null
}

type BuiltInMcpServerFactory = (
  scope: McpSessionScope,
  dependencies: BuiltInMcpDependencies,
) => McpServer

export type BuiltInMcpDependencies = {
  orchestrationBridge?: OrchestrationBridge
  aiWorkspaceRegistry?: AiWorkspaceRegistry
  openAiWorkspace?: (workspaceId: string) => void
  sessionManager?: SessionManager
}

function envFlag(name: string): boolean {
  const value = process.env[name]
  return value === '1' || value === 'true' || value === 'yes'
}

export class BuiltInMcpHttpHost {
  private server: Server | null = null
  private port: number | null = null
  private readonly registrations = new Map<string, SessionRegistration>()
  private readonly tokensBySession = new Map<string, string>()
  private dependencies: BuiltInMcpDependencies = {}

  constructor(private readonly createServerForScope: BuiltInMcpServerFactory = createBuiltInMcpServer) {}

  setDependencies(dependencies: BuiltInMcpDependencies): void {
    if (this.registrations.size > 0) {
      // Tool handlers close over the dependency object when the scoped server
      // is created. Silently swapping dependencies after sessions are
      // registered would give old sessions old services and new sessions new
      // services, which is worse than failing loudly. Main wires dependencies
      // once during startup before provider sessions can register.
      throw new Error('Built-in MCP dependencies must be set before sessions register')
    }
    this.dependencies = dependencies
  }

  async start(): Promise<void> {
    if (this.server) return

    // WHY the built-in MCP transport is hosted by Agent Code main instead of
    // spawning a per-agent stdio child:
    //
    // Claude and Codex both support Streamable HTTP MCP servers now, and a
    // loopback HTTP host avoids a packaging trap where a bundled Electron app
    // would need to find a separate Node executable just to run its own MCP
    // process. Keeping the server in main also gives future orchestration
    // tools direct access to the real app services (linked sessions, diffs,
    // panes) without teaching a child process how to rediscover them. The
    // security boundary is the per-session bearer token below; every provider
    // process receives only the token minted for its session.
    this.server = createServer((req, res) => {
      void this.handleRequest(req, res)
    })

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        this.server?.off('listening', onListening)
        reject(err)
      }
      const onListening = () => {
        this.server?.off('error', onError)
        const address = this.server?.address()
        if (!address || typeof address === 'string') {
          reject(new Error('Built-in MCP host did not bind to a TCP port'))
          return
        }
        this.port = address.port
        resolve()
      }
      this.server!.once('error', onError)
      this.server!.once('listening', onListening)
      this.server!.listen(0, '127.0.0.1')
    })
  }

  async stop(): Promise<void> {
    const server = this.server
    const registrations = [...this.registrations.values()]
    this.server = null
    this.port = null
    for (const registration of registrations) registration.revoked = true
    this.registrations.clear()
    this.tokensBySession.clear()
    await Promise.allSettled(registrations.map(registration => this.closeRegistration(registration)))
    if (!server) return
    await new Promise<void>(resolve => server.close(() => resolve()))
  }

  registerSession(scope: {
    sessionId: string
    cwd: string
    domains: readonly BuiltInMcpDomain[] | undefined
  }): BuiltInMcpServerConfig[] {
    const domains = normalizeBuiltInMcpDomains(scope.domains).filter(domain => {
      if (domain !== 'ping') return true
      // WHY ping is environment-gated instead of being a normal MCP domain:
      //
      // The ping tool is a bridge smoke test, not product behavior. Leaving it
      // available in ordinary sessions teaches agents a useless capability and
      // creates a precedent that every diagnostic endpoint is fair game for
      // model-visible tools. We keep the string in the type system so older
      // persisted dev sessions deserialize cleanly, but production launches
      // silently drop it unless a developer opted in for bridge testing.
      return envFlag('AGENT_CODE_MCP_PING') || envFlag('AGENT_CODE_DEV_DEBUG')
    })
    if (domains.length === 0) return []
    if (!this.server || this.port === null) {
      throw new Error('Built-in MCP host must be started before registering a session')
    }

    this.revokeSession(scope.sessionId)
    const token = randomBytes(32).toString('base64url')
    const mcpScope = {
      sessionId: scope.sessionId,
      cwd: scope.cwd,
      domains,
    }
    this.registrations.set(token, {
      token,
      scope: mcpScope,
      // WHY this server is created once per Agent Code session instead of once
      // per HTTP request: the built-in bridge registers a growing set of tools
      // and Zod schemas for orchestration, AI Workspace, and transcript access.
      // Providers commonly issue initialize/tools/list/tools/call in bursts,
      // and rebuilding the identical scoped server for every request turns
      // discovery into avoidable allocation churn. The scope remains per
      // session/token, so handlers still close over the correct parent id/cwd;
      // only the registered server object is reused.
      server: this.createServerForScope(mcpScope, this.dependencies),
      inFlightRequests: 0,
      requestQueue: Promise.resolve(),
      revoked: false,
      closePromise: null,
    })
    this.tokensBySession.set(scope.sessionId, token)

    return [
      {
        name: 'agent_code',
        // WHY the token appears in the URL even though we also provide an
        // Authorization header:
        //
        // Claude Code and Codex have different MCP config schemas and their
        // header support has moved over time. The URL token keeps the first
        // built-in bridge robust while clients converge, and the loopback-only
        // bind keeps exposure local to this machine. Future hardening can drop
        // the query fallback once both providers are proven to preserve headers
        // in every launch mode Agent Code supports.
        url: `http://127.0.0.1:${this.port}/mcp?token=${encodeURIComponent(token)}`,
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    ]
  }

  revokeSession(sessionId: string): void {
    const token = this.tokensBySession.get(sessionId)
    if (!token) return
    this.tokensBySession.delete(sessionId)
    const registration = this.registrations.get(token)
    this.registrations.delete(token)
    if (!registration) return
    registration.revoked = true
    if (registration.inFlightRequests === 0) {
      void this.closeRegistration(registration)
    }
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!req.url) {
      this.writeJson(res, 400, { error: 'missing_url' })
      return
    }
    const url = new URL(req.url, 'http://127.0.0.1')
    if (url.pathname !== '/mcp') {
      this.writeJson(res, 404, { error: 'not_found' })
      return
    }

    const registration = this.registrationForRequest(req, url)
    if (!registration) {
      this.writeJson(res, 401, { error: 'unauthorized' })
      return
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    })
    registration.inFlightRequests += 1
    const run = registration.requestQueue
      .catch(() => {})
      .then(async () => {
        // The cached server owns the expensive registered tool/schema graph,
        // but the streamable HTTP transport remains request-scoped. Serialize
        // the short connect/handle/close sequence per session so an SDK
        // implementation that stores the active transport on the server cannot
        // have two concurrent requests race that binding. Different Agent Code
        // sessions still run independently because each token has its own
        // cached server and queue.
        await this.handleWithRegistration(registration, transport, req, res)
      })
    registration.requestQueue = run.then(() => undefined, () => undefined)
    try {
      await run
    } finally {
      registration.inFlightRequests = Math.max(0, registration.inFlightRequests - 1)
      if (registration.revoked && registration.inFlightRequests === 0) {
        await this.closeRegistration(registration)
      }
    }
  }

  private async handleWithRegistration(
    registration: SessionRegistration,
    transport: StreamableHTTPServerTransport,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    try {
      await registration.server.connect(transport)
      await transport.handleRequest(req, res)
    } catch (err) {
      if (!res.headersSent) {
        const message = err instanceof Error ? err.message : String(err)
        this.writeJson(res, 500, { error: 'mcp_request_failed', message })
      }
    } finally {
      await transport.close().catch(() => undefined)
    }
  }

  private registrationForRequest(
    req: IncomingMessage,
    url: URL,
  ): SessionRegistration | null {
    const header = req.headers.authorization
    const bearer = typeof header === 'string' && header.startsWith('Bearer ')
      ? header.slice('Bearer '.length).trim()
      : null
    const token = bearer || url.searchParams.get('token')
    if (!token) return null
    const registration = this.registrations.get(token) ?? null
    return registration && !registration.revoked ? registration : null
  }

  private closeRegistration(registration: SessionRegistration): Promise<void> {
    if (!registration.closePromise) {
      registration.closePromise = registration.server.close().catch(() => undefined)
    }
    return registration.closePromise
  }

  private writeJson(res: ServerResponse, statusCode: number, payload: unknown): void {
    res.statusCode = statusCode
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(payload))
  }
}
