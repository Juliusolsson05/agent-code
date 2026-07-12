import { EventEmitter } from 'node:events'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createReadStream, existsSync } from 'node:fs'
import { extname, join, normalize, sep } from 'node:path'
import type { Duplex } from 'node:stream'

import { WebSocketServer, type WebSocket } from 'ws'

import type { AppRunJournal } from '@main/incident/AppRunJournal.js'
import type { ResolveConditionResult } from '@shared/sessionFeed/types.js'
import type { ConditionCustomAction } from '@shared/conditions-core/contract.js'
import type { SessionKind } from '@shared/types/providerKind.js'

import { DevicePairing } from '@main/remote/auth/DevicePairing.js'
import type { DeviceRegistry } from '@main/remote/auth/deviceRegistry.js'
import { parseInboundFrame } from '@main/remote/protocol/scope.js'
import type { InboundFrame, OutboundFrame } from '@main/remote/protocol/messages.js'
import type { FeedChannel, SessionFeedSource } from '@main/remote/SessionFeedSource.js'
import {
  loadInitialHistoryChunkFromFile,
  loadOlderHistoryChunkFromFile,
} from '@main/sessions/historyLoader.js'
import type { RemoteTransport } from '@main/remote/transport/RemoteTransport.js'

// RemoteServer — the HTTP+WS host that makes Agent Code controllable from a
// phone. Modeled on BuiltInMcpHttpHost (same construct-in-index lifecycle,
// same optional-journal wiring), but OFF by default and started only from
// the desktop Remote panel.
//
// Responsibilities, and nothing else:
//   1. Serve the built remote-client bundle (or a placeholder when the
//      bundle isn't built — dev ergonomics over a hard failure).
//   2. POST /pair — redeem a one-time pairing code for a device token.
//   3. WS endpoint — token-checked at upgrade AND per message; outbound
//      fan-out of SessionFeedSource events; inbound apply of the v1
//      protocol (see protocol/messages.ts for why the schema IS the scope).
//
// THE SECURITY POSTURE lives in three layers, each of which must hold alone:
//   - possession: you cannot connect without a token minted via physical
//     QR pairing; upgrade rejects before the socket exists.
//   - per-message verification: a socket hijacked after upgrade still
//     carries no authority — every mutating frame re-verifies the token,
//     which re-checks registry revocation (the desktop kill switch).
//   - protocol shape: the inbound schema union cannot express shell exec,
//     session lifecycle, or raw input, so a fully-authenticated attacker is
//     still limited to prompting agents and answering their dialogs. The
//     one nuance is pty condition actions, whose bytes ARE keystrokes —
//     those apply ONLY when they exactly match an action the live condition
//     snapshot itself offered (see applyPermissionReply).

/**
 * The slice of SessionManager the remote subsystem consumes, stated
 * structurally so tests can drive a bare EventEmitter + spies and so this
 * file documents its true blast radius: the read-side seeds (list +
 * snapshot getters) and the four control methods, nothing else.
 */
export type RemoteSessionControl = {
  list(): string[]
  getScreenSnapshot(sessionId: string): unknown
  getConditionsSnapshot(sessionId: string): unknown
  resolveTranscriptFile(sessionId: string): Promise<string | null>
  getSpawnCwd(sessionId: string): string | null
  getLastActivityAt(sessionId: string): number | null
  write(sessionId: string, data: string): boolean
  resolveCondition(
    sessionId: string,
    action: ConditionCustomAction,
  ): Promise<ResolveConditionResult>
  deliverPromptToAgent(
    sessionId: string,
    prompt: string,
  ): Promise<{ ok: true } | { ok: false; message: string }>
  getSessionKind(sessionId: string): SessionKind | null
}

export type RemoteServerDeps = {
  manager: RemoteSessionControl
  feedSource: SessionFeedSource
  pairing: DevicePairing
  registry: DeviceRegistry
  transport: RemoteTransport
  /** Directory of the built remote-client bundle; null/absent serves a
   *  placeholder page so the server is testable before the client exists. */
  clientDistDir?: string | null
  getThemeSettings?: () => Record<string, unknown> | null
  journal?: AppRunJournal | null
  /**
   * Transcribe a phone-captured audio blob to composer-ready text. OPTIONAL:
   * absent (or a null-returning wire) makes POST /dictate answer 503 so the
   * phone hides its mic. Wired in RemoteController to the desktop's existing
   * Deepgram batch engine — the API key stays in the main process and never
   * crosses to the phone, which is the whole reason transcription is a server
   * dep and not something the client does itself. Returns { ok:false,
   * error:'no-key' } when DEEPGRAM_API_KEY is unset. Audio is
   * transcribe-and-discard: it is NEVER written to any debug/state root.
   */
  transcribeAudio?: (
    audio: Buffer,
    mimeType?: string,
  ) => Promise<{ ok: true; text: string } | { ok: false; error: string }>
  /**
   * Whether transcribeAudio would succeed if called RIGHT NOW (i.e. the STT
   * key is actually present). Needed separately from transcribeAudio's
   * existence because RemoteController always wires the function and only
   * discovers a missing DEEPGRAM_API_KEY inside the call — but the phone
   * needs the verdict at HELLO time to disable its mic up front, instead of
   * letting the user record and upload into a guaranteed 503 (review
   * finding). A function, not a boolean, so every new connection re-reads
   * the environment. Absent = assume available (transcribeAudio's presence
   * is then the only gate).
   */
  isSttAvailable?: () => boolean
}

const SUBMIT_BYTES = '\r'
const INTERRUPT_BYTES = '\x1b'

const PAIR_BODY_LIMIT_BYTES = 16 * 1024
// Generous but bounded: webm/opus voice is ~1 KB/s, so 8 MB is many minutes
// of dictation while still stopping a hostile peer from ballooning memory.
const DICTATE_BODY_LIMIT_BYTES = 8 * 1024 * 1024

const STATIC_CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
}

type ClientSocket = {
  ws: WebSocket
  deviceId: string
}

/** Events: 'clients-changed' — fired on every WS connect/disconnect so the
 *  desktop Remote panel can live-update its "N devices connected" line
 *  without polling. */
export class RemoteServer extends EventEmitter {
  private server: Server | null = null
  private wss: WebSocketServer | null = null
  private url: string | null = null
  private readonly sockets = new Set<ClientSocket>()
  private feedUnsub: (() => void) | null = null

  // Late-joiner bootstrap caches. A phone that connects while every agent is
  // idle would otherwise stare at blank panes until the next event happens
  // to fire; replaying the last screen/conditions/process-state per session
  // makes the client instantly correct. jsonl history is NOT cached here —
  // scrollback is a client-driven request problem for a later slice, and
  // caching transcript entries in the server would duplicate what providers
  // already persist on disk.
  private readonly lastScreen = new Map<string, unknown>()
  private readonly lastConditions = new Map<string, unknown>()
  private readonly lastProcessState = new Map<string, unknown>()

  constructor(private readonly deps: RemoteServerDeps) {
    super()
  }

  async start(): Promise<{ url: string }> {
    if (this.server && this.url) return { url: this.url }

    this.server = createServer((req, res) => {
      void this.handleHttp(req, res)
    })
    this.wss = new WebSocketServer({ noServer: true })
    this.server.on('upgrade', (req, socket, head) => {
      this.handleUpgrade(req, socket, head)
    })

    this.feedUnsub = this.deps.feedSource.onEvent((channel, payload) => {
      this.cacheForLateJoiners(channel, payload)
      this.broadcast({ type: 'session-event', channel, payload })
    })

    // Prime the late-joiner caches from the manager's own snapshot caches.
    // The feed tap only observes events AFTER enable; without this, an agent
    // blocked on a permission prompt raised BEFORE the user enabled remote
    // would never render its prompt on the phone (conditions only re-emit on
    // change), and idle sessions would be blank panes (idle TUIs redraw
    // nothing). Payload shapes mirror the live events exactly so clients
    // need no special bootstrap path.
    for (const session of this.deps.feedSource.listSessions()) {
      const screen = this.deps.manager.getScreenSnapshot(session.sessionId)
      if (screen && typeof screen === 'object') {
        this.lastScreen.set(session.sessionId, { sessionId: session.sessionId, ...screen })
      }
      const snapshot = this.deps.manager.getConditionsSnapshot(session.sessionId)
      if (snapshot) {
        this.lastConditions.set(session.sessionId, {
          sessionId: session.sessionId,
          snapshot,
        })
      }
    }

    try {
      const { url } = await this.deps.transport.start(this.server)
      this.url = url
      this.deps.journal?.record({
        area: 'remote.server',
        name: 'remote_server.started',
        data: { url },
      })
      return { url }
    } catch (err) {
      // Bind/tunnel failure: unwind the half-started state so a retry from
      // the Remote panel starts clean instead of stacking listeners.
      this.deps.journal?.recordIncident({
        kind: 'remote.server_start_failed',
        severity: 'error',
        error: err,
      })
      await this.stop()
      throw err
    }
  }

  async stop(): Promise<void> {
    this.feedUnsub?.()
    this.feedUnsub = null
    for (const client of this.sockets) {
      client.ws.close(1001, 'server stopping')
    }
    this.sockets.clear()
    this.wss?.close()
    this.wss = null
    await this.deps.transport.stop()
    this.server = null
    this.url = null
    this.lastScreen.clear()
    this.lastConditions.clear()
    this.lastProcessState.clear()
    this.deps.journal?.record({ area: 'remote.server', name: 'remote_server.stopped' })
  }

  getUrl(): string | null {
    return this.url
  }

  connectedDeviceIds(): string[] {
    return [...this.sockets].map(s => s.deviceId)
  }

  broadcastThemeSettings(): void {
    this.broadcast({
      type: 'theme-settings',
      themeSettings: this.deps.getThemeSettings?.() ?? null,
    })
  }

  // ---------- HTTP ----------

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (req.method === 'POST' && url.pathname === '/pair') {
      await this.handlePair(req, res)
      return
    }
    if (req.method === 'GET' && url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      return
    }
    if (req.method === 'POST' && url.pathname === '/dictate') {
      await this.handleDictate(req, res)
      return
    }
    if (req.method === 'GET') {
      this.serveClient(url.pathname, res)
      return
    }
    res.writeHead(405).end()
  }

  private async handlePair(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: string
    try {
      body = await readBodyCapped(req, PAIR_BODY_LIMIT_BYTES)
    } catch {
      // Overflow destroys the socket by design (unauthenticated endpoint —
      // see readBodyCapped); this catch just keeps the rejection from
      // escaping handleHttp's void'd promise as an unhandled rejection.
      return
    }
    let code = ''
    let deviceName = ''
    try {
      const parsed = JSON.parse(body) as { code?: unknown; deviceName?: unknown }
      code = typeof parsed.code === 'string' ? parsed.code : ''
      deviceName = typeof parsed.deviceName === 'string' ? parsed.deviceName : ''
    } catch {
      // fall through with empty fields → 400 below
    }
    if (!code) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'code required' }))
      return
    }

    const redeemed = await this.deps.pairing.redeemPairingCode(
      code,
      deviceName || 'Unnamed device',
    )
    if (!redeemed.ok) {
      // 403 for both invalid and expired: distinguishing them on the wire
      // would let an attacker probe which codes ever existed. The desktop
      // side (which issued the code) can tell the user why it failed.
      this.deps.journal?.record({
        area: 'remote.server',
        name: 'remote_pair.rejected',
        data: { reason: redeemed.reason },
      })
      res.writeHead(403, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'pairing failed' }))
      return
    }

    this.deps.journal?.record({
      area: 'remote.server',
      name: 'remote_pair.redeemed',
      data: { deviceId: redeemed.device.deviceId, deviceName: redeemed.device.name },
    })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        ok: true,
        token: redeemed.token,
        deviceId: redeemed.device.deviceId,
        deviceName: redeemed.device.name,
      }),
    )
  }

  // POST /dictate — phone audio -> composer text. The phone's mic button can't
  // reach the desktop's Fn-hotkey dictation path, so it records in-browser and
  // posts the blob here; we run it through the SAME Deepgram batch engine the
  // desktop uses (deps.transcribeAudio) so the API key never leaves the main
  // process. Auth is the exact /ws-upgrade gate — a valid, unrevoked device
  // token, here on the Authorization: Bearer header (keeps the token out of
  // any proxy access log that records URLs). Audio is transcribe-and-discard;
  // it is never written to a debug/state root.
  private async handleDictate(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const auth = req.headers['authorization'] ?? ''
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
    const verdict = this.deps.pairing.verifyToken(token)
    if (!verdict.ok) {
      this.deps.journal?.record({
        area: 'remote.server',
        name: 'remote_dictate.rejected',
        data: { reason: verdict.reason },
      })
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'unauthorized' }))
      return
    }
    if (!this.deps.transcribeAudio) {
      // No transcriber wired (e.g. no DEEPGRAM_API_KEY at all) — tell the phone
      // so it hides the mic rather than offering a button that can't work.
      res.writeHead(503, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'dictation-unavailable' }))
      return
    }
    let audio: Buffer
    try {
      audio = await readBodyCappedBinary(req, DICTATE_BODY_LIMIT_BYTES)
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        // The reader stopped CONSUMING but left the socket alive precisely so
        // this promised 413 can reach the client (see readBodyCappedBinary's
        // WHY). `connection: close` tells well-behaved clients not to reuse
        // the socket, and the end-callback severs it once the response has
        // flushed — the peer may still be mid-upload and must not keep the
        // paused request pinned open indefinitely.
        res.writeHead(413, { 'content-type': 'application/json', connection: 'close' })
        res.end(JSON.stringify({ ok: false, error: 'audio too large' }), () => {
          req.destroy()
        })
      }
      // Non-overflow rejection = the request stream itself errored; the
      // socket is already unusable and there is nothing meaningful to write.
      return
    }
    void this.deps.registry.touch(verdict.deviceId)
    const mimeType =
      typeof req.headers['content-type'] === 'string' ? req.headers['content-type'] : undefined
    const result = await this.deps.transcribeAudio(audio, mimeType)
    if (!result.ok) {
      // no-key is a config gap (503, works once configured); anything else is
      // an upstream STT failure (502). Never echo raw error internals further
      // than the short code the client needs to branch on.
      res.writeHead(result.error === 'no-key' ? 503 : 502, {
        'content-type': 'application/json',
      })
      res.end(JSON.stringify({ ok: false, error: result.error }))
      return
    }
    this.deps.journal?.record({
      area: 'remote.server',
      name: 'remote_dictate.ok',
      data: { deviceId: verdict.deviceId, chars: result.text.length },
    })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, text: result.text }))
  }

  private serveClient(pathname: string, res: ServerResponse): void {
    const dist = this.deps.clientDistDir
    // Per-REQUEST existence check, not construction-time: clientDistDir is
    // captured when the app boots, but in dev the bundle often gets built
    // AFTER launch (`npm run client:build`). Gating at construction meant
    // the placeholder persisted until a full app restart — the first thing
    // real-world testing tripped on. Reading the filesystem per page load
    // is negligible next to serving the files themselves, and it makes
    // "build, then just reload the phone page" work with zero restarts.
    if (!dist || !existsSync(join(dist, 'index.html'))) {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-cache',
      })
      res.end(
        '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1">' +
          '<title>Agent Code Remote</title>' +
          '<body style="font-family:system-ui;padding:2rem;background:#111;color:#eee">' +
          '<h1>Agent Code Remote</h1>' +
          '<p>The phone client bundle is not built yet. On the desktop, run:</p>' +
          '<pre style="background:#222;padding:1rem;border-radius:8px">npm run client:build</pre>' +
          '<p>then reload this page — no app restart needed. ' +
          'The WebSocket API at <code>/ws</code> is already live.</p>',
      )
      return
    }

    // Path traversal guard: normalize, strip leading separators, and refuse
    // anything that still tries to climb out. The bundle is a flat Vite dist
    // — there is nothing legitimate above it.
    const safe = normalize(pathname).replace(/^([/\\]|\.\.)+/, '')
    const filePath = join(dist, safe === '' || safe === '/' ? 'index.html' : safe)
    if (!filePath.startsWith(dist) || !existsSync(filePath)) {
      // SPA fallback: unknown paths get index.html so client-side routes
      // survive a reload on the phone.
      const index = join(dist, 'index.html')
      if (existsSync(index)) {
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-cache',
        })
        createReadStream(index).pipe(res)
      } else {
        res.writeHead(404).end()
      }
      return
    }
    // Cache discipline (learned the hard way — a phone kept serving a
    // stale page through a rebuild AND a server restart because we sent no
    // headers, and mobile browsers cache heuristically-forever without
    // them): the HTML entry must revalidate on every load (`no-cache` =
    // cached but always conditional), while Vite's content-hashed assets
    // are immutable by construction and can cache for a year — a new build
    // changes the hash, and the fresh index.html points at it.
    const isHashedAsset = filePath.includes(`${sep}assets${sep}`)
    res.writeHead(200, {
      'content-type': STATIC_CONTENT_TYPES[extname(filePath)] ?? 'application/octet-stream',
      'cache-control': isHashedAsset
        ? 'public, max-age=31536000, immutable'
        : 'no-cache',
    })
    createReadStream(filePath).pipe(res)
  }

  // ---------- WebSocket ----------

  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname !== '/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
      socket.destroy()
      return
    }
    const token = url.searchParams.get('token') ?? ''
    const verdict = this.deps.pairing.verifyToken(token)
    if (!verdict.ok) {
      // Refuse BEFORE the WS exists — an unauthenticated peer never gets a
      // socket to speak the protocol on. (The token also rides every
      // subsequent frame; this is just the cheapest earliest gate.)
      this.deps.journal?.record({
        area: 'remote.server',
        name: 'remote_ws.upgrade_rejected',
        data: { reason: verdict.reason },
      })
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }
    this.wss?.handleUpgrade(req, socket, head, ws => {
      this.onConnection(ws, verdict.deviceId)
    })
  }

  private onConnection(ws: WebSocket, deviceId: string): void {
    const client: ClientSocket = { ws, deviceId }
    this.sockets.add(client)
    this.emit('clients-changed')
    void this.deps.registry.touch(deviceId)
    this.deps.journal?.record({
      area: 'remote.server',
      name: 'remote_ws.connected',
      data: { deviceId },
    })

    const device = this.deps.registry.get(deviceId)
    this.send(ws, {
      type: 'hello',
      deviceId,
      deviceName: device?.name ?? 'unknown',
      themeSettings: this.deps.getThemeSettings?.() ?? null,
      // Per-connection STT capability so the phone gates its mic BEFORE
      // recording (see the sttAvailable WHY in protocol/messages.ts).
      sttAvailable: Boolean(this.deps.transcribeAudio) && (this.deps.isSttAvailable?.() ?? true),
    })
    this.send(ws, { type: 'session-list', sessions: this.deps.feedSource.listSessions() })
    // Late-joiner replay — same channel shape as live events so the client
    // needs no special bootstrap path.
    for (const [, payload] of this.lastScreen) {
      this.send(ws, { type: 'session-event', channel: 'screen', payload })
    }
    for (const [, payload] of this.lastConditions) {
      this.send(ws, { type: 'session-event', channel: 'conditions', payload })
    }
    for (const [, payload] of this.lastProcessState) {
      this.send(ws, { type: 'session-event', channel: 'process-state', payload })
    }

    ws.on('message', data => {
      void this.onMessage(ws, String(data))
    })
    ws.on('close', () => {
      this.sockets.delete(client)
      this.emit('clients-changed')
      this.deps.journal?.record({
        area: 'remote.server',
        name: 'remote_ws.disconnected',
        data: { deviceId },
      })
    })
  }

  private async onMessage(ws: WebSocket, raw: string): Promise<void> {
    let parsedJson: unknown
    try {
      parsedJson = JSON.parse(raw)
    } catch {
      this.send(ws, { type: 'error', error: 'invalid JSON' })
      return
    }

    const parsed = parseInboundFrame(parsedJson)
    if (!parsed.ok) {
      // Reply with the frame's id when we can salvage one so the client's
      // pending request rejects instead of timing out.
      const id =
        typeof (parsedJson as { id?: unknown })?.id === 'string'
          ? (parsedJson as { id: string }).id
          : undefined
      this.send(ws, { type: 'reply', id, ok: false, error: parsed.reason })
      return
    }
    const frame = parsed.frame

    // Per-message verification: revocation must bite mid-session, not just
    // at the next reconnect.
    const verdict = this.deps.pairing.verifyToken(frame.token)
    if (!verdict.ok) {
      this.send(ws, { type: 'reply', id: frame.id, ok: false, error: `auth: ${verdict.reason}` })
      return
    }
    void this.deps.registry.touch(verdict.deviceId)

    // apply() reaches disk (get-history) and provider runtimes; a thrown
    // error must become a structured reply, not an unhandled rejection that
    // leaves the phone's request waiting out its 10s timeout (review
    // finding). Never echo raw error internals to an untrusted socket.
    let result: { ok: boolean; error?: string; result?: unknown }
    try {
      result = await this.apply(frame)
    } catch (err) {
      this.deps.journal?.recordError('remote_apply.error', err)
      result = { ok: false, error: 'internal error applying message' }
    }
    this.send(ws, { type: 'reply', id: frame.id, ...result })
  }

  private async apply(frame: InboundFrame): Promise<{ ok: boolean; error?: string; result?: unknown }> {
    const msg = frame.message
    switch (msg.type) {
      case 'ping':
        return { ok: true, result: 'pong' }

      case 'send-prompt': {
        // EVERY agent kind goes through SessionManager.deliverPromptToAgent —
        // the registry routes to the provider's own prompt-delivery module
        // (Claude: paste, confirm active-composer absorption, Enter, then await
        // durable user/queue JSONL acceptance;
        // Codex: readiness gate + atomic paste+Enter; opencode: HTTP prompt).
        // A hand-rolled bare bracketed-paste write here reintroduced the
        // exact swallowed-Enter bugs those modules exist to prevent: the
        // paste bytes land, the reply says ok, and the prompt sits unsent in
        // the composer. delivery INCLUDES the submit, so the phone client
        // sends no separate '\r' frame after this (see SessionView.sendPrompt).
        const delivered = await this.deps.manager.deliverPromptToAgent(msg.sessionId, msg.text)
        return delivered.ok ? { ok: true } : { ok: false, error: delivered.message }
      }

      case 'submit': {
        const wrote = this.deps.manager.write(msg.sessionId, SUBMIT_BYTES)
        return wrote ? { ok: true } : { ok: false, error: 'session not writable' }
      }

      case 'interrupt': {
        const wrote = this.deps.manager.write(msg.sessionId, INTERRUPT_BYTES)
        return wrote ? { ok: true } : { ok: false, error: 'session not writable' }
      }

      case 'permission-reply':
        return this.applyPermissionReply(msg.sessionId, msg.action)

      case 'get-history': {
        // Read-only backfill. The transcript file is the one key main can
        // actually resolve for a live session (cached off the jsonl-entry
        // relay — see SessionManager.getTranscriptFile). No file yet means
        // the session has not written a durable line this run; the phone
        // shows live-only and may retry after the first entry lands.
        // resolveTranscriptFile is resume-aware: restored sessions have a
        // durable transcript even before their first NEW jsonl line this app
        // run (the restart case field testing hit).
        const file = await this.deps.manager.resolveTranscriptFile(msg.sessionId)
        if (!file) {
          return { ok: false, error: 'no transcript on disk yet for this session' }
        }
        const kind = this.deps.manager.getSessionKind(msg.sessionId)
        if (!kind || kind === 'terminal') {
          return { ok: false, error: 'not an agent session' }
        }
        const chunk = msg.beforeMarker
          ? await loadOlderHistoryChunkFromFile(file, {
              kind,
              beforeMarker: msg.beforeMarker,
              limit: msg.limit ?? 200,
            })
          : await loadInitialHistoryChunkFromFile(file, msg.limit ?? 120)
        // Raw records, same shape as the live jsonl frames' `entry` halves,
        // so the phone runs ONE mapper path for backfill and live. `file`
        // rides along so the client can detect a transcript ROLL: after
        // /clear (or a resume that starts a new provider session) the
        // manager's file cache is stale until the new conversation's first
        // durable line, and a backfill served from the OLD file must be
        // discardable client-side by comparing against the file the live
        // frames carry.
        return { ok: true, result: { ...chunk, file } }
      }
    }
  }

  private async applyPermissionReply(
    sessionId: string,
    action:
      | { kind: 'pty'; id: string; label: string; data: string }
      | ConditionCustomAction,
  ): Promise<{ ok: boolean; error?: string; result?: unknown }> {
    if (action.kind === 'custom') {
      // Custom actions go through the provider's own resolver, which
      // reparses the live terminal and fails closed — the safety property
      // lives there, not here.
      const result = await this.deps.manager.resolveCondition(sessionId, action)
      return result.ok
        ? { ok: true, result: result.state }
        : { ok: false, error: `resolver: ${result.reason}` }
    }

    // pty actions ARE raw keystrokes, so schema validation alone would be
    // the raw-input hole v1 amputated. The guard: the exact action (id AND
    // bytes) must be one the LIVE condition snapshot itself offered. The
    // phone picks from the provider's menu; it never composes keystrokes.
    const snapshot = this.lastConditions.get(sessionId) as
      | { snapshot?: { conditions?: Record<string, { actions?: Array<{ kind: string; id: string; data?: string }> }> } }
      | undefined
    const conditions = snapshot?.snapshot?.conditions ?? {}
    const offered = Object.values(conditions).some(record =>
      (record.actions ?? []).some(
        a => a.kind === 'pty' && a.id === action.id && a.data === action.data,
      ),
    )
    if (!offered) {
      return { ok: false, error: 'action does not match any live condition' }
    }
    const wrote = this.deps.manager.write(sessionId, action.data)
    return wrote ? { ok: true } : { ok: false, error: 'session not writable' }
  }

  // ---------- fan-out plumbing ----------

  private cacheForLateJoiners(channel: FeedChannel, payload: unknown): void {
    const sessionId = (payload as { sessionId?: string })?.sessionId
    if (!sessionId) return
    if (channel === 'screen') this.lastScreen.set(sessionId, payload)
    else if (channel === 'conditions') this.lastConditions.set(sessionId, payload)
    else if (channel === 'process-state') this.lastProcessState.set(sessionId, payload)
    else if (channel === 'exit' || channel === 'removed') {
      // A dead session's stale screen must not greet the next connection as
      // if it were live; the event itself still broadcast normally.
      // 'removed' covers the removed-without-exit paths (tmux detach,
      // spawn-failure rollback) that would otherwise pin caches forever.
      this.lastScreen.delete(sessionId)
      this.lastConditions.delete(sessionId)
      this.lastProcessState.delete(sessionId)
    }
  }

  private broadcast(frame: OutboundFrame): void {
    if (this.sockets.size === 0) return
    // Serialize once per frame, not per socket — screen frames at TUI redraw
    // rate times N phones would otherwise multiply stringify cost.
    const encoded = JSON.stringify(frame)
    for (const client of this.sockets) {
      if (client.ws.readyState === client.ws.OPEN) client.ws.send(encoded)
    }
  }

  private send(ws: WebSocket, frame: OutboundFrame): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame))
  }
}

async function readBodyCapped(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        // Unauthenticated endpoint — cap the body so a hostile peer can't
        // balloon memory before the code check even runs.
        req.destroy()
        reject(new Error('body too large'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** Overflow marker for readBodyCappedBinary so handleDictate can tell "cap
 *  tripped, socket still writable → answer 413" apart from "stream errored,
 *  socket is gone → nothing to write". */
class BodyTooLargeError extends Error {
  constructor() {
    super('body too large')
  }
}

// Binary sibling of readBodyCapped for the /dictate audio blob: same
// cap discipline, but resolves the raw Buffer instead of decoding UTF-8
// (audio bytes must not go through a string round-trip) and — unlike the
// /pair helper — does NOT destroy the socket on overflow. /dictate is an
// AUTHENTICATED endpoint that promises a 413 JSON body; req.destroy() here
// killed the connection before handleDictate could write it, so the phone
// saw a bare connection reset and reported a generic upload failure (review
// finding). Instead: stop consuming (detach the data listener + pause, so
// TCP backpressure holds the rest of the upload without buffering it) and
// reject with the marker error; the caller writes the 413 and severs the
// socket only after the response has flushed.
async function readBodyCappedBinary(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    const onData = (chunk: Buffer): void => {
      size += chunk.length
      if (size > limit) {
        req.removeListener('data', onData)
        req.pause()
        reject(new BodyTooLargeError())
        return
      }
      chunks.push(chunk)
    }
    req.on('data', onData)
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}
