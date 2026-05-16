import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'

import { createBuiltInMcpServer } from '@mcp/runtime/createBuiltInMcpServer.js'
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
}

export type BuiltInMcpDependencies = {
  orchestrationBridge?: OrchestrationBridge
  sessionManager?: SessionManager
}

export class BuiltInMcpHttpHost {
  private server: Server | null = null
  private port: number | null = null
  private readonly registrations = new Map<string, SessionRegistration>()
  private readonly tokensBySession = new Map<string, string>()
  private dependencies: BuiltInMcpDependencies = {}

  setDependencies(dependencies: BuiltInMcpDependencies): void {
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
    this.server = null
    this.port = null
    this.registrations.clear()
    this.tokensBySession.clear()
    if (!server) return
    await new Promise<void>(resolve => server.close(() => resolve()))
  }

  registerSession(scope: {
    sessionId: string
    cwd: string
    domains: readonly BuiltInMcpDomain[] | undefined
  }): BuiltInMcpServerConfig[] {
    const domains = normalizeBuiltInMcpDomains(scope.domains)
    if (domains.length === 0) return []
    if (!this.server || this.port === null) {
      throw new Error('Built-in MCP host must be started before registering a session')
    }

    this.revokeSession(scope.sessionId)
    const token = randomBytes(32).toString('base64url')
    this.registrations.set(token, {
      token,
      scope: {
        sessionId: scope.sessionId,
        cwd: scope.cwd,
        domains,
      },
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
    this.registrations.delete(token)
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

    const mcpServer = createBuiltInMcpServer(registration.scope, this.dependencies)
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    })
    try {
      await mcpServer.connect(transport)
      await transport.handleRequest(req, res)
    } catch (err) {
      if (!res.headersSent) {
        const message = err instanceof Error ? err.message : String(err)
        this.writeJson(res, 500, { error: 'mcp_request_failed', message })
      }
    } finally {
      await mcpServer.close().catch(() => undefined)
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
    return this.registrations.get(token) ?? null
  }

  private writeJson(res: ServerResponse, statusCode: number, payload: unknown): void {
    res.statusCode = statusCode
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(payload))
  }
}
