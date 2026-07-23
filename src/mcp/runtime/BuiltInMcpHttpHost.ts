import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { performance } from 'node:perf_hooks'

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { createBuiltInMcpServer } from '@mcp/runtime/createBuiltInMcpServer.js'
import type { AiWorkspaceRegistry } from '@main/aiWorkspace/AiWorkspaceRegistry.js'
import type { OrchestrationBridge } from '@main/orchestration/OrchestrationBridge.js'
import type { SessionManager } from '@main/sessionManager.js'
import type { AppRunJournal } from '@main/incident/AppRunJournal.js'
import type { WorkflowBridge } from '@main/workflows/WorkflowBridge.js'
import type { WorkflowService } from 'workflow-mcp'
import { performanceService } from '@main/performance/PerformanceService.js'
import { filterBuiltInMcpDomainsForProvider } from '@mcp/shared/types.js'
import type {
  BuiltInMcpDomain,
  BuiltInMcpServerConfig,
  McpSessionScope,
} from '@mcp/shared/types.js'
import type { AgentProviderKind } from '@shared/types/providerKind.js'

type SessionRegistration = {
  token: string
  scope: McpSessionScope
  revoked: boolean
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
  appRunJournal?: AppRunJournal
  workflowService?: WorkflowService
  workflowBridge?: WorkflowBridge
}

const MCP_REQUEST_SLOW_MS = 1000
const MCP_ACTIVE_WARN_THRESHOLD = 20

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
  private activeRequests = 0
  private activeStandaloneGetStreams = 0
  private requestPressureOpen = false
  // Journal injected via setJournal() BEFORE start(), separately from
  // setDependencies() (which carries `manager` and therefore can only run after
  // start()). Without this split, a bind-failure incident would be dead code.
  private journal: AppRunJournal | null = null

  constructor(private readonly createServerForScope: BuiltInMcpServerFactory = createBuiltInMcpServer) {}

  setJournal(journal: AppRunJournal): void {
    this.journal = journal
  }

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
        // The built-in MCP host is how providers reach app services; if it can't
        // bind, orchestration/tools are dead for the whole run — a fatal incident.
        this.journal?.recordIncident({
          kind: 'mcp.host_start_failed',
          severity: 'fatal',
          reason: 'server_error',
          error: err,
        })
        reject(err)
      }
      const onListening = () => {
        this.server?.off('error', onError)
        const address = this.server?.address()
        if (!address || typeof address === 'string') {
          const err = new Error('Built-in MCP host did not bind to a TCP port')
          this.journal?.recordIncident({
            kind: 'mcp.host_start_failed',
            severity: 'fatal',
            reason: 'invalid_bind_address',
            error: err,
          })
          reject(err)
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
    for (const registration of this.registrations.values()) registration.revoked = true
    this.registrations.clear()
    this.tokensBySession.clear()
    if (!server) return
    // Force-drop any open sockets — notably the long-lived GET notification
    // streams agents keep open for the whole session. Without this, a plain
    // server.close() waits for those streams to end on their own and shutdown
    // hangs. Each request owns its own scoped server/transport now (see
    // handleRequest), so there is no per-session server object left to tear
    // down here; closing the sockets is sufficient.
    server.closeAllConnections?.()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }

  registerSession(scope: {
    sessionId: string
    cwd: string
    providerKind: AgentProviderKind
    domains: readonly BuiltInMcpDomain[] | undefined
  }): BuiltInMcpServerConfig[] {
    // WHY provider filtering is repeated at this main-owned boundary even
    // though the renderer resolves the same policy: session metadata and IPC
    // payloads are inputs, not authority. In particular, stale persisted data
    // must never inject Agent Code's emulated Workflow MCP into Claude, whose
    // native workflow feature is the sole workflow control plane.
    const domains = filterBuiltInMcpDomainsForProvider(
      scope.providerKind,
      scope.domains,
    ).filter(domain => {
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
    if (domains.length === 0) {
      // A recovery can reuse a renderer session id after its old provider
      // process died. If policy narrowing removes every requested domain,
      // revoke any token left under that id rather than letting the stale
      // registration outlive the now-capability-free replacement.
      this.revokeSession(scope.sessionId)
      return []
    }
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
    // The registration intentionally holds NO McpServer instance. A scoped
    // server is built per HTTP request in handleRequest instead. See the long
    // comment there for why caching one server per session caused a deadlock.
    this.registrations.set(token, {
      token,
      scope: mcpScope,
      revoked: false,
    })
    this.tokensBySession.set(scope.sessionId, token)

    return [this.serverConfig(token)]
  }

  sessionServers(sessionId: string): BuiltInMcpServerConfig[] {
    const token = this.tokensBySession.get(sessionId)
    const registration = token === undefined ? undefined : this.registrations.get(token)
    if (!token || !registration || registration.revoked) return []

    // Workflow subagents are separate Codex processes, but Claude's Workflow contract says they
    // inherit every MCP server connected to the parent session. Returning the same scoped token
    // gives them the exact parent tool set without minting a second registration that could outlive
    // or accidentally broaden that session. Callers receive fresh objects so SDK configuration
    // assembly cannot mutate the host's authorization state.
    const config = this.serverConfig(token)
    return [{ ...config, headers: { ...config.headers } }]
  }

  revokeSession(sessionId: string): void {
    const token = this.tokensBySession.get(sessionId)
    if (!token) return
    this.tokensBySession.delete(sessionId)
    const registration = this.registrations.get(token)
    this.registrations.delete(token)
    // Mark the captured object revoked too: an in-flight request already past
    // registrationForRequest holds a reference, and its long-lived GET stream
    // ends when the agent's socket closes on exit. There is no cached server to
    // tear down — each request owns and closes its own scoped server.
    if (registration) registration.revoked = true
  }

  private serverConfig(token: string): BuiltInMcpServerConfig {
    if (this.port === null) throw new Error('Built-in MCP host is not running')
    return {
      name: 'agent_code',
      // WHY the scoped credential is a separate field: provider launchers have different secure
      // injection mechanisms (Codex environment-backed headers and Claude a private config file).
      // Embedding it in the URL or generic header map inevitably copied it into argv, where local
      // process inspection and crash reports could retain it for the whole session lifetime.
      url: `http://127.0.0.1:${this.port}/mcp`,
      bearerToken: token,
      headers: {},
    }
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const startedAt = performance.now()
    if (!req.url) {
      this.writeJson(res, 400, { error: 'missing_url' })
      return
    }
    const url = new URL(req.url, 'http://127.0.0.1')
    if (url.pathname !== '/mcp') {
      this.writeJson(res, 404, { error: 'not_found' })
      return
    }

    if (!this.isAllowedOrigin(req)) {
      this.writeJson(res, 403, { error: 'forbidden_origin' })
      return
    }

    const registration = this.registrationForRequest(req, url)
    if (!registration) {
      this.writeJson(res, 401, { error: 'unauthorized' })
      return
    }

    if (req.method === 'GET') {
      await this.handleStandaloneGetStream(req, res, registration, startedAt)
      return
    }

    this.activeRequests += 1
    if (this.activeRequests >= MCP_ACTIVE_WARN_THRESHOLD && !this.requestPressureOpen) {
      this.requestPressureOpen = true
      performanceService.record({
        kind: 'metric',
        process: 'main',
        area: 'mcp.host',
        name: 'mcp.host.request_pressure',
        metricType: 'gauge',
        value: this.activeRequests,
        data: {
          activeRequests: this.activeRequests,
          activeStandaloneGetStreams: this.activeStandaloneGetStreams,
        },
      })
    }

    // WHY a fresh scoped server + transport PER REQUEST, and explicitly NOT a
    // cached per-session server behind a serialization queue:
    //
    // MCP Streamable HTTP clients (both Claude Code and Codex) open a
    // long-lived GET SSE "notification stream" right after initialize and keep
    // it open for the whole session. Its `transport.handleRequest` never
    // resolves by design. An earlier optimization cached one McpServer per
    // session and funnelled every HTTP request through a single per-session
    // promise queue — needed because the SDK stores the active transport on the
    // server and throws "Already connected to a transport" on a second concurrent
    // connect. But that queue made the never-resolving GET stream block every
    // subsequent request: tools/list and tools/call hung until the client gave
    // up (JSON-RPC -32001 timeout), which silently killed the whole bridge.
    //
    // Building a scoped server per request keeps each HTTP exchange fully
    // independent: the standing GET can stay open without wedging discovery or
    // tool calls, and each server connects to exactly one transport so the
    // "Already connected" race can't happen. Rebuilding the Zod tool graph per
    // request is cheap relative to a dead bridge. (Verified end-to-end against
    // the MCP SDK client: cached+queue => listTools times out; per-request =>
    // listTools returns.)
    const server = this.createServerForScope(registration.scope, this.dependencies)
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    })
    try {
      await server.connect(transport)
      await transport.handleRequest(req, res)
    } catch (err) {
      if (!res.headersSent) {
        const message = err instanceof Error ? err.message : String(err)
        this.writeJson(res, 500, { error: 'mcp_request_failed', message })
      }
    } finally {
      await transport.close().catch(() => undefined)
      await server.close().catch(() => undefined)
      this.activeRequests -= 1
      if (this.activeRequests < MCP_ACTIVE_WARN_THRESHOLD / 2) {
        this.requestPressureOpen = false
      }
      this.recordRequestTiming({
        method: req.method ?? 'UNKNOWN',
        scope: registration.scope,
        startedAt,
        lightweightGet: false,
      })
    }
  }

  private async handleStandaloneGetStream(
    req: IncomingMessage,
    res: ServerResponse,
    registration: SessionRegistration,
    startedAt: number,
  ): Promise<void> {
    // WHY GET is handled without createBuiltInMcpServer():
    //
    // Streamable HTTP clients commonly open a long-lived GET SSE stream for
    // server-initiated notifications. Agent Code's built-in MCP tools do not
    // send server notifications, resource updates, progress, or elicitation
    // requests today; every useful result is returned on the POST request's own
    // response stream. The old per-request workaround still built the complete
    // McpServer + Zod tool graph for these idle GET streams, then kept that
    // object graph alive for the lifetime of every agent. With 20 orchestrated
    // agents this multiplied the heaviest part of the MCP bridge by a channel
    // we do not use.
    //
    // A bare stateless StreamableHTTPServerTransport can satisfy the GET stream
    // contract by holding an SSE connection open. Because no `server.connect()`
    // happens, no tool handlers exist on this connection and nothing can be
    // invoked through it; POST requests still build a scoped server per exchange
    // below, preserving the earlier fix for "long-lived GET wedged tools/list".
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    })
    this.activeStandaloneGetStreams += 1
    try {
      await transport.handleRequest(req, res)
    } catch (err) {
      if (!res.headersSent) {
        const message = err instanceof Error ? err.message : String(err)
        this.writeJson(res, 500, { error: 'mcp_get_stream_failed', message })
      }
    } finally {
      await transport.close().catch(() => undefined)
      this.activeStandaloneGetStreams -= 1
      this.recordRequestTiming({
        method: 'GET',
        scope: registration.scope,
        startedAt,
        lightweightGet: true,
      })
    }
  }

  private recordRequestTiming(params: {
    method: string
    scope: McpSessionScope
    startedAt: number
    lightweightGet: boolean
  }): void {
    const durationMs = performance.now() - params.startedAt
    if (durationMs < MCP_REQUEST_SLOW_MS) return
    performanceService.record({
      kind: 'span_end',
      process: 'main',
      area: 'mcp.host',
      name: 'mcp.host.request',
      durationMs,
      sessionId: params.scope.sessionId,
      count: params.scope.domains.length,
      data: {
        method: params.method,
        domains: params.scope.domains,
        lightweightGet: params.lightweightGet,
        activeRequests: this.activeRequests,
        activeStandaloneGetStreams: this.activeStandaloneGetStreams,
      },
    })
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

  private isAllowedOrigin(req: IncomingMessage): boolean {
    const origin = req.headers.origin
    // WHY an absent Origin is accepted: Claude and Codex are native MCP
    // clients, not browser pages, and native HTTP stacks normally omit this
    // header. Requiring it would lock out the exact trusted clients this host
    // exists for. When a browser DOES send Origin, accepting only this
    // process's loopback endpoint prevents a hostile web page from using DNS
    // rebinding to drive a credentialed local MCP server.
    if (origin === undefined) return true
    if (typeof origin !== 'string' || this.port === null) return false

    try {
      const parsed = new URL(origin)
      if (parsed.protocol !== 'http:') return false
      if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
        return false
      }
      const isLoopback =
        parsed.hostname === '127.0.0.1' ||
        parsed.hostname === 'localhost' ||
        parsed.hostname === '[::1]'
      return isLoopback && parsed.port === String(this.port)
    } catch {
      return false
    }
  }

  private writeJson(res: ServerResponse, statusCode: number, payload: unknown): void {
    res.statusCode = statusCode
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(payload))
  }
}
