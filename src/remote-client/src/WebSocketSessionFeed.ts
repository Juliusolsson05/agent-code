import type { SessionFeed, Unsub } from '@shared/sessionFeed/SessionFeed'
import type {
  ConditionCustomAction,
  ResolveConditionResult,
  SessionConditionsEvent,
  SessionExitEvent,
  SessionJsonlEntriesEvent,
  SessionJsonlErrorEvent,
  SessionInputReadinessEvent,
  SessionProcessStateEvent,
  SessionScreenEvent,
  SessionSemanticEvent,
  SessionStartedEvent,
  SessionSubAgentsEvent,
  SessionHistoryBoundaryEvent,
} from '@shared/sessionFeed/types'
import { applyTheme } from '@renderer/app-state/settings/theme'
import { DEFAULT_SETTINGS } from '@renderer/app-state/settings/types'
import type { Settings } from '@renderer/app-state/settings/types'
import type { PromptDeliveryResult } from '@shared/types/providerConfig'

import type {
  FeedChannel,
  HistoryChunkResult,
  InboundFrame,
  InboundMessage,
  OutboundFrame,
  RemoteNoteRecord,
  RemoteSessionSummary,
} from './wire'
import type { UsageSnapshot } from '@shared/types/usage'

/**
 * How stale the picker's recency stamp may get before a stream frame
 * refreshes it.
 *
 * It is not a debounce on rendering — it is the resolution of the value
 * itself. The list sorts by it, so a finer stamp does not make the phone more
 * informative, it only makes rows change places; the row's own `working`
 * marker is what shows live state. Thirty seconds also matches the interval
 * the list already re-renders on to keep its relative labels fresh, so a
 * refreshed stamp is visible on the next tick at the latest.
 */
const ACTIVITY_REFRESH_MS = 30_000

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
// state. TranscriptStore resets its loaded window on disconnect and backfills
// after the next authoritative list; cached state alone cannot repair a gap.

const BRACKETED_PASTE = /^\x1b\[200~([\s\S]*)\x1b\[201~$/
// WHY this exceeds the provider protocol: Claude may spend 2s proving paste
// absorption and then wait through the JSONL tailer's 15s recovery window.
// Transport cannot time out before main returns retry safety.
const REQUEST_TIMEOUT_MS = 30_000
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
  resolve: (frame: RemoteReply) => void
  timer: ReturnType<typeof setTimeout>
}

type RemoteReply = Omit<Extract<OutboundFrame, { type: 'reply' }>, 'type' | 'id'>

export class WebSocketSessionFeed implements SessionFeed {
  private readonly listeners: Record<FeedChannel | 'sub-agents', Set<(e: never) => void>> = {
    started: new Set(),
    'input-readiness': new Set(),
    screen: new Set(),
    'jsonl-entries': new Set(),
    'jsonl-error': new Set(),
    'history-boundary': new Set(),
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
  private readonly sttListeners = new Set<(available: boolean | null) => void>()
  // v2 note state: latest TLDR/Goal record per session. Kept here (not in
  // TranscriptStore) because notes are glance metadata, not transcript —
  // they outlive session views and belong to the connection, exactly like
  // the session list itself. Bootstrap frames from the server seed these
  // at (re)connect; live updates replace per session.
  private readonly tldrBySession = new Map<string, RemoteNoteRecord>()
  private readonly goalBySession = new Map<string, RemoteNoteRecord>()
  private readonly tldrListeners = new Set<(e: { sessionId: string; record: RemoteNoteRecord }) => void>()
  private readonly goalListeners = new Set<(e: { sessionId: string; record: RemoteNoteRecord }) => void>()
  // v2: last account usage snapshot (global, not per-session). null until
  // the server pushes one — the UI keeps the indicator hidden rather than
  // guessing "normal".
  private usageSnapshot: UsageSnapshot | null = null
  private readonly usageListeners = new Set<(snapshot: UsageSnapshot | null) => void>()
  private readonly pending = new Map<string, Pending>()
  private socket: WebSocketLike | null = null
  private disposed = false
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private nextRequestId = 1
  private lastSessionList: RemoteSessionSummary[] = []
  /** Latest hello-declared STT capability. null = unknown (no hello yet, or
   *  a pre-capability server that omits the field) — consumers treat null as
   *  available so version skew degrades to the old fail-at-upload behavior,
   *  never to a wrongly-hidden mic. Re-stamped on every (re)connect's hello,
   *  which is what lets a key added on the desktop light the mic up without
   *  a page reload. */
  private sttAvailable: boolean | null = null

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

  getSttAvailability(): boolean | null {
    return this.sttAvailable
  }

  /** Fires when the hello frame changes the STT verdict — a listener (not
   *  just the getter) because the hello lands asynchronously after the
   *  socket opens, so a component that read the getter at mount would
   *  otherwise never learn the real answer. */
  onSttAvailability(cb: (available: boolean | null) => void): Unsub {
    this.sttListeners.add(cb)
    return () => this.sttListeners.delete(cb)
  }

  // --- v2 note surface (TLDR / Goal peeks) ---

  getTldrRecord(sessionId: string): RemoteNoteRecord | null {
    return this.tldrBySession.get(sessionId) ?? null
  }

  getGoalRecord(sessionId: string): RemoteNoteRecord | null {
    return this.goalBySession.get(sessionId) ?? null
  }

  onTldrChanged(cb: (e: { sessionId: string; record: RemoteNoteRecord }) => void): Unsub {
    this.tldrListeners.add(cb)
    return () => this.tldrListeners.delete(cb)
  }

  onGoalChanged(cb: (e: { sessionId: string; record: RemoteNoteRecord }) => void): Unsub {
    this.goalListeners.add(cb)
    return () => this.goalListeners.delete(cb)
  }

  getUsage(): UsageSnapshot | null {
    return this.usageSnapshot
  }

  onUsage(cb: (snapshot: UsageSnapshot | null) => void): Unsub {
    this.usageListeners.add(cb)
    return () => this.usageListeners.delete(cb)
  }

  dispose(): void {
    this.disposed = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
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
  onSessionInputReadiness(cb: (e: SessionInputReadinessEvent) => void): Unsub {
    return this.sub('input-readiness', cb)
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
  onSessionHistoryBoundary(cb: (e: SessionHistoryBoundaryEvent) => void): Unsub {
    return this.sub('history-boundary', cb)
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
    imagePaths?: string[],
    _deliveryId?: string,
  ): Promise<PromptDeliveryResult> {
    if (imagePaths && imagePaths.length > 0) {
      return {
        ok: false, stage: 'before-write', code: 'missing-capability',
        message: 'Remote image-path delivery is not supported', retrySafe: true,
        disposition: 'retry-after-resolve',
        promptWritten: false, enterWritten: false,
      }
    }
    const reply = await this.request({ type: 'send-prompt', sessionId, text: prompt })
    if (reply.delivery) {
      if (reply.delivery.ok || reply.delivery.disposition) return reply.delivery
      // Mixed-version remote pairs are expected during desktop rollouts. An
      // older server can send the pre-disposition failure shape even though the
      // new client type already requires the field. Synthesize a conservative
      // value at the wire boundary: preserve the session for clean pre-write
      // retries and forbid automatic retry once duplicate safety is uncertain.
      return {
        ...reply.delivery,
        disposition: reply.delivery.retrySafe
          ? 'retry-same-session'
          : 'do-not-retry',
      }
    }
    // A locally rejected request has crossed no transport boundary. Treating
    // this like an after-Enter timeout would lock the phone's composer behind
    // the manual transcript-verification escape hatch even though no server —
    // much less Claude's PTY — ever saw the prompt. Keep the conservative
    // fallback below for replies whose provenance is ambiguous; this exact
    // sentinel is owned by request() and therefore proves a pre-write failure.
    if (!reply.ok && reply.error === 'not connected') {
      return {
        ok: false,
        stage: 'before-write',
        code: 'transport-failed',
        message: reply.error,
        retrySafe: true,
        disposition: 'retry-same-session',
        promptWritten: false,
        enterWritten: false,
      }
    }
    return reply.ok
      ? { ok: true, acceptance: { kind: 'transport', acceptedAt: Date.now() } }
      : {
          ok: false,
          stage: 'after-enter',
          code: 'transport-failed',
          message: reply.error ?? 'delivery failed',
          retrySafe: false,
          disposition: 'do-not-retry',
          promptWritten: true,
          enterWritten: true,
        }
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
    opts: { beforeMarker?: string; beforeOffset?: number; limit?: number } = {},
  ): Promise<{ ok: true; chunk: HistoryChunkResult } | { ok: false; error: string }> {
    const reply = await this.request({
      type: 'get-history',
      sessionId,
      beforeMarker: opts.beforeMarker,
      beforeOffset: opts.beforeOffset,
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
      ((u: string) => new WebSocket(u) as WebSocketLike)
    let socket: WebSocketLike
    try {
      socket = factory(url)
    } catch {
      this.scheduleReconnect()
      return
    }
    this.socket = socket

    socket.addEventListener('open', () => {
      if (this.socket !== socket || this.disposed) return
      this.reconnectAttempt = 0
      this.emitConnection('open')
    })
    socket.addEventListener('message', event => {
      if (this.socket === socket && !this.disposed) this.onFrame(String(event.data))
    })
    socket.addEventListener('close', () => {
      if (this.socket !== socket || this.disposed) return
      this.socket = null
      // The remote command may already have reached the provider. Reject
      // pending requests promptly, but NEVER replay them on reconnect. The
      // prompt API's conservative fallback preserves duplicate-send safety.
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer)
        pending.resolve({ ok: false, error: 'Connection lost; request outcome is unknown.' })
      }
      this.pending.clear()
      this.emitConnection('closed')
      this.scheduleReconnect()
    })
    // 'error' always precedes 'close' in both implementations; reconnect is
    // driven off close so errors need no separate handling.
    socket.addEventListener('error', () => {})
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer) return
    const delay = Math.min(
      RECONNECT_BASE_MS * 2 ** this.reconnectAttempt,
      RECONNECT_CAP_MS,
    )
    this.reconnectAttempt += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.dial()
    }, delay)
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
        // Identity (title, pin, runtime, membership) comes from the server and
        // replaces ours immediately. The RECENCY does not: the server stamps
        // when it last saw activity, we stamp when we last received a frame,
        // and the server's value can be OLDER. Taking it wholesale made the
        // list reorder on every projection change — the reviewer measured two
        // reversals inside 300 ms — and it also undid the rate limit below by
        // resetting the stamp the limit is measured from.
        //
        // Keeping the newer of the two makes recency monotone per session,
        // which is what a picker's ordering needs: rows move when something
        // newer happened, never because two clocks disagree.
        const previous = new Map(this.lastSessionList.map(row => [row.sessionId, row.lastActivityAt ?? 0]))
        const now = Date.now()
        this.lastSessionList = frame.sessions.map(row => {
          const local = previous.get(row.sessionId) ?? 0
          // A local stamp in the FUTURE is a clock artefact, not activity, and
          // dropping it is the recovery path an unconditional maximum across
          // two independent clocks cannot have (#1055 review): a phone that
          // was an hour fast when a session emitted would otherwise keep that
          // row pinned above genuinely newer ones — reading "now" the whole
          // time — long after its clock was corrected. Here the correction
          // itself retires the stamp and the server's value takes over.
          const usable = local <= now ? local : 0
          return usable > (row.lastActivityAt ?? 0) ? { ...row, lastActivityAt: usable } : row
        })
        for (const cb of [...this.sessionListListeners]) cb(this.lastSessionList)
        return
      }
      case 'session-event': {
        // Keep the picker's recency live without re-requesting the list: any
        // event for a session IS activity, and the server only re-sends the
        // whole list when the workspace projection changes.
        //
        // WHY this is rate-limited and was not: it fired for EVERY event on
        // every channel — screen, process-state, semantic-event,
        // jsonl-entries — and screen/process-state are broadcast unbatched, so
        // a working agent rebuilt the array at frame rate. Each rebuild is a
        // new array identity, so the phone's list screen re-ran its sort and
        // repainted every row; with two agents working the two rows swapped
        // places continuously, which is what "the phone menu is flashing and
        // switching positions like a million times" is. Measured on the real
        // socket: 60 notifications for 60 frames.
        //
        // The value is a SORT KEY for a picker, accurate to the minute at
        // most — the row already shows `working` for the live state. Refresh
        // it when it has gone stale, not when a terminal repaints.
        const activeId = (frame.payload as { sessionId?: string })?.sessionId
        if (activeId) {
          const current = this.lastSessionList.find(s => s.sessionId === activeId)
          // `Math.abs`, so a stamp in the FUTURE is refreshed on the next
          // event rather than waiting for a list publication (#1055 review):
          // the elapsed time is negative there, and the plain comparison
          // never fired, so a phone whose clock was corrected kept an
          // inflated stamp until an unrelated workspace change happened to
          // re-list. Any activity now retires it.
          if (current && Math.abs(Date.now() - (current.lastActivityAt ?? 0)) >= ACTIVITY_REFRESH_MS) {
            this.lastSessionList = this.lastSessionList.map(s =>
              s.sessionId === activeId ? { ...s, lastActivityAt: Date.now() } : s,
            )
            for (const cb of [...this.sessionListListeners]) cb(this.lastSessionList)
          }
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
        pending.resolve({
          ok: frame.ok,
          error: frame.error,
          result: frame.result,
          delivery: frame.delivery,
        })
        return
      }
      case 'hello': {
        applyRemoteThemeSettings(frame.themeSettings)
        // Missing field (older server) stays null = unknown, NOT false — the
        // mic must not vanish just because the desktop predates the
        // capability handshake.
        const stt = typeof frame.sttAvailable === 'boolean' ? frame.sttAvailable : null
        if (stt !== this.sttAvailable) {
          this.sttAvailable = stt
          for (const cb of [...this.sttListeners]) cb(stt)
        }
        return
      }
      case 'theme-settings':
        applyRemoteThemeSettings(frame.themeSettings)
        return
      case 'tldr-updated': {
        const record: RemoteNoteRecord = {
          text: frame.text,
          updatedAt: frame.updatedAt,
          revision: frame.revision,
        }
        this.tldrBySession.set(frame.sessionId, record)
        for (const cb of [...this.tldrListeners]) cb({ sessionId: frame.sessionId, record })
        return
      }
      case 'goal-updated': {
        const record: RemoteNoteRecord = {
          text: frame.text,
          updatedAt: frame.updatedAt,
          revision: frame.revision,
        }
        this.goalBySession.set(frame.sessionId, record)
        for (const cb of [...this.goalListeners]) cb({ sessionId: frame.sessionId, record })
        return
      }
      case 'usage-snapshot':
        this.usageSnapshot = frame.snapshot
        for (const cb of [...this.usageListeners]) cb(frame.snapshot)
        return
      case 'error':
        return
    }
  }

  private request(
    message: InboundMessage,
  ): Promise<RemoteReply> {
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
