import { useEffect, useRef } from 'react'

import type { SessionId } from '@renderer/workspace/types'
import type { SessionRuntime } from '@renderer/session-runtime/state'

import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'

import { estimateFeedDebugLogBytes } from '@renderer/session-runtime/feedDebug'

import { countPendingFeedDebug, decideFeedDebugFlush } from './feedDebugFlushPolicy'

// Ship runtime feed-debug entries to the main process, batched by time
// (see feedDebugFlushPolicy.ts for the cadence and why). The main-side
// queue writes them to STATE_DIR/feed-debug/<sessionId>.jsonl.
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
  // Per-session pacing state. These are refs, not effect-local variables,
  // because the effect below re-runs on every runtimes replacement and a
  // timer armed in one pass must survive into the next; and they are not
  // WorkspaceRefs because nothing outside this hook reads them.
  const timersRef = useRef<Record<SessionId, ReturnType<typeof setTimeout>>>({})
  const lastAttemptAtRef = useRef<Record<SessionId, number>>({})

  // Unmount only: the pacing timers must NOT be torn down by the per-
  // replacement effect's cleanup, or every streamed delta would cancel and
  // re-arm them and the interval would never elapse under load.
  useEffect(() => () => {
    for (const timer of Object.values(timersRef.current)) clearTimeout(timer)
    timersRef.current = {}
  }, [])

  useEffect(() => {
    const send = (sessionId: SessionId, runtime: SessionRuntime): void => {
      const lastPersistedId = refs.persistedFeedDebugIdRef.current[sessionId] ?? 0
      const lastInFlightId = refs.inFlightFeedDebugIdRef.current[sessionId] ?? 0
      const batch = selectFeedDebugAppendBatch(runtime, lastPersistedId, lastInFlightId)
      if (!batch) return
      const { entries: pending, maxPendingId } = batch
      refs.inFlightFeedDebugIdRef.current[sessionId] = maxPendingId
      lastAttemptAtRef.current[sessionId] = Date.now()
      // Advance the durable cursor ONLY after the IPC append actually
      // resolves. A previous version advanced optimistically before
      // the write, so a transient failure (disk full, IPC timeout,
      // main-process not ready) marked entries as persisted and the
      // next effect pass skipped them forever. The in-flight cursor
      // above is the separate backpressure mechanism: it reserves the
      // pending id range while the IPC is unresolved, then this `.then`
      // makes that reservation durable once main confirms the append.
      //
      // Re-entrancy note: we allow only ONE unresolved append per
      // session, not just one append per id range. Sending a newer range
      // while an older range is unresolved would re-open a subtle
      // data-loss case: if the older disk write failed but the newer one
      // succeeded, advancing `persisted` to the newer id would make the
      // failed older entries look durable. Serializing at the renderer
      // keeps retry semantics simple. The success path re-runs the pacing
      // policy (which arms a timer rather than draining immediately), so
      // progress does not depend on a future React render either.
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
          consider(sessionId, refs.latestRuntimesRef.current[sessionId])
        })
        .catch(err => {
          if (refs.inFlightFeedDebugIdRef.current[sessionId] === maxPendingId) {
            delete refs.inFlightFeedDebugIdRef.current[sessionId]
          }
          // eslint-disable-next-line no-console
          console.warn(`[feed-debug ${sessionId.slice(0, 8)}] append failed`, err)
          // No immediate retry: `lastAttemptAt` was stamped at send time, so
          // the next replacement or timer pass waits out the interval.
        })
    }

    const consider = (sessionId: SessionId, runtime: SessionRuntime | undefined): void => {
      if (!runtime || runtime.feedDebugLog.length === 0) return
      const lastPersistedId = refs.persistedFeedDebugIdRef.current[sessionId] ?? 0
      const lastInFlightId = refs.inFlightFeedDebugIdRef.current[sessionId] ?? 0
      const pendingCount = countPendingFeedDebug(runtime.feedDebugLog, lastPersistedId)
      if (pendingCount === 0) return
      const decision = decideFeedDebugFlush({
        pendingCount,
        // The ring's per-entry byte estimate is cached per entry object, so
        // this is a cache-hit walk over the pending tail, not a stringify.
        pendingBytes: estimateFeedDebugLogBytes(runtime.feedDebugLog.slice(-pendingCount)),
        lastAttemptAt: lastAttemptAtRef.current[sessionId] ?? null,
        now: Date.now(),
        inFlight: lastInFlightId > lastPersistedId,
      })
      if (decision.kind === 'none') return
      if (decision.kind === 'now') {
        const timer = timersRef.current[sessionId]
        if (timer !== undefined) {
          clearTimeout(timer)
          delete timersRef.current[sessionId]
        }
        send(sessionId, runtime)
        return
      }
      // One timer per session; a later replacement inside the same interval
      // rides the timer that is already armed. The callback reads the latest
      // runtime from the ref, so it ships everything that arrived meanwhile.
      if (timersRef.current[sessionId] !== undefined) return
      timersRef.current[sessionId] = setTimeout(() => {
        delete timersRef.current[sessionId]
        consider(sessionId, refs.latestRuntimesRef.current[sessionId])
      }, decision.delayMs)
    }

    for (const [sessionId, runtime] of Object.entries(runtimes)) {
      consider(sessionId, runtime)
    }
  }, [
    refs.inFlightFeedDebugIdRef,
    refs.latestRuntimesRef,
    refs.persistedFeedDebugIdRef,
    runtimes,
  ])
}
