import { useEffect, useRef } from 'react'

import type { SessionId } from '@renderer/workspace/types'
import type { SessionRuntime } from '@renderer/session-runtime/state'

import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'

import { estimateFeedDebugLogBytes } from '@renderer/session-runtime/feedDebug'

import { countPendingFeedDebug, decideFeedDebugFlush, FEED_DEBUG_FLUSH_INTERVAL_MS } from './feedDebugFlushPolicy'

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
  // WHY removed sessions get a final, unpaced flush (review of #750): a
  // session leaves `runtimes` on replacement, pane close, tab kill and
  // reload, and its LAST entries — the exit code, the kill reason — are the
  // ones written in the final second. With pacing alone those entries sat
  // on a timer that found no runtime when it fired and were never written;
  // the pre-pacing hook shipped them from the same effect pass that
  // appended them. Removal is one append per session, so it bypasses the
  // cadence entirely. If an append for that session is still in flight the
  // final runtime is parked here and flushed when it resolves.
  const previousRuntimesRef = useRef<Record<SessionId, SessionRuntime>>({})
  const finalRuntimesRef = useRef<Record<SessionId, SessionRuntime>>({})
  // Stamp of the last FINAL-branch send per removed session. The live
  // path's `lastAttemptAtRef` cannot answer "is this final flush a
  // retry": the batch that preceded removal is typically only
  // milliseconds old, and keying the final flush off it would delay a
  // session's trailing entries (exit code, kill reason) by up to one
  // interval — the loss this branch exists to prevent. Only attempts the
  // final branch itself made count as retries.
  const finalAttemptAtRef = useRef<Record<SessionId, number>>({})
  const unmountedRef = useRef(false)

  // Unmount only: the pacing timers must NOT be torn down by the per-
  // replacement effect's cleanup, or every streamed delta would cancel and
  // re-arm them and the interval would never elapse under load. Anything
  // still pending at unmount (window close) is lost — an `invoke` cannot be
  // awaited past teardown — which is the one loss this hook accepts.
  // The body re-arms the flag because React 18 StrictMode double-mounts in
  // dev: effect → cleanup(true) → effect again. Without the reset every
  // post-remount .then/.catch would bail forever and pacing would only
  // recover on the next lucky render. Production never remounts, so this
  // is dev-only correctness — but it is also free.
  useEffect(() => {
    unmountedRef.current = false
    return () => {
      unmountedRef.current = true
      for (const timer of Object.values(timersRef.current)) clearTimeout(timer)
      timersRef.current = {}
    }
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
          if (unmountedRef.current) return
          consider(sessionId, refs.latestRuntimesRef.current[sessionId])
        })
        .catch(err => {
          if (refs.inFlightFeedDebugIdRef.current[sessionId] === maxPendingId) {
            delete refs.inFlightFeedDebugIdRef.current[sessionId]
          }
          // eslint-disable-next-line no-console
          console.warn(`[feed-debug ${sessionId.slice(0, 8)}] append failed`, err)
          if (unmountedRef.current) return
          // Re-run the policy so an idle session retries after the interval
          // without waiting for another runtimes replacement; `lastAttemptAt`
          // was stamped at send time, so this arms a timer, never a storm.
          consider(sessionId, refs.latestRuntimesRef.current[sessionId])
        })
    }

    const forget = (sessionId: SessionId): void => {
      const timer = timersRef.current[sessionId]
      if (timer !== undefined) {
        clearTimeout(timer)
        delete timersRef.current[sessionId]
      }
      delete lastAttemptAtRef.current[sessionId]
      delete finalRuntimesRef.current[sessionId]
      delete finalAttemptAtRef.current[sessionId]
    }

    const consider = (sessionId: SessionId, runtime: SessionRuntime | undefined): void => {
      const lastPersistedId = refs.persistedFeedDebugIdRef.current[sessionId] ?? 0
      const lastInFlightId = refs.inFlightFeedDebugIdRef.current[sessionId] ?? 0
      const inFlight = lastInFlightId > lastPersistedId
      // A session that has left `runtimes`: flush whatever its final
      // snapshot still holds, then drop its bookkeeping.
      const final = runtime === undefined ? finalRuntimesRef.current[sessionId] : undefined
      if (final !== undefined) {
        if (inFlight) return
        const remaining = countPendingFeedDebug(final.feedDebugLog, lastPersistedId)
        if (remaining > 0) {
          // WHY retries (but not the first flush) are paced here — review
          // blocker on this PR: the rejection path below re-invokes
          // consider() with the session already gone from
          // latestRuntimesRef, which lands HERE again. Unpaced, a
          // persistently failing append (disk full, EACCES at close time,
          // main rejecting the shape) became a tight loop of one IPC round
          // trip + one console.warn per microtask — the exact retry storm
          // this PR exists to kill, resurrected on the removal path. The
          // FIRST final flush stays immediate (removal is one append per
          // session, not a stream); only attempts the final branch itself
          // made inside the interval wait, via the same per-session timer
          // the live path uses. That timer's callback reads
          // latestRuntimesRef, which is undefined for a removed session
          // and therefore routes back into this branch.
          const finalAttemptAt = finalAttemptAtRef.current[sessionId]
          if (finalAttemptAt !== undefined) {
            const elapsed = Date.now() - finalAttemptAt
            if (elapsed < FEED_DEBUG_FLUSH_INTERVAL_MS) {
              if (timersRef.current[sessionId] !== undefined) return
              timersRef.current[sessionId] = setTimeout(() => {
                delete timersRef.current[sessionId]
                consider(sessionId, refs.latestRuntimesRef.current[sessionId])
              }, FEED_DEBUG_FLUSH_INTERVAL_MS - elapsed)
              return
            }
          }
          finalAttemptAtRef.current[sessionId] = Date.now()
          send(sessionId, final)
          return
        }
        forget(sessionId)
        return
      }
      if (!runtime || runtime.feedDebugLog.length === 0) return
      const pendingCount = countPendingFeedDebug(runtime.feedDebugLog, lastPersistedId)
      if (pendingCount === 0) return
      const decision = decideFeedDebugFlush({
        pendingCount,
        // The ring's per-entry byte estimate is cached per entry object, so
        // this is a cache-hit walk over the pending tail, not a stringify.
        pendingBytes: estimateFeedDebugLogBytes(runtime.feedDebugLog.slice(-pendingCount)),
        lastAttemptAt: lastAttemptAtRef.current[sessionId] ?? null,
        now: Date.now(),
        inFlight,
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

    // Sessions that left the map since the last pass get their final flush
    // (see finalRuntimesRef); everything else goes through the policy.
    const previous = previousRuntimesRef.current
    previousRuntimesRef.current = runtimes
    for (const [sessionId, runtime] of Object.entries(previous)) {
      if (sessionId in runtimes) continue
      finalRuntimesRef.current[sessionId] = runtime
      consider(sessionId, undefined)
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
