/** One byte-offset owner per tracker, even when parent events arrive in bursts.
 *
 * A boolean `busy` guard that simply drops requests loses appends/completion
 * arriving during I/O. Queueing every request instead re-scans once per parent
 * record. The pending bit means exactly one trailing pass for any such burst;
 * requests during that pass can ask for another pass without concurrent reads.
 */
export class CoalescedRefresh {
  private pending = false
  private stopped = false
  private inflight: Promise<void> | null = null

  constructor(private readonly poll: () => Promise<void>) {}

  request(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    this.pending = true
    if (!this.inflight) {
      // Defer entry until inflight is assigned, including a synchronous throw.
      // Clear ownership INSIDE this continuation: clearing it in .finally()
      // leaves a microtask gap in which a request can join an already finished
      // drain and strand its pending bit until the next periodic timer.
      this.inflight = Promise.resolve().then(async () => {
        try {
          while (this.pending && !this.stopped) {
            this.pending = false
            try {
              await this.poll()
            } catch {
              // Polling observes externally created/rotated files. Failure is
              // retryable on the next requested pass, never an unhandled
              // rejection from a fire-and-forget parent event or timer.
            }
          }
        } finally {
          this.inflight = null
        }
      })
    }
    return this.inflight
  }

  stop(): void {
    this.stopped = true
    this.pending = false
    // The poller still owns its open I/O. Its post-await stop guards prevent
    // writes/emissions; retaining the promise lets existing callers drain it.
  }
}
