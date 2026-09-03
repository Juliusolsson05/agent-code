// Parent-completion bookkeeping for sub-agents (#743).
//
// WHY this exists: the sub-agent watcher flips a sidecar agent to done/error
// by asking "did the PARENT transcript record a tool_result for this Agent
// tool_use id?". The parent's jsonl stream carries a tool_result for EVERY
// tool call — Read, Bash, Edit, Grep — and the previous bookkeeping kept all
// of them in one map for the life of the session: tens of thousands of
// entries in a long session, never consulted for anything but the handful of
// ids that belong to sub-agents. That is the #288 shape (retain everything,
// consume a sliver) in a sibling structure.
//
// WHY two tiers: a result can land BEFORE the watcher has discovered the
// sidecar file (it polls the subagents dir), so an unbounded "only record
// Agent ids" filter is not available at record time — the parent entry does
// not say which tool a result belongs to. A bounded recent window covers that
// race by orders of magnitude (the poll is seconds; 2,048 results is minutes
// of the busiest session). Once the watcher has looked an id up it is
// promoted to `claimed`, which is bounded by the number of sub-agents the
// session ever had and is never evicted: the watcher recomputes done/error
// from `lookup` on every emit, so an evicted-after-claim id would make a
// finished sub-agent flip back to "running".

export type ParentStatus = 'done' | 'error'

const DEFAULT_RECENT_CAP = 2048

export class CompletionLedger {
  // Insertion order doubles as LRU order; re-inserted on record.
  private readonly recent = new Map<string, ParentStatus>()
  private readonly claimed = new Map<string, ParentStatus>()

  constructor(private readonly recentCap: number = DEFAULT_RECENT_CAP) {
    if (!(recentCap > 0)) throw new RangeError(`CompletionLedger recentCap must be positive, got ${recentCap}`)
  }

  /** Record a parent tool_result. Returns whether anything changed — the
   *  caller nudges the watcher to re-emit only then. */
  record(toolUseId: string, status: ParentStatus): boolean {
    const claimedStatus = this.claimed.get(toolUseId)
    if (claimedStatus !== undefined) {
      if (claimedStatus === status) return false
      this.claimed.set(toolUseId, status)
      return true
    }
    const previous = this.recent.get(toolUseId)
    if (previous !== undefined) this.recent.delete(toolUseId)
    this.recent.set(toolUseId, status)
    while (this.recent.size > this.recentCap) {
      const oldest = this.recent.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.recent.delete(oldest)
    }
    return previous !== status
  }

  /** The watcher's question. A hit in the recent window is promoted to the
   *  claimed tier so it can never be evicted afterwards. */
  lookup(toolUseId: string): ParentStatus | undefined {
    const claimedStatus = this.claimed.get(toolUseId)
    if (claimedStatus !== undefined) return claimedStatus
    const status = this.recent.get(toolUseId)
    if (status === undefined) return undefined
    this.recent.delete(toolUseId)
    this.claimed.set(toolUseId, status)
    return status
  }

  /** Diagnostics / tests. */
  get recentSize(): number {
    return this.recent.size
  }

  get claimedSize(): number {
    return this.claimed.size
  }
}
