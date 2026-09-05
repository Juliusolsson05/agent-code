import { useEffect } from 'react'

import type { SessionId } from '@renderer/workspace/types'
import type { SessionRuntime } from '@renderer/session-runtime/state'

import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'

// Ship runtime feed-debug entries on a fixed cadence. The main-side queue writes them to
// STATE_DIR/feed-debug/<sessionId>.jsonl.
//
// `persistedFeedDebugIdRef` tracks the largest feed-debug entry id
// main has confirmed as written. `inFlightFeedDebugIdRef` tracks the
// largest id currently reserved by an unresolved append IPC. We need
// both cursors: persisted-only preserves retry-on-failure, but it
// leaves the same pending entries visible to every render while the
// IPC is still waiting on main-side disk work; in-flight-only would
// suppress retries after a failure. The pair gives us backpressure
// without weakening durability.

export type FeedDebugAppendBatch = {
  entries: SessionRuntime['feedDebugLog']
  maxPendingId: number
}

export const FEED_DEBUG_FLUSH_INTERVAL_MS = 1000

export function selectFeedDebugAppendBatch(
  runtime: SessionRuntime,
  lastPersistedId: number,
  lastInFlightId: number,
): FeedDebugAppendBatch | null {
  if (runtime.feedDebugLog.length === 0) return null
  if (lastInFlightId > lastPersistedId) return null
  // Most sessions are quiet on any given tick. Their monotonic tail id proves
  // that there is nothing to persist without scanning up to 500 retained rows.
  if (runtime.feedDebugLog[runtime.feedDebugLog.length - 1]!.id <= lastPersistedId) return null
  const pending = runtime.feedDebugLog.filter(entry => entry.id > lastPersistedId)
  if (pending.length === 0) return null
  return {
    entries: pending,
    maxPendingId: pending[pending.length - 1]?.id ?? lastPersistedId,
  }
}

export function useFeedDebugPersist(
  _runtimes: Record<SessionId, SessionRuntime>,
  refs: WorkspaceRefs,
): void {
  useEffect(() => {
    const flushSession = (sessionId: SessionId, runtime: SessionRuntime): void => {
      if (runtime.feedDebugLog.length === 0) return
      const lastPersistedId = refs.persistedFeedDebugIdRef.current[sessionId] ?? 0
      const lastInFlightId = refs.inFlightFeedDebugIdRef.current[sessionId] ?? 0
      const batch = selectFeedDebugAppendBatch(runtime, lastPersistedId, lastInFlightId)
      if (!batch) return
      const { entries: pending, maxPendingId } = batch
      refs.inFlightFeedDebugIdRef.current[sessionId] = maxPendingId
      // Advance the durable cursor ONLY after the IPC append actually
      // resolves. A previous version advanced optimistically before
      // the write, so a transient failure (disk full, IPC timeout,
      // main-process not ready) marked entries as persisted and the
      // next effect pass skipped them forever. The in-flight cursor
      // above is the separate backpressure mechanism: it reserves the
      // pending id range while the IPC is unresolved, then this `.then`
      // makes that reservation durable once main confirms the append.
      //
      // Re-entrancy note: slow disk work can outlive multiple timer ticks
      // and a workspace teardown. We allow only ONE unresolved
      // append per session, not just one append per id range. Sending
      // a newer range while an older range is unresolved would re-open
      // a subtle data-loss case: if the older disk write failed but
      // the newer one succeeded, advancing `persisted` to the newer id
      // would make the failed older entries look durable. Serializing
      // at the renderer keeps retry semantics simple. The NEXT TIMER tick
      // picks up newer entries: immediately draining from `.then` recreates
      // one IPC/write per streaming update whenever disk keeps up. Failures
      // also wait for that tick, so a broken disk cannot cause a retry storm.
      void window.api
        .appendFeedDebugLog({
          sessionId,
          entries: pending.map(entry => ({
            id: entry.id,
            ts: entry.ts,
            tMs: entry.tMs,
            layer: entry.layer,
            kind: entry.kind,
            summary: entry.summary,
            data: entry.data,
          })),
        })
        .then(() => {
          refs.persistedFeedDebugIdRef.current[sessionId] = maxPendingId
          if (refs.inFlightFeedDebugIdRef.current[sessionId] === maxPendingId) {
            delete refs.inFlightFeedDebugIdRef.current[sessionId]
          }
        })
        .catch(err => {
          if (refs.inFlightFeedDebugIdRef.current[sessionId] === maxPendingId) {
            delete refs.inFlightFeedDebugIdRef.current[sessionId]
          }
          // eslint-disable-next-line no-console
          console.warn(`[feed-debug ${sessionId.slice(0, 8)}] append failed`, err)
        })
    }

    const flush = (): void => {
      for (const [sessionId, runtime] of Object.entries(refs.latestRuntimesRef.current)) {
        flushSession(sessionId, runtime)
      }
    }

    // WHY an interval independent of runtimes: busy agents replace that map
    // dozens of times per second. An effect-triggered flush costs one IPC and
    // filesystem append each time; a debounced effect can instead starve until
    // the stream stops. A fixed timer reads current refs and provides both a
    // write-rate bound and progress for the final record after a quiet turn.
    // The ring is best-effort diagnostics, so accepting up to one additional
    // second of loss on abrupt crash is preferable to slowing provider input.
    const timer = window.setInterval(flush, FEED_DEBUG_FLUSH_INTERVAL_MS)
    return () => {
      window.clearInterval(timer)
      // Best effort for ordinary workspace teardown. Existing in-flight writes
      // retain their cursor reservation; never race them with a final batch.
      flush()
    }
  }, [
    refs.inFlightFeedDebugIdRef,
    refs.latestRuntimesRef,
    refs.persistedFeedDebugIdRef,
  ])
}
