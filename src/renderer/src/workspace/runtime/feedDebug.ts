import type {
  FeedDebugEntry,
  FeedDebugLayer,
  SessionRuntime,
} from '../workspaceState'

// Per-session feed-debug log — the runtime-side helper. Every
// mutation to SessionRuntime that crosses an interesting boundary
// (screen_update, process_state, submit, jsonl_entries, SEM, …)
// appends one entry here, capped at FEED_DEBUG_LOG_CAP. The
// FeedDebugPanel renders this in realtime; the same entries are
// shipped to main/storage/feedDebugLog.ts every tick to be written
// to disk (per-session JSONL under ~/.config/cc-shell/feed-debug/).
//
// Why cap the in-memory array: long-running sessions could
// accumulate tens of thousands of entries, bloating the runtime map
// and making FeedDebugPanel pointer-sluggish on scroll. The cap is
// renderer-side; main writes the full series to disk.

const FEED_DEBUG_LOG_CAP = 500

export type FeedDebugInput = {
  layer: FeedDebugLayer
  kind: string
  summary: string
  data?: unknown
}

/** Append a debug entry onto a SessionRuntime, capped at
 *  FEED_DEBUG_LOG_CAP. Returns a new runtime ref — reference equality
 *  against the input runtime signals "no-op" to upstream setRuntimes
 *  short-circuits. */
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
  const nextLog =
    current.feedDebugLog.length >= FEED_DEBUG_LOG_CAP
      ? [...current.feedDebugLog.slice(current.feedDebugLog.length - FEED_DEBUG_LOG_CAP + 1), nextEntry]
      : [...current.feedDebugLog, nextEntry]
  return {
    ...current,
    feedDebugEpochMs: epoch,
    feedDebugNextId: current.feedDebugNextId + 1,
    feedDebugLog: nextLog,
  }
}
