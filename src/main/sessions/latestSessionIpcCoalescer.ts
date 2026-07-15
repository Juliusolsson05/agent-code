const DEFAULT_FLUSH_MS = 100
const DEFAULT_MAX_SESSIONS_PER_FLUSH = 12

/**
 * Keep only the latest authoritative snapshot for each session.
 *
 * WHY this class is intentionally not used for semantic deltas: screen and
 * process-state events are complete snapshots, so an older pending value has
 * no information the newer value lacks. Semantic events have ordering and
 * fragment contracts and therefore use SemanticEventIpcCoalescer instead.
 * Separating the two makes the lossiness auditable rather than hiding it in a
 * generic "batch all IPC" abstraction.
 */
export class LatestSessionIpcCoalescer<T extends { sessionId: string }> {
  private readonly pending = new Map<string, T>()
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly send: (message: T) => void,
    private readonly flushMs = DEFAULT_FLUSH_MS,
    private readonly maxSessionsPerFlush = DEFAULT_MAX_SESSIONS_PER_FLUSH,
  ) {}

  enqueue(message: T): void {
    this.pending.set(message.sessionId, message)
    this.schedule(this.flushMs)
  }

  flush(sessionId?: string): void {
    if (sessionId !== undefined) {
      const message = this.pending.get(sessionId)
      this.pending.delete(sessionId)
      if (message) this.send(message)
      if (this.pending.size === 0 && this.timer) {
        clearTimeout(this.timer)
        this.timer = null
      }
      return
    }

    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    let admitted = 0
    for (const [id, message] of this.pending) {
      this.pending.delete(id)
      this.send(message)
      admitted += 1
      if (admitted >= this.maxSessionsPerFlush) break
    }

    // WHY the remainder crosses on a later task: with many restored sessions,
    // even latest-only snapshots could otherwise arrive as one uninterrupted
    // structured-clone burst. Twelve keeps the normal nine-agent workflow in
    // one visible refresh while guaranteeing a scheduler boundary for larger
    // fleets.
    if (this.pending.size > 0) this.schedule(0)
  }

  private schedule(delay: number): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush()
    }, delay)
    this.timer.unref?.()
  }
}
