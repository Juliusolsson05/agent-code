import type { SessionFeed, Unsub } from '@shared/sessionFeed/SessionFeed'
import type {
  ConditionCustomAction,
  ResolveConditionResult,
  SessionConditionsEvent,
  SessionExitEvent,
  SessionJsonlEntriesEvent,
  SessionJsonlErrorEvent,
  SessionProcessStateEvent,
  SessionScreenEvent,
  SessionSemanticEvent,
  SessionStartedEvent,
  SessionSubAgentsEvent,
} from '@shared/sessionFeed/types'
import { applyTheme } from '@renderer/app-state/settings/theme'
import { DEFAULT_SETTINGS, type Settings } from '@renderer/app-state/settings/types'

import type {
  FeedChannel,
  HistoryChunkResult,
  InboundFrame,
  InboundMessage,
  OutboundFrame,
  RemoteSessionSummary,
} from './wire'

function applyRemoteThemeSettings(settings: Record<string, unknown> | null | undefined): void {
  if (!settings) return
  applyTheme({ ...DEFAULT_SETTINGS, ...settings } as Settings)
}

// WebSocketSessionFeed — the phone's implementation of the SessionFeed
// contract (the desktop's is IpcSessionFeed). Same interface, different
// transport: session events arrive as `session-event` frames and fan out to
// the same listener shape; commands become inbound protocol frames with a
// client-minted id, correlated against the server's `reply`.
//
// WHY sendInput only accepts three byte shapes: the v1 wire protocol has NO
// raw-input message BY DESIGN (a stolen token must not be a keyboard — see
// protocol/messages.ts). But SessionFeed.sendInput exists because desktop
// components express submit/interrupt/prompt as bytes. So this transport
// translates the three byte shapes the v1 scope covers — '\r' → submit,
// '\x1b' → interrupt, a bracketed paste → send-prompt — and REJECTS anything
// else with a clear error. A desktop component that sends other raw bytes
// (e.g. arrow-key forwarding) simply isn't phone-supported yet; widening
// this translation means widening the wire protocol first, consciously.
//
// Reconnect: the socket redials with capped backoff until dispose(). On
// each (re)connect the server replays session-list + cached per-session
// state, so listeners self-heal without a client-side resync protocol.

const BRACKETED_PASTE = /^\x1b\[200~([\s\S]*)\x1b\[201~$/
const REQUEST_TIMEOUT_MS = 10_000
const RECONNECT_BASE_MS = 1_000
const RECONNECT_CAP_MS = 10_000

/** The subset of the WebSocket API this feed touches — injectable so the
 *  node integration test can pass the `ws` package's client, which
 *  implements the same event surface as the browser's. */
export type WebSocketLike = {
  readyState: number
  send(data: string): void
  close(): void
  addEventListener(type: 'open' | 'close' | 'error', cb: () => void): void
  addEventListener(type: 'message', cb: (event: { data: unknown }) => void): void
}

export type ConnectionState = 'connecting' | 'open' | 'closed'

export type WebSocketSessionFeedOptions = {
  /** ws(s):// URL including the /ws path; token is appended as a query param. */
  url: string
  token: string
  createSocket?: (url: string) => WebSocketLike
}

type Pending = {
  resolve: (frame: { ok: boolean; error?: string; result?: unknown }) => void
  timer: ReturnType<typeof setTimeout>
}

export class WebSocketSessionFeed implements SessionFeed {
  private readonly listeners: Record<FeedChannel | 'sub-agents', Set<(e: never) => void>> = {
    started: new Set(),
    screen: new Set(),
    'jsonl-entries': new Set(),
    'jsonl-error': new Set(),
    'semantic-event': new Set(),
    conditions: new Set(),
    'process-state': new Set(),
    exit: new Set(),
    // 'removed' has no SessionFeed listener (the contract has no
    // onSessionRemoved — desktop panes learn removal via workspace state);
    // the phone consumes it internally to prune its session list below.
    removed: new Set(),
    // The server never emits sub-agents in v1 (SessionFeedSource doesn't tap
    // it yet); the set exists so onSessionSubAgents satisfies the contract
    // and starts working the moment the server adds the channel.
    'sub-agents': new Set(),
  }
  private readonly sessionListListeners = new Set<(s: RemoteSessionSummary[]) => void>()
  private readonly connectionListeners = new Set<(s: ConnectionState) => void>()
  private readonly pending = new Map<string, Pending>()
  private socket: WebSocketLike | null = null
  private disposed = false
  private reconnectAttempt = 0
  private nextRequestId = 1
  private lastSessionList: RemoteSessionSummary[] = []

  constructor(private readonly opts: WebSocketSessionFeedOptions) {
    this.dial()
  }

  // --- client-specific surface (beyond SessionFeed) ---

  getSessionList(): RemoteSessionSummary[] {
    return this.lastSessionList
  }

  onSessionList(cb: (sessions: RemoteSessionSummary[]) => void): Unsub {
    this.sessionListListeners.add(cb)
    return () => this.sessionListListeners.delete(cb)
  }

  onConnectionState(cb: (state: ConnectionState) => void): Unsub {
    this.connectionListeners.add(cb)
    return () => this.connectionListeners.delete(cb)
  }

  dispose(): void {
    this.disposed = true
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.resolve({ ok: false, error: 'feed disposed' })
    }
    this.pending.clear()
    this.socket?.close()
    this.socket = null
  }

  // --- SessionFeed listeners ---

  onSessionStarted(cb: (e: SessionStartedEvent) => void): Unsub {
    return this.sub('started', cb)
  }
  onSessionScreen(cb: (e: SessionScreenEvent) => void): Unsub {
    return this.sub('screen', cb)
  }
  onSessionJsonlEntries(cb: (e: SessionJsonlEntriesEvent) => void): Unsub {
    return this.sub('jsonl-entries', cb)
  }
  onSessionJsonlError(cb: (e: SessionJsonlErrorEvent) => void): Unsub {
    return this.sub('jsonl-error', cb)
  }
  onSessionSemanticEvent(cb: (e: SessionSemanticEvent) => void): Unsub {
    return this.sub('semantic-event', cb)
  }
  onSessionConditions(cb: (e: SessionConditionsEvent) => void): Unsub {
    return this.sub('conditions', cb)
  }
  onSessionProcessState(cb: (e: SessionProcessStateEvent) => void): Unsub {
    return this.sub('process-state', cb)
  }
  onSessionSubAgents(cb: (e: SessionSubAgentsEvent) => void): Unsub {
    return this.sub('sub-agents', cb)
  }
  onSessionExit(cb: (e: SessionExitEvent) => void): Unsub {
    return this.sub('exit', cb)
  }

  // --- SessionFeed commands ---

  async sendInput(sessionId: string, data: string): Promise<boolean> {
    let message: InboundMessage
    const paste = BRACKETED_PASTE.exec(data)
    if (paste) {
      message = { type: 'send-prompt', sessionId, text: paste[1] }
    } else if (data === '\r') {
      message = { type: 'submit', sessionId }
    } else if (data === '\x1b') {
      message = { type: 'interrupt', sessionId }
    } else {
      throw new Error(
        'WebSocketSessionFeed.sendInput: raw byte input is not part of the v1 ' +
          'remote protocol (only prompt/submit/interrupt shapes translate). ' +
          'See src/main/remote/protocol/messages.ts.',
      )
    }
    const reply = await this.request(message)
    return reply.ok
  }

  async deliverPrompt(
    sessionId: string,
    prompt: string,
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    const reply = await this.request({ type: 'send-prompt', sessionId, text: prompt })
    return reply.ok ? { ok: true } : { ok: false, message: reply.error ?? 'delivery failed' }
  }

  async resolveCondition(
    sessionId: string,
    action: ConditionCustomAction,
  ): Promise<ResolveConditionResult> {
    const reply = await this.request({ type: 'permission-reply', sessionId, action })
    // The server flattens the resolver's structured failure into reply.error;
    // reconstruct the nearest ResolveConditionResult shape. 'aborted' is the
    // most honest generic bucket for a transport-level failure.
    return reply.ok
      ? { ok: true, state: reply.result }
      : { ok: false, reason: 'aborted', failedAtStep: reply.error }
  }

  /** Transcript backfill (client-specific, beyond SessionFeed — the desktop
   *  loads history through its own IPC path). beforeMarker absent = initial
   *  newest-N chunk; present = the page immediately before it. */
  async getHistory(
    sessionId: string,
    opts: { beforeMarker?: string; limit?: number } = {},
  ): Promise<{ ok: true; chunk: HistoryChunkResult } | { ok: false; error: string }> {
    const reply = await this.request({
      type: 'get-history',
      sessionId,
      beforeMarker: opts.beforeMarker,
      limit: opts.limit,
    })
    return reply.ok
      ? { ok: true, chunk: reply.result as HistoryChunkResult }
      : { ok: false, error: reply.error ?? 'history unavailable' }
  }

  /** pty actions ride the same permission-reply message; exposed for the
   *  phone UI's condition buttons (desktop components use resolveCondition
   *  for custom actions and raw bytes for pty ones — the phone can't send
   *  raw bytes, so this is its explicit path). */
  async replyWithPtyAction(
    sessionId: string,
    action: { kind: 'pty'; id: string; label: string; data: string },
  ): Promise<{ ok: boolean; error?: string }> {
    return this.request({ type: 'permission-reply', sessionId, action })
  }

  // --- internals ---

  private sub<E>(channel: FeedChannel | 'sub-agents', cb: (e: E) => void): Unsub {
    const set = this.listeners[channel] as Set<(e: E) => void>
    set.add(cb)
    return () => set.delete(cb)
  }

  private dial(): void {
    if (this.disposed) return
    this.emitConnection('connecting')
    const url = `${this.opts.url}?token=${encodeURIComponent(this.opts.token)}`
    const factory =
      this.opts.createSocket ??
      ((u: string) => new WebSocket(u) as unknown as WebSocketLike)
    let socket: WebSocketLike
    try {
      socket = factory(url)
    } catch {
      this.scheduleReconnect()
      return
    }
    this.socket = socket

    socket.addEventListener('open', () => {
      this.reconnectAttempt = 0
      this.emitConnection('open')
    })
    socket.addEventListener('message', event => {
      this.onFrame(String(event.data))
    })
    socket.addEventListener('close', () => {
      if (this.socket === socket) this.socket = null
      this.emitConnection('closed')
      this.scheduleReconnect()
    })
    // 'error' always precedes 'close' in both implementations; reconnect is
    // driven off close so errors need no separate handling.
    socket.addEventListener('error', () => {})
  }

  private scheduleReconnect(): void {
    if (this.disposed) return
    const delay = Math.min(
      RECONNECT_BASE_MS * 2 ** this.reconnectAttempt,
      RECONNECT_CAP_MS,
    )
    this.reconnectAttempt += 1
    setTimeout(() => this.dial(), delay)
  }

  private onFrame(raw: string): void {
    let frame: OutboundFrame
    try {
      frame = JSON.parse(raw) as OutboundFrame
    } catch {
      return
    }
    switch (frame.type) {
      case 'session-list': {
        this.lastSessionList = frame.sessions
        for (const cb of [...this.sessionListListeners]) cb(frame.sessions)
        return
      }
      case 'session-event': {
        // Keep the picker's recency live without re-requesting the list:
        // any event for a session IS activity. Cheap (one map when the
        // session is present) and mirrors how the server stamps the value.
        const activeId = (frame.payload as { sessionId?: string })?.sessionId
        if (activeId && this.lastSessionList.some(s => s.sessionId === activeId)) {
          this.lastSessionList = this.lastSessionList.map(s =>
            s.sessionId === activeId ? { ...s, lastActivityAt: Date.now() } : s,
          )
          for (const cb of [...this.sessionListListeners]) cb(this.lastSessionList)
        }
        const set = this.listeners[frame.channel]
        if (!set) return
        for (const cb of [...set]) (cb as (e: unknown) => void)(frame.payload)
        // A 'started' event is also a session-list change the server doesn't
        // re-send; patch the local list so the UI's list screen stays live.
        if (frame.channel === 'started') {
          const started = frame.payload as { sessionId: string; kind: string; projectDir?: string }
          const rest = this.lastSessionList.filter(s => s.sessionId !== started.sessionId)
          this.lastSessionList = [
            ...rest,
            {
              sessionId: started.sessionId,
              kind: started.kind,
              cwd: started.projectDir ?? null,
              alive: true,
              lastActivityAt: Date.now(),
            },
          ]
          for (const cb of [...this.sessionListListeners]) cb(this.lastSessionList)
        } else if (frame.channel === 'exit') {
          const exited = frame.payload as { sessionId: string }
          this.lastSessionList = this.lastSessionList.map(s =>
            s.sessionId === exited.sessionId ? { ...s, alive: false } : s,
          )
          for (const cb of [...this.sessionListListeners]) cb(this.lastSessionList)
        } else if (frame.channel === 'removed') {
          // Covers the removed-without-exit paths (tmux detach, spawn
          // rollback): the session is GONE, not merely dead — drop the row.
          const removed = frame.payload as { sessionId: string }
          this.lastSessionList = this.lastSessionList.filter(
            s => s.sessionId !== removed.sessionId,
          )
          for (const cb of [...this.sessionListListeners]) cb(this.lastSessionList)
        }
        return
      }
      case 'reply': {
        if (!frame.id) return
        const pending = this.pending.get(frame.id)
        if (!pending) return
        this.pending.delete(frame.id)
        clearTimeout(pending.timer)
        pending.resolve({ ok: frame.ok, error: frame.error, result: frame.result })
        return
      }
      case 'hello':
        applyRemoteThemeSettings(frame.themeSettings)
        return
      case 'theme-settings':
        applyRemoteThemeSettings(frame.themeSettings)
        return
      case 'error':
        return
    }
  }

  private request(
    message: InboundMessage,
  ): Promise<{ ok: boolean; error?: string; result?: unknown }> {
    const socket = this.socket
    if (!socket || socket.readyState !== 1 /* OPEN */) {
      return Promise.resolve({ ok: false, error: 'not connected' })
    }
    const id = `req-${this.nextRequestId++}`
    const frame: InboundFrame = { token: this.opts.token, id, message }
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve({ ok: false, error: 'request timed out' })
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(id, { resolve, timer })
      socket.send(JSON.stringify(frame))
    })
  }

  private emitConnection(state: ConnectionState): void {
    for (const cb of [...this.connectionListeners]) cb(state)
  }
}
