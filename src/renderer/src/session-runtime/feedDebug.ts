import type {
  FeedDebugEntry,
  FeedDebugLayer,
  SessionRuntime,
} from '@renderer/session-runtime/state'
import { estimateJsonBytes } from '@renderer/session-runtime/liveEntryWindow'

// Per-session feed-debug log — the runtime-side helper. Every
// mutation to SessionRuntime that crosses an interesting boundary
// (screen_update, process_state, submit, jsonl_entries, SEM, …)
// appends one entry here, capped at FEED_DEBUG_LOG_CAP entries AND
// FEED_DEBUG_LOG_MAX_BYTES. The FeedDebugPanel renders this in realtime;
// the same entries are shipped to main/storage/feedDebugLog.ts every tick
// to be written to disk (per-session JSONL under STATE_DIR/feed-debug/).
//
// Why cap the in-memory array: long-running sessions could
// accumulate tens of thousands of entries, bloating the runtime map
// and making FeedDebugPanel pointer-sluggish on scroll. The cap is
// renderer-side. Main writes entries it receives to disk, but that durability
// path depends on the persistence hook's outgoing queue staying ahead of this
// UI ring; a larger UI cap is not a substitute for a separate durable buffer.

const FEED_DEBUG_LOG_CAP = 500

// WHY a byte budget on top of the count cap (#722): entries range from a
// one-line summary to Feed's `visible_rows` record, whose `data.rows` holds
// one object per feed item and is emitted on every rendered-row change. For
// a feed of a couple thousand entries that is hundreds of KB per record, and
// 500 of them held one session's ring at 136 MB on the 2026-09-01 → 09-03
// run — five times the size of that session's live transcript window, for a
// diagnostic that is always on. A count cap alone cannot bound that; this
// is the same lesson MAX_LIVE_ENTRY_BYTES (#375) already applied to the
// entry window. 4 MiB is generous for small records (500 × a few hundred
// bytes never gets near it) and only bites when payloads are large, which is
// exactly the case that needs bounding. Disk persistence is best-effort (one
// in-flight append batch per session; entries evicted before it resolves are
// never written — see useFeedDebugPersist), and the byte budget narrows that
// loss window for large records. The ring exists for the live panel, not for
// durability; a durable buffer is a separate concern (see the header).
export const FEED_DEBUG_LOG_MAX_BYTES = 4 * 1024 * 1024

// A real entry always serialises to at least its id/ts/summary envelope, so a
// zero estimate means estimateJsonBytes gave up (cyclic or BigInt payload).
// Charge such an entry a conservative floor instead of letting it ride free
// under the budget — an unbounded payload that cannot be measured is exactly
// the shape the budget must not ignore.
const UNMEASURABLE_ENTRY_BYTES = 64 * 1024

export type FeedDebugInput = {
  layer: FeedDebugLayer
  kind: string
  summary: string
  data?: unknown
}

// WHY a WeakMap rather than a running total on the runtime: the same
// argument as liveEntryWindow's entryBytesCache — a running total needs
// decrement bookkeeping at every eviction site to stay honest, while a
// per-object cache is correct by construction (entries are never mutated
// after append) and is freed with the entry. Each entry is stringified once
// in its lifetime; the per-append budget check is a ≤500-element cache-hit
// walk.
const entryBytesCache = new WeakMap<FeedDebugEntry, number>()

function feedDebugEntryBytes(entry: FeedDebugEntry): number {
  let bytes = entryBytesCache.get(entry)
  if (bytes === undefined) {
    bytes = estimateJsonBytes(entry) || UNMEASURABLE_ENTRY_BYTES
    entryBytesCache.set(entry, bytes)
  }
  return bytes
}

/** Estimated JSON bytes of a feed-debug ring (cache-hit walk). Used by the
 *  append path, the renderer.session.memory.feedDebugLog gauge, and tests. */
export function estimateFeedDebugLogBytes(log: readonly FeedDebugEntry[]): number {
  let total = 0
  for (const entry of log) total += feedDebugEntryBytes(entry)
  return total
}

// Evict from the head until the ring fits the byte budget. The newest entry
// is never evicted, even when it alone exceeds the budget: a single
// oversized record must not blank the panel. It is the first thing the NEXT
// append evicts, so an oversized record never occupies the ring for longer
// than one append.
function trimFeedDebugLogToBudget(log: FeedDebugEntry[]): FeedDebugEntry[] {
  let total = estimateFeedDebugLogBytes(log)
  if (total <= FEED_DEBUG_LOG_MAX_BYTES) return log
  let start = 0
  while (start < log.length - 1 && total > FEED_DEBUG_LOG_MAX_BYTES) {
    total -= feedDebugEntryBytes(log[start]!)
    start += 1
  }
  return start === 0 ? log : log.slice(start)
}

/** Append a debug entry onto a SessionRuntime, capped at
 *  FEED_DEBUG_LOG_CAP entries and FEED_DEBUG_LOG_MAX_BYTES. Returns a new
 *  runtime ref — reference equality against the input runtime signals
 *  "no-op" to upstream setRuntimes short-circuits. */
export function appendFeedDebugLog(
  current: SessionRuntime,
  input: FeedDebugInput,
): SessionRuntime {
  const ts = Date.now()
  const epoch = current.feedDebugEpochMs ?? ts
  const nextEntry: FeedDebugEntry = {
    id: current.feedDebugNextId,
    ts,
    tMs: ts - epoch,
    layer: input.layer,
    kind: input.kind,
    summary: input.summary,
    data: input.data,
  }
  const nextLog = trimFeedDebugLogToBudget(
    current.feedDebugLog.length >= FEED_DEBUG_LOG_CAP
      ? [...current.feedDebugLog.slice(current.feedDebugLog.length - FEED_DEBUG_LOG_CAP + 1), nextEntry]
      : [...current.feedDebugLog, nextEntry],
  )
  return {
    ...current,
    feedDebugEpochMs: epoch,
    feedDebugNextId: current.feedDebugNextId + 1,
    feedDebugLog: nextLog,
  }
}
