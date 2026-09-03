// When to ship pending feed-debug entries to main (#748).
//
// WHY a policy at all: `useFeedDebugPersist` runs on every `runtimes`
// replacement, which happens dozens of times per second while a turn
// streams. Flushing whenever there is something pending made the append
// cadence follow the streaming cadence — 8,649–10,159 `debug:append-feed-log`
// invokes in a 77-minute run, 20/s in bursts, each one a `writeFile(flag:'a')`
// and a retention-prune schedule on the main thread (p95 352 ms, max 1.2 s on
// the Sep 1 run). The entries are diagnostics; nothing reads them within a
// second of being written. Batching them by time turns that into ≤ 1 append
// per session per interval without touching the cursors that carry the
// retry/durability semantics.
//
// WHY the first batch after a quiet period goes out immediately: the entry
// that explains a bad paint is usually the first one after silence, and a
// "Save Debug Logs" right after seeing it should find it on disk. The timer
// only paces what FOLLOWS a flush.
//
// WHY two ceilings, count AND bytes: the ring is byte-capped at 4 MiB (#722)
// and evicts from the head, so an entry that waits on the timer can be
// evicted before it is ever persisted — a loss the immediate-flush version
// could only suffer during one in-flight append. Count alone does not bound
// that: the #722 shape is a few hundred KB per `visible_rows` entry, where
// twenty entries already exceed the ring. A byte ceiling at a quarter of the
// ring forces the flush long before eviction can reach unpersisted entries
// at any realistic rate, and keeps one append from carrying a
// multi-megabyte batch.
//
// WHY `lastAttemptAt` and not `lastSuccessAt`: a rejected append (main not
// ready, disk full) must not turn the streaming cadence back into a retry
// storm. Counting the failed attempt as a flush rate-limits retries to the
// same interval; the entries stay pending because the persisted cursor only
// advances on success.

export const FEED_DEBUG_FLUSH_INTERVAL_MS = 1_500
export const FEED_DEBUG_FLUSH_MAX_PENDING = 256
export const FEED_DEBUG_FLUSH_MAX_PENDING_BYTES = 1024 * 1024

export type FeedDebugFlushDecision =
  | { kind: 'now' }
  | { kind: 'wait'; delayMs: number }
  | { kind: 'none' }

export type FeedDebugFlushInput = {
  pendingCount: number
  /** Estimated JSON bytes of the pending entries (the ring's own estimate). */
  pendingBytes: number
  /** Epoch ms of the last append attempt for this session, or null. */
  lastAttemptAt: number | null
  now: number
  /** An append IPC is unresolved; the resolve path re-runs the policy. */
  inFlight: boolean
  intervalMs?: number
  maxPending?: number
  maxPendingBytes?: number
}

export function decideFeedDebugFlush(input: FeedDebugFlushInput): FeedDebugFlushDecision {
  const intervalMs = input.intervalMs ?? FEED_DEBUG_FLUSH_INTERVAL_MS
  const maxPending = input.maxPending ?? FEED_DEBUG_FLUSH_MAX_PENDING
  const maxPendingBytes = input.maxPendingBytes ?? FEED_DEBUG_FLUSH_MAX_PENDING_BYTES
  if (input.pendingCount <= 0) return { kind: 'none' }
  if (input.inFlight) return { kind: 'none' }
  if (input.pendingCount >= maxPending) return { kind: 'now' }
  if (input.pendingBytes >= maxPendingBytes) return { kind: 'now' }
  if (input.lastAttemptAt === null) return { kind: 'now' }
  const elapsed = input.now - input.lastAttemptAt
  if (elapsed >= intervalMs) return { kind: 'now' }
  return { kind: 'wait', delayMs: intervalMs - elapsed }
}

/** Entries with id > lastPersistedId. Ids are assigned in append order, so
 *  scanning from the tail stops at the first persisted entry — O(pending),
 *  not O(ring) — which matters because this runs per runtimes replacement. */
export function countPendingFeedDebug(
  log: ReadonlyArray<{ id: number }>,
  lastPersistedId: number,
): number {
  let count = 0
  for (let i = log.length - 1; i >= 0; i -= 1) {
    if (log[i]!.id <= lastPersistedId) break
    count += 1
  }
  return count
}
