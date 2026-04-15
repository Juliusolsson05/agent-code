import { EventEmitter } from 'events'
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'http'
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
// WHY we accept /v1/responses AND /v1/models AND ws upgrades:
//   Observed on the wire (see scripts/proxy-harness.mts run):
//     - Codex tries a WebSocket upgrade at /v1/responses FIRST
//       with `openai-beta: responses_websockets=2026-02-06`. When
//       the 404 comes back it falls through to SSE POST. We reject
//       the upgrade gracefully so the fallback triggers fast.
//     - After the first turn, Codex issues GET /v1/models?client_version=...
//       for its model-list refresh. If we 404 it, codex logs a
//       non-fatal ERROR to stderr. Forwarding it upstream is the
//       quiet path.
//   Everything else returns 404 so misconfigured clients don't
//   silently succeed via some path we didn't mean to support.

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
  // Fetch timeout for a single upstream request. SSE streams can
  // stay open for a long time, so the timeout only guards the
  // HEADERS phase (via AbortController + clear on first chunk).
  private readonly upstreamHeadersTimeoutMs = 30_000

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

    // Responses API — the hot path. Accept both `/v1/responses` (our
    // default proxyBaseUrl includes /v1) and `/responses` (if a
    // consumer ever overrides to a base without /v1). Codex always
    // appends `responses` to whatever base_url it's told, so both
    // shapes appear in practice depending on the override.
    if (method === 'POST' && (pathOnly === '/v1/responses' || pathOnly === '/responses')) {
      await this.forwardResponses(req, res, url)
      return
    }

    // Models refresh. Codex hits this after the first turn; if we
    // 404 it codex logs a scary ERROR. Forward with the original
    // query string so upstream sees client_version=…
    if (method === 'GET' && pathOnly === '/v1/models') {
      await this.forwardModels(req, res, url)
      return
    }

    res.statusCode = 404
    res.setHeader('content-type', 'text/plain; charset=utf-8')
    res.end(`codex-responses-proxy: unsupported ${method} ${pathOnly}\n`)
    this.emit('event', { kind: 'rejected', method, path: pathOnly })
  }

  private async forwardResponses(
    req: IncomingMessage,
    res: ServerResponse,
    originalUrl: string,
  ): Promise<void> {
    const body = await this.readBody(req)

    // Upstream URL: <upstream>/responses. Normalize the base so we
    // don't double-slash or accidentally strip a trailing path
    // segment with `new URL(relative, base)`.
    const upstream = this.resolveUpstreamPath('responses', originalUrl)

    const headers = this.buildForwardedHeaders(req)

    this.emit('event', {
      kind: 'request',
      method: 'POST',
      path: originalUrl,
      upstream,
      bytes: body.length,
    })

    const abort = new AbortController()
    const headersTimer = setTimeout(() => abort.abort(), this.upstreamHeadersTimeoutMs)

    try {
      const upstreamRes = await fetch(upstream, {
        method: 'POST',
        headers,
        // Node's undici runtime accepts Buffer/Uint8Array fine, but
        // the BodyInit typing is from DOM lib and too narrow. Cast
        // with one comment: `body` is always a raw Buffer read from
        // the inbound request.
        body: body as unknown as BodyInit,
        signal: abort.signal,
      })
      // Headers received — stop the abort timer. The body may still
      // stream for minutes (long SSE turns), which is fine.
      clearTimeout(headersTimer)

      await this.streamUpstreamResponse(req, res, upstreamRes, originalUrl)
    } catch (err) {
      clearTimeout(headersTimer)
      this.emit('event', {
        kind: 'upstream-error',
        path: originalUrl,
        message: err instanceof Error ? err.message : String(err),
      })
      res.statusCode = 502
      res.setHeader('content-type', 'text/plain; charset=utf-8')
      res.end(err instanceof Error ? err.message : String(err))
    }
  }

  private async forwardModels(
    req: IncomingMessage,
    res: ServerResponse,
    originalUrl: string,
  ): Promise<void> {
    // Preserve the query string so upstream sees client_version.
    const upstream = this.resolveUpstreamPath('models', originalUrl)
    const headers = this.buildForwardedHeaders(req)

    this.emit('event', {
      kind: 'request',
      method: 'GET',
      path: originalUrl,
      upstream,
    })

    const abort = new AbortController()
    const headersTimer = setTimeout(() => abort.abort(), this.upstreamHeadersTimeoutMs)
    try {
      const upstreamRes = await fetch(upstream, {
        method: 'GET',
        headers,
        signal: abort.signal,
      })
      clearTimeout(headersTimer)
      await this.streamUpstreamResponse(req, res, upstreamRes, originalUrl)
    } catch (err) {
      clearTimeout(headersTimer)
      this.emit('event', {
        kind: 'upstream-error',
        path: originalUrl,
        message: err instanceof Error ? err.message : String(err),
      })
      res.statusCode = 502
      res.end()
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
        path: originalUrl,
        bytes: bytesEstimate,
      })
    })
    nodeStream.on('error', err => {
      this.emit('event', {
        kind: 'response-error',
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
}
