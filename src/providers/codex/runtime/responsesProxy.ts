import { EventEmitter } from 'events'
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'http'
import type { Socket } from 'net'
import { Readable } from 'stream'
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

// Local HTTP proxy for Codex's Responses API.
//
// WHY a proxy at all:
//   Codex sends its assistant turns over `POST {base_url}/responses`
//   as SSE. cc-shell wants to observe that wire so the renderer can
//   build a semantic live-turn without screen-scraping. Inserting a
//   local HTTP server between Codex and the real upstream gives us
//   decrypted events with zero CA-injection gymnastics (unlike the
//   Claude/mitmproxy path — OpenAI/ChatGPT natively support custom
//   `openai_base_url`, so we just redirect via a plain HTTP listener
//   on 127.0.0.1).
//
// WHY we detect auth_mode:
//   Codex has two auth paths that resolve DIFFERENT default upstream
//   URLs:
//     - apikey mode  → https://api.openai.com/v1
//     - chatgpt mode → https://chatgpt.com/backend-api/codex
//   The `openai_base_url` config override replaces the URL on the
//   built-in `openai` provider REGARDLESS of auth mode (see
//   codex-rs/model-provider-info/src/lib.rs:184-193), which means
//   the SAME proxy URL is injected for both. But WE still need to
//   know which real upstream to forward to, or ChatGPT-mode users
//   send their chatgpt.com JWT to api.openai.com and get 401.
//   Detection reads ~/.codex/auth.json at proxy-create time; if
//   that file is absent, we fall back to apikey mode (because an
//   explicit OPENAI_API_KEY env var can't authenticate against
//   chatgpt.com).
//
// WHY we transparently forward anything under /v1/:
//   Codex uses more provider endpoints than just /responses + /models.
//   Confirmed from upstream source (codex-rs/codex-api/src/endpoint/*
//   and codex-rs/core/src/client.rs — relative paths like `responses`,
//   `responses/compact`, `memories/trace_summarize`, `realtime/calls`,
//   `models` — all joined against the SAME base URL we inject via the
//   `openai_base_url` override). The earlier allowlist that only
//   handled /responses + /models silently broke remote compaction
//   (issues.md #23: "unexpected status 404: unsupported POST
//   /v1/responses/compact"), memory summarization, and realtime calls.
//
//   Strictness vs transparency:
//     The upstream Rust `responses-api-proxy` is intentionally strict
//     (POST /v1/responses only) because it runs as root with an
//     injected $OPENAI_API_KEY — the allowlist prevents unprivileged
//     misuse. OUR proxy is different: we don't inject auth, we pass
//     Codex's own Authorization header through untouched. The reason
//     we exist is observation, not key protection. So the strict
//     model is wrong for us — a transparent forward under /v1/ keeps
//     Codex working through CLI updates and feature additions without
//     us chasing each new endpoint.
//
//   Known endpoints are still tagged in debug events (kind: 'request'
//   carries `endpoint: 'responses/compact'` etc.) so the proxy debug
//   panel can surface them. Unknown /v1/ paths are forwarded and
//   tagged `endpoint: 'unknown'` so we notice if Codex adds something
//   new without having to dig through a 404 postmortem.
//
//   WebSocket upgrade handling is unchanged: Codex tries a WS upgrade
//   at /v1/responses first (`openai-beta: responses_websockets=
//   2026-02-06`), and we reject it so Codex falls back to SSE POST.
//   We don't proxy WS; doing so would add complexity with no renderer
//   upside.

export type CodexResponsesProxyEvents = {
  event: [Record<string, unknown>]
}

export interface CodexResponsesProxy {
  on<K extends keyof CodexResponsesProxyEvents>(
    event: K,
    listener: (...args: CodexResponsesProxyEvents[K]) => void,
  ): this
  off<K extends keyof CodexResponsesProxyEvents>(
    event: K,
    listener: (...args: CodexResponsesProxyEvents[K]) => void,
  ): this
  emit<K extends keyof CodexResponsesProxyEvents>(
    event: K,
    ...args: CodexResponsesProxyEvents[K]
  ): boolean
}

export type CodexAuthMode = 'apikey' | 'chatgpt'

export type CodexResponsesProxyInfo = {
  proxyBaseUrl: string
  upstreamBaseUrl: string
  authMode: CodexAuthMode
}

type Options = {
  upstreamBaseUrl?: string
  authMode?: CodexAuthMode
}

// Detect which auth path Codex is configured for. Cheap enough to
// run per-session — the alternative is to accept it as an option
// from callers, but the single source of truth is ~/.codex/auth.json
// so making it the proxy's job keeps callers simpler.
function detectAuthMode(): CodexAuthMode {
  const authPath = join(homedir(), '.codex', 'auth.json')
  try {
    const raw = readFileSync(authPath, 'utf-8')
    const parsed = JSON.parse(raw) as { auth_mode?: string }
    if (parsed.auth_mode === 'chatgpt') return 'chatgpt'
    if (parsed.auth_mode === 'apikey') return 'apikey'
  } catch {
    /* file missing / unreadable — fall through */
  }
  // No auth.json: if OPENAI_API_KEY is set we can only be useful
  // against api.openai.com.
  return 'apikey'
}

function defaultUpstreamFor(authMode: CodexAuthMode): string {
  return authMode === 'chatgpt'
    ? 'https://chatgpt.com/backend-api/codex'
    : 'https://api.openai.com/v1'
}

export class ResponsesProxy extends EventEmitter {
  private server: Server | null = null
  readonly info: CodexResponsesProxyInfo
  // Header timeout for the hot SSE `/responses` path. We still want a
  // relatively tight guard here because a live turn normally starts
  // streaming quickly, and a dead upstream should fail fast.
  private readonly streamingHeadersTimeoutMs = 30_000
  // Unary JSON endpoints like `/responses/compact` do not stream and
  // can legitimately take much longer before sending response headers.
  // Using the SSE timeout here turns slow-but-valid compaction into a
  // synthetic local 502 ("This operation was aborted").
  private readonly unaryHeadersTimeoutMs = 5 * 60_000
  // Track every open inbound socket so stop() can force them closed.
  // WHY: node's http.Server#close waits for all connections to finish
  // before it resolves. A long-running SSE turn holds its socket open
  // for minutes — without forcing them closed, stop() stalls session
  // teardown and the app feels frozen on quit/kill. Node 18.2+ has
  // `server.closeAllConnections()` which would do this for us; we
  // belt-and-suspenders with our own Set so this keeps working if a
  // future refactor wraps the server or hosts it elsewhere.
  private readonly openSockets = new Set<Socket>()
  // Per-request id counter. Used to tag every request/response/chunk/end/error
  // event with a stable requestId so downstream consumers (the
  // CodexResponsesAdapter in particular) can route chunks to their
  // originating request even when two requests to the same path overlap
  // — e.g. codex retrying a Responses call while the first one is still
  // streaming. Path-based routing was the old approach and silently
  // merged retries' bytes into the later request's flow state. Opaque
  // monotonic id avoids that and is cheap.
  private nextRequestSeq = 1

  constructor(info: CodexResponsesProxyInfo) {
    super()
    this.info = info
  }

  static async create(options: Options = {}): Promise<ResponsesProxy> {
    const authMode = options.authMode ?? detectAuthMode()
    const upstreamBaseUrl = options.upstreamBaseUrl ?? defaultUpstreamFor(authMode)
    const server = createServer()
    const proxy = new ResponsesProxy({
      // Populated after listen() resolves. Kept syntactically valid
      // so callers that accidentally read it early don't crash.
      proxyBaseUrl: 'http://127.0.0.1:0/v1',
      upstreamBaseUrl,
      authMode,
    })
    proxy.server = server
    server.on('connection', socket => {
      // Record the socket for forced teardown in stop(). `once('close')`
      // removes it on its own if the client/upstream tears down first,
      // so the Set stays bounded to live sockets only.
      proxy.openSockets.add(socket)
      socket.once('close', () => proxy.openSockets.delete(socket))
    })
    server.on('request', (req, res) => {
      void proxy.handle(req, res)
    })
    // Handle WS upgrade attempts by destroying the socket — codex
    // treats any non-101 response as "fall back to SSE POST", which
    // is what we want. Letting the client hang is worse than an
    // explicit reject.
    server.on('upgrade', (_req, socket) => {
      proxy.emit('event', { kind: 'upgrade-rejected', path: _req.url })
      try {
        socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
      } catch { /* socket already gone */ }
      try { socket.destroy() } catch { /* already gone */ }
    })
    // Forward server errors as events. Unlike EventEmitter's default
    // 'error' semantics (synchronous throw if unhandled), we have a
    // listener here AND re-expose via our own channel so callers can
    // observe without risking a crash.
    server.on('error', err => {
      proxy.emit('event', { kind: 'server-error', message: String(err) })
    })
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        server.off('error', onError)
        reject(err)
      }
      server.once('error', onError)
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (!address || typeof address === 'string') {
          reject(new Error('Unable to determine Codex proxy bind address'))
          return
        }
        proxy.info.proxyBaseUrl = `http://127.0.0.1:${address.port}/v1`
        server.off('error', onError)
        resolve()
      })
    })
    return proxy
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    if (!server) return
    // Rip the rug out from under every in-flight request BEFORE awaiting
    // close(). Without this step, a live SSE turn keeps its socket open
    // for as long as upstream keeps streaming (can be minutes), and
    // server.close() waits until every such socket is idle — so stop()
    // blocks session teardown indefinitely. Destroying sockets causes
    // the upstream pipe to error, propagates through the 'response-error'
    // path, and close() resolves immediately.
    for (const socket of this.openSockets) {
      try { socket.destroy() } catch { /* already gone */ }
    }
    this.openSockets.clear()
    // Additionally call closeAllConnections() when available (Node
    // 18.2+). Belt-and-braces for any socket we somehow missed tracking
    // (e.g. a keep-alive socket delivered before our 'connection'
    // handler ran — vanishingly rare but cheap to guard).
    const maybeCloseAll = (server as Server & {
      closeAllConnections?: () => void
    }).closeAllConnections
    if (typeof maybeCloseAll === 'function') {
      try { maybeCloseAll.call(server) } catch { /* ignore */ }
    }
    await new Promise<void>((resolve, reject) => {
      server.close(err => {
        if (err) reject(err)
        else resolve()
      })
    })
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET'
    const url = req.url ?? '/'

    // Strip query string for path matching (models call includes ?client_version=…).
    const pathOnly = url.split('?', 1)[0] ?? url

    // Relative path against the real upstream base. We advertise
    // `http://127.0.0.1:PORT/v1` as the proxy base, so Codex requests
    // always arrive with a `/v1/` prefix. Strip that prefix before
    // joining against the upstream base — `new URL(relative, base)`
    // then does the right thing whether the upstream carries `/v1`
    // (apikey mode → https://api.openai.com/v1) or not (chatgpt mode
    // → https://chatgpt.com/backend-api/codex).
    //
    // We still accept bare `/responses`, `/models` shapes because a
    // consumer could theoretically override to a base without `/v1`.
    // That path was intentional in the old allowlist and is cheap to
    // preserve here.
    const relative = relativeUpstreamPath(pathOnly)
    if (!relative) {
      res.statusCode = 404
      res.setHeader('content-type', 'text/plain; charset=utf-8')
      res.end(`codex-responses-proxy: unsupported ${method} ${pathOnly}\n`)
      this.emit('event', { kind: 'rejected', method, path: pathOnly })
      return
    }

    await this.forwardRequest(req, res, {
      method,
      originalUrl: url,
      pathOnly,
      relative,
    })
  }

  /**
   * Generic forwarder: read body (for methods that have one), forward
   * to the upstream at `{upstreamBase}/{relative}{?query}`, stream the
   * response back. Works for both SSE (`/responses`) and unary JSON
   * (`/responses/compact`, `/memories/trace_summarize`, `/models`)
   * because `Readable.fromWeb(upstreamRes.body).pipe(res)` preserves
   * the upstream content-type — piping bytes is format-agnostic.
   *
   * WHY we tag a `kind` on known endpoints:
   *   The debug panel needs to surface "this was a compact call" vs
   *   "this was the hot responses stream" without re-parsing the URL.
   *   Unknown /v1/ paths get `endpoint: 'unknown'` so we notice new
   *   Codex endpoints before they cause a 404 postmortem.
   */
  private async forwardRequest(
    req: IncomingMessage,
    res: ServerResponse,
    params: {
      method: string
      originalUrl: string
      pathOnly: string
      relative: string
    },
  ): Promise<void> {
    const { method, originalUrl, pathOnly, relative } = params
    const requestId = `req-${this.nextRequestSeq++}`
    const endpoint = classifyEndpoint(pathOnly)

    // Read the request body for methods that have one. GET/HEAD never
    // carry a body; POST/PUT/PATCH/DELETE might. We read unconditionally
    // for non-GET/HEAD because the upstream Codex uses POST for every
    // non-model endpoint today and letting the buffer complete keeps
    // the streaming forward logic simple.
    const hasBody = method !== 'GET' && method !== 'HEAD'
    let body: Buffer | undefined
    if (hasBody) {
      try {
        body = await this.readBody(req)
      } catch (err) {
        // readBody rejects if the client disconnects mid-upload (rare
        // but possible on fast Ctrl-C). Emit a tagged event so the
        // disconnect is visible — observability loss is the real
        // damage here, since the client already went away.
        this.emit('event', {
          kind: 'request-error',
          requestId,
          endpoint,
          path: originalUrl,
          message: err instanceof Error ? err.message : String(err),
        })
        try {
          res.statusCode = 400
          res.end()
        } catch { /* client already gone */ }
        return
      }
    }

    const upstream = this.resolveUpstreamPath(relative, originalUrl)
    const headers = this.buildForwardedHeaders(req)
    const headersTimeoutMs = this.headersTimeoutMsFor(endpoint)

    this.emit('event', {
      kind: 'request',
      requestId,
      endpoint,
      method,
      path: originalUrl,
      upstream,
      bytes: body?.length,
    })

    const abort = new AbortController()
    const headersTimer = setTimeout(() => {
      abort.abort(new Error(
        `upstream headers timeout after ${headersTimeoutMs}ms for ${endpoint}`,
      ))
    }, headersTimeoutMs)
    const onClientGone = (): void => {
      // If the local client has already disconnected there is no point
      // in finishing the upstream fetch, and surfacing a synthetic 502
      // back to a dead socket only muddies the real failure mode.
      if (req.destroyed || res.destroyed) {
        abort.abort(new Error(`downstream client disconnected during ${endpoint}`))
      }
    }
    req.once('aborted', onClientGone)
    res.once('close', onClientGone)

    try {
      const upstreamRes = await fetch(upstream, {
        method,
        headers,
        // Node's undici runtime accepts Buffer/Uint8Array fine, but
        // the BodyInit typing is from DOM lib and too narrow. Cast
        // with one comment: `body` is always a raw Buffer read from
        // the inbound request (absent for GET/HEAD).
        body: body ? (body as unknown as BodyInit) : undefined,
        signal: abort.signal,
      })
      // Headers received — stop the abort timer. The body may still
      // stream for minutes (long SSE turns), which is fine.
      clearTimeout(headersTimer)
      req.off('aborted', onClientGone)
      res.off('close', onClientGone)

      await this.streamUpstreamResponse(req, res, upstreamRes, originalUrl, requestId)
    } catch (err) {
      clearTimeout(headersTimer)
      req.off('aborted', onClientGone)
      res.off('close', onClientGone)
      this.emit('event', {
        kind: 'upstream-error',
        requestId,
        endpoint,
        path: originalUrl,
        message: err instanceof Error ? err.message : String(err),
      })
      if (req.destroyed || res.destroyed) {
        return
      }
      res.statusCode = 502
      res.setHeader('content-type', 'text/plain; charset=utf-8')
      res.end(err instanceof Error ? err.message : String(err))
    }
  }

  private resolveUpstreamPath(relative: string, originalUrl: string): string {
    // Preserve query string from the original request.
    const qIndex = originalUrl.indexOf('?')
    const query = qIndex >= 0 ? originalUrl.slice(qIndex) : ''
    const base = this.info.upstreamBaseUrl.endsWith('/')
      ? this.info.upstreamBaseUrl
      : `${this.info.upstreamBaseUrl}/`
    return `${new URL(relative, base).toString()}${query}`
  }

  private buildForwardedHeaders(req: IncomingMessage): Headers {
    const headers = new Headers()
    for (const [key, value] of Object.entries(req.headers)) {
      if (value == null) continue
      const lower = key.toLowerCase()
      // Hop-by-hop headers we must not forward. Codex sends the
      // request body compressed with zstd sometimes (content-encoding:
      // zstd) — we KEEP that; upstream handles it.
      if (
        lower === 'host' ||
        lower === 'content-length' ||
        lower === 'connection' ||
        lower === 'transfer-encoding' ||
        lower === 'upgrade' ||
        lower === 'proxy-connection'
      ) {
        continue
      }
      if (Array.isArray(value)) {
        for (const part of value) headers.append(key, part)
      } else {
        headers.set(key, value)
      }
    }
    return headers
  }

  private async streamUpstreamResponse(
    _req: IncomingMessage,
    res: ServerResponse,
    upstreamRes: Response,
    originalUrl: string,
    requestId: string,
  ): Promise<void> {
    res.statusCode = upstreamRes.status
    upstreamRes.headers.forEach((value, key) => {
      // Hop-by-hop and length headers tiny_http-style: let node
      // recompute framing.
      const lower = key.toLowerCase()
      if (
        lower === 'content-length' ||
        lower === 'transfer-encoding' ||
        lower === 'connection' ||
        lower === 'trailer' ||
        lower === 'upgrade'
      ) {
        return
      }
      res.setHeader(key, value)
    })

    this.emit('event', {
      kind: 'response',
      requestId,
      path: originalUrl,
      status: upstreamRes.status,
    })

    if (!upstreamRes.body) {
      res.end()
      return
    }

    const nodeStream = Readable.fromWeb(upstreamRes.body as never)
    let bytesEstimate = 0
    nodeStream.on('data', chunk => {
      const size = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk))
      bytesEstimate += size
      this.emit('event', {
        kind: 'response-chunk',
        requestId,
        path: originalUrl,
        size,
        // The raw SSE / JSON bytes. Consumers that want structured
        // semantic events should layer a parser on top.
        chunk: Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)),
      })
    })
    nodeStream.on('end', () => {
      this.emit('event', {
        kind: 'response-end',
        requestId,
        path: originalUrl,
        bytes: bytesEstimate,
      })
    })
    nodeStream.on('error', err => {
      this.emit('event', {
        kind: 'response-error',
        requestId,
        path: originalUrl,
        message: err instanceof Error ? err.message : String(err),
      })
      try { res.destroy() } catch { /* best-effort */ }
    })
    nodeStream.pipe(res)
  }

  private readBody(req: IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      req.on('data', chunk => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      })
      req.on('end', () => resolve(Buffer.concat(chunks)))
      req.on('error', reject)
    })
  }

  private headersTimeoutMsFor(endpoint: string): number {
    if (endpoint === 'responses') return this.streamingHeadersTimeoutMs
    return this.unaryHeadersTimeoutMs
  }
}

// ---------------------------------------------------------------------------
// Path classification helpers
// ---------------------------------------------------------------------------

/**
 * Translate an inbound proxy path into the relative path we should
 * append to the upstream base URL. Returns null for paths we refuse
 * to forward at all (root probes, /favicon, etc.).
 *
 * Examples:
 *   /v1/responses               → responses
 *   /v1/responses/compact       → responses/compact
 *   /v1/memories/trace_summarize→ memories/trace_summarize
 *   /v1/realtime/calls          → realtime/calls
 *   /v1/models                  → models
 *   /responses                  → responses   (no-/v1 base override)
 *   /                           → null        (not a Codex API path)
 */
function relativeUpstreamPath(pathOnly: string): string | null {
  if (!pathOnly || pathOnly === '/' || pathOnly === '/v1' || pathOnly === '/v1/') {
    return null
  }
  // Prefer /v1/ stripping when present — our advertised proxy base
  // always includes /v1, so Codex requests carry it.
  if (pathOnly.startsWith('/v1/')) {
    const relative = pathOnly.slice(4)
    return relative.length > 0 ? relative : null
  }
  // Fallback for bare shapes (consumer overrode base without /v1).
  if (pathOnly.startsWith('/')) {
    const relative = pathOnly.slice(1)
    return relative.length > 0 ? relative : null
  }
  return null
}

/**
 * Tag known Codex endpoints for structured debug events. Pure string
 * matching — kept in sync with codex-rs/codex-api/src/endpoint/* by
 * source, not by wire-probing, so adding an entry here when Codex
 * introduces a new endpoint is a one-liner.
 *
 * `unknown` is the catch-all for /v1/ paths we still forward but
 * haven't explicitly labelled; it's a debug-panel hint, not a reject.
 */
function classifyEndpoint(pathOnly: string): string {
  if (pathOnly.endsWith('/responses/compact')) return 'responses/compact'
  if (pathOnly.endsWith('/responses')) return 'responses'
  if (pathOnly.endsWith('/memories/trace_summarize')) return 'memories/trace_summarize'
  if (pathOnly.endsWith('/realtime/calls')) return 'realtime/calls'
  if (pathOnly.endsWith('/models')) return 'models'
  return 'unknown'
}
