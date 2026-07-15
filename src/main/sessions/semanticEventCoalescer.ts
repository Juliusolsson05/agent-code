import type { SessionSemanticEvent } from '@shared/sessionFeed/types'
import { SemanticEventBackpressureQueue } from '@shared/sessionFeed/semanticEventBackpressure.js'

const DEFAULT_FLUSH_MS = 100

/**
 * Bound provider semantic traffic before Electron's structured-clone boundary.
 *
 * WHY renderer coalescing is insufficient: `ipcRenderer` must deserialize and dispatch every main
 * message before renderer JavaScript can decide that 500 tool-input prefixes have the same owner.
 * Under parallel agents that queue alone can starve heartbeats and input. Main already receives
 * cumulative provider snapshots, so it can collapse obsolete prefixes before Chromium ever owns
 * them. Structural events drain first and cross synchronously, preserving exact ordering.
 */
export class SemanticEventIpcCoalescer {
  private readonly sessions = new Map<
    string,
    {
      queue: SemanticEventBackpressureQueue
      timer: ReturnType<typeof setTimeout> | null
    }
  >()

  constructor(
    private readonly send: (message: SessionSemanticEvent) => void,
    private readonly flushMs = DEFAULT_FLUSH_MS,
  ) {}

  enqueue(message: SessionSemanticEvent): void {
    const state = this.stateFor(message.sessionId)
    if (!state.queue.tryPush(message)) {
      // WHY an ordering barrier drains only its own session: provider order is
      // scoped by sessionId. The previous global queue made one agent's
      // turn_completed flush every other agent's cumulative prefixes, defeating
      // their 100 ms windows and recreating a nine-agent IPC burst.
      this.flush(message.sessionId)
      this.send(message)
      return
    }
    // WHY a distinct-key ceiling exists in addition to a timer: coalescing
    // bounds repeated deltas for one block but not a provider that starts an
    // unbounded number of distinct blocks inside one window. Draining at 128
    // preserves every event while bounding retained objects per session.
    if (state.queue.size >= 128) {
      this.flush(message.sessionId)
      return
    }
    if (state.timer) return
    state.timer = setTimeout(() => {
      state.timer = null
      this.flush(message.sessionId)
    }, this.flushMs)
    state.timer.unref?.()
  }

  flush(sessionId?: string): void {
    if (sessionId === undefined) {
      for (const id of [...this.sessions.keys()]) this.flush(id)
      return
    }
    const state = this.sessions.get(sessionId)
    if (!state) return
    if (state.timer) {
      clearTimeout(state.timer)
      state.timer = null
    }
    for (const pending of state.queue.drain()) {
      this.send({
        ...pending.message,
        rawEventCount: pending.rawEventCount,
      })
    }
    this.sessions.delete(sessionId)
  }

  private stateFor(sessionId: string): {
    queue: SemanticEventBackpressureQueue
    timer: ReturnType<typeof setTimeout> | null
  } {
    const existing = this.sessions.get(sessionId)
    if (existing) return existing
    const created = {
      queue: new SemanticEventBackpressureQueue(),
      timer: null,
    }
    this.sessions.set(sessionId, created)
    return created
  }
}
