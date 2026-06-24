import { useEffect } from 'react'

import type { SessionId } from '@renderer/workspace/types'
import type { SessionRuntime } from '@renderer/workspace/workspaceState'

import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'

// Ship runtime feed-debug entries to the main process on every
// runtime update. The main-side queue writes them to
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

export function selectFeedDebugAppendBatch(
  runtime: SessionRuntime,
  lastPersistedId: number,
  lastInFlightId: number,
): FeedDebugAppendBatch | null {
  if (runtime.feedDebugLog.length === 0) return null
  if (lastInFlightId > lastPersistedId) return null
  const pending = runtime.feedDebugLog.filter(entry => entry.id > lastPersistedId)
  if (pending.length === 0) return null
  return {
    entries: pending,
    maxPendingId: pending[pending.length - 1]?.id ?? lastPersistedId,
  }
}

export function useFeedDebugPersist(
  runtimes: Record<SessionId, SessionRuntime>,
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
      // Re-entrancy note: the effect fires on every runtimes object
      // replacement, which can happen dozens of times per second while
      // a semantic stream is active. We allow only ONE unresolved
      // append per session, not just one append per id range. Sending
      // a newer range while an older range is unresolved would re-open
      // a subtle data-loss case: if the older disk write failed but
      // the newer one succeeded, advancing `persisted` to the newer id
      // would make the failed older entries look durable. Serializing
      // at the renderer keeps retry semantics simple; the success path
      // below immediately drains any entries that arrived while the IPC
      // was in flight, so the one-at-a-time rule does not rely on a
      // future React render to make progress.
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
          const latestRuntime = refs.latestRuntimesRef.current[sessionId]
          if (latestRuntime) {
            flushSession(sessionId, latestRuntime)
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

    for (const [sessionId, runtime] of Object.entries(runtimes)) {
      flushSession(sessionId, runtime)
    }
  }, [
    refs.inFlightFeedDebugIdRef,
    refs.latestRuntimesRef,
    refs.persistedFeedDebugIdRef,
    runtimes,
  ])
}
