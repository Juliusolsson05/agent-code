import type { SessionManager } from '@main/sessionManager.js'
import type { OutboundSessionSummary } from '@main/remote/protocol/messages.js'

// SessionFeedSource — the remote subsystem's read tap on SessionManager.
//
// A SECOND subscriber alongside the renderer forwarder
// (src/main/sessions/forwarder.ts), never a replacement: the forwarder keeps
// feeding the desktop exactly as before, and deleting this file would change
// nothing for the desktop. That parallel-subscriber shape is what the
// isolation boundary requires — remote reads the same public event stream,
// it does not sit in the middle of it.
//
// Channel names mirror the SessionFeed listener names (started/screen/
// jsonl-entries/…): RemoteServer wraps each callback into a
// { type: 'session-event', channel, payload } frame, and the phone's
// WebSocketSessionFeed switches on `channel` to invoke the matching
// listener set — a straight line from manager event to phone callback.
//
// Raw PTY channels (pty-data / terminal-data / agent-pty-data) are
// DELIBERATELY not tapped. They are desktop-only surfaces outside the v1
// remote scope, and never forwarding them means a compromised remote client
// cannot even OBSERVE raw terminal bytes, let alone write them.

export type FeedChannel =
  | 'started'
  | 'screen'
  | 'jsonl-entries'
  | 'jsonl-error'
  | 'semantic-event'
  | 'conditions'
  | 'process-state'
  | 'exit'

export type FeedEventListener = (channel: FeedChannel, payload: unknown) => void

type Unsubscribe = () => void

type TrackedSession = {
  sessionId: string
  kind: string
  cwd: string | null
  alive: boolean
}

type PendingBurst = {
  entries: Array<{ entry: unknown; file: string }>
  flushScheduled: boolean
}

export class SessionFeedSource {
  private readonly listeners = new Set<FeedEventListener>()
  private readonly sessions = new Map<string, TrackedSession>()
  /** Per-session jsonl coalescing buffers — same discipline as
   *  main/sessions/jsonlCoalescer.ts (buffer per session, ONE setImmediate
   *  flush, whole burst in one frame). Re-implemented locally instead of
   *  refactoring that module to take a sink because the coalescer is core
   *  and this is remote: the isolation boundary says remote adapts to core,
   *  core never grows remote-shaped parameters. ~25 lines of duplication is
   *  the price of the one-way wall, and per-socket batching may diverge
   *  from the renderer's needs later anyway. */
  private readonly pendingJsonl = new Map<string, PendingBurst>()
  private readonly unsubscribes: Unsubscribe[] = []
  private disposed = false

  constructor(manager: SessionManager) {
    const sub = <E extends Parameters<SessionManager['on']>[0]>(
      event: E,
      handler: (payload: never) => void,
    ): void => {
      manager.on(event, handler as never)
      this.unsubscribes.push(() => manager.off(event, handler as never))
    }

    sub('started', (payload: { sessionId: string; kind: string; projectDir?: string }) => {
      this.sessions.set(payload.sessionId, {
        sessionId: payload.sessionId,
        kind: payload.kind,
        cwd: payload.projectDir ?? null,
        alive: true,
      })
      this.emit('started', payload)
    })

    sub('screen', (payload: { sessionId: string }) => this.emit('screen', payload))
    sub('jsonl-error', (payload: { sessionId: string; error: Error }) =>
      this.emit('jsonl-error', {
        sessionId: payload.sessionId,
        // Match the forwarder's serialization: Errors don't survive
        // structured clone/JSON, the message string does.
        message: String(payload.error?.message ?? payload.error),
      }),
    )
    sub('semantic-event', (payload: { sessionId: string }) =>
      this.emit('semantic-event', payload),
    )
    sub('conditions', (payload: { sessionId: string }) => this.emit('conditions', payload))
    sub('process-state', (payload: { sessionId: string }) =>
      this.emit('process-state', payload),
    )

    sub('jsonl-entry', (payload: { sessionId: string; entry: unknown; file: string }) => {
      let pending = this.pendingJsonl.get(payload.sessionId)
      if (!pending) {
        pending = { entries: [], flushScheduled: false }
        this.pendingJsonl.set(payload.sessionId, pending)
      }
      pending.entries.push({ entry: payload.entry, file: payload.file })
      if (!pending.flushScheduled) {
        pending.flushScheduled = true
        setImmediate(() => this.flushJsonl(payload.sessionId))
      }
    })

    sub('exit', (payload: { sessionId: string; exitCode: number }) => {
      // Flush before exit so the phone sees the same ordering the renderer
      // gets (final transcript burst, then the pane goes dead).
      this.flushJsonl(payload.sessionId)
      const tracked = this.sessions.get(payload.sessionId)
      if (tracked) tracked.alive = false
      this.emit('exit', payload)
    })

    sub('removed', (payload: { sessionId: string }) => {
      // `removed` = the session left the manager entirely (kill or natural
      // teardown after exit). Drop it from the list AND drop its buffer so
      // dead sessions can't leak coalescer state — mirrors flushAndDropJsonl.
      this.flushJsonl(payload.sessionId)
      this.pendingJsonl.delete(payload.sessionId)
      this.sessions.delete(payload.sessionId)
    })
  }

  onEvent(listener: FeedEventListener): Unsubscribe {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  listSessions(): OutboundSessionSummary[] {
    return [...this.sessions.values()].map(s => ({ ...s }))
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const unsub of this.unsubscribes) unsub()
    this.unsubscribes.length = 0
    this.listeners.clear()
    this.pendingJsonl.clear()
    this.sessions.clear()
  }

  private flushJsonl(sessionId: string): void {
    const pending = this.pendingJsonl.get(sessionId)
    if (!pending || pending.entries.length === 0) return
    const entries = pending.entries
    pending.entries = []
    pending.flushScheduled = false
    this.emit('jsonl-entries', { sessionId, entries })
  }

  private emit(channel: FeedChannel, payload: unknown): void {
    if (this.disposed) return
    for (const listener of [...this.listeners]) listener(channel, payload)
  }
}
