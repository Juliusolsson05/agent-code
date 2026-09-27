import { useEffect, useRef } from 'react'

import type { SessionId } from '@renderer/workspace/types'
import type { SessionRuntime } from '@renderer/session-runtime/state'

import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'
import { useAppStore } from '@renderer/app-state/hooks'
import { useDevDebugConfig } from '@renderer/features/debug/devDebugConfig'

// Ship runtime feed-debug entries on a fixed cadence, when persistence is enabled (see
// useFeedDebugPersistenceEnabled). The main-side queue writes them to
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
  /** Which generation of ids this batch belongs to (#770). Main keys its
   *  de-dup cursor on it, so a soft reload's restart at id 1 is written
   *  instead of being filtered as already-seen. */
  epochMs: number | null
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
    epochMs: runtime.feedDebugEpochMs,
  }
}

/**
 * Whether the session is still in the id generation a batch was cut from.
 *
 * WHY the settle handlers ask (#770 follow-up): a soft reload restarts ids at
 * 1 and deletes both cursors, but an append from the OLD generation can still
 * be in flight. When it settles afterwards, `maxPendingId` is an id from the
 * old numbering — writing it into the persisted cursor makes every new entry
 * at or below it look already written, which is #770's silent loss reopened
 * by timing. The epoch is the generation's identity (minted with the first
 * entry, re-minted after a reload), so a stale settle is recognised by it and
 * dropped. Dropping is safe: main keyed that write on the old epoch, and the
 * new generation's entries are sent on their own.
 *
 * A null current epoch means the reload has happened but the new generation
 * has no entries yet — still not the batch's generation.
 */
function isSameGeneration(refs: WorkspaceRefs, sessionId: SessionId, epochMs: number | null): boolean {
  return (refs.latestRuntimesRef.current[sessionId]?.feedDebugEpochMs ?? null) === epochMs
}

/**
 * Whether the feed-debug ring is also written to disk (#767 item 1).
 *
 * WHY off unless diagnostics were asked for: this ran for every session in every build, one IPC
 * and one append per second, up to 128 MiB per session file and 22 % of the debug budget, with no
 * switch at all. The ring itself keeps recording regardless — Save Debug Logs and the Feed Debug
 * panel read the in-memory ring (saveDebugBundle `runtime.feedDebugLog`), not this file — so what
 * the default loses is only the after-crash copy. Either existing switch turns it on:
 * AGENT_CODE_DEV_DEBUG=1 (the developer diagnostics switch) or the "aggressive debug persistence"
 * setting ("keep more debug data on disk"). Turning it on mid-session persists the ring's retained
 * tail on the next tick, since the cursors start at zero.
 */
export function useFeedDebugPersistenceEnabled(): boolean {
  const devDebug = useDevDebugConfig(state => state.enabled)
  const aggressive = useAppStore(state => state.settings.aggressiveDebugPersistence)
  return devDebug || aggressive === true
}

export function useFeedDebugPersist(refs: WorkspaceRefs): void {
  const enabled = useFeedDebugPersistenceEnabled()
  // The CURRENT switch, read by the cleanup below. The cleanup runs both on unmount and when
  // `enabled` flips to false; only the first may flush (review of #1349: turning persistence off
  // still wrote one last batch to disk).
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled
  // The release bookkeeping (see releaseGone) lives in a ref, not in the
  // effect: the effect re-runs whenever persistence is switched on or off,
  // and a set recreated there forgot every id it was tracking, so a pane
  // closed across a persistence toggle was never released (#1392 review c).
  const releaseStateRef = useRef({
    known: new Set<SessionId>(),
    releasing: new Set<SessionId>(),
    seenSinceRelease: new Set<SessionId>(),
  })
  useEffect(() => {
    const flushSession = (sessionId: SessionId, runtime: SessionRuntime): void => {
      if (runtime.feedDebugLog.length === 0) return
      const lastPersistedId = refs.persistedFeedDebugIdRef.current[sessionId] ?? 0
      const lastInFlightId = refs.inFlightFeedDebugIdRef.current[sessionId] ?? 0
      const batch = selectFeedDebugAppendBatch(runtime, lastPersistedId, lastInFlightId)
      if (!batch) return
      const { entries: pending, maxPendingId, epochMs } = batch
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
          ...(epochMs === null ? {} : { epochMs }),
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
          if (!isSameGeneration(refs, sessionId, epochMs)) return
          refs.persistedFeedDebugIdRef.current[sessionId] = maxPendingId
          if (refs.inFlightFeedDebugIdRef.current[sessionId] === maxPendingId) {
            delete refs.inFlightFeedDebugIdRef.current[sessionId]
          }
        })
        .catch(err => {
          if (
            isSameGeneration(refs, sessionId, epochMs)
            && refs.inFlightFeedDebugIdRef.current[sessionId] === maxPendingId
          ) {
            delete refs.inFlightFeedDebugIdRef.current[sessionId]
          }
          // eslint-disable-next-line no-console
          console.warn(`[feed-debug ${sessionId.slice(0, 8)}] append failed`, err)
        })
    }

    // Sessions this hook has seen a runtime for. A session whose runtime is
    // gone (pane closed, or replaced by a new id) can never append again, so
    // it is released here: its flush cursors, and main's per-session state
    // (#1392). Main's own forget runs at PROCESS exit, but the pane outlives
    // the process (exit rows, a same-id wake) and its later appends
    // re-created that state with nothing left to forget it.
    //
    // Entries not yet flushed when the runtime was removed are lost, as they
    // were before: this changes only what is forgotten, not what is written.
    //
    // An id leaves `known` only once main has ACKNOWLEDGED the release: a
    // failed IPC is retried on the next tick (#1392 review a, round 3), or
    // main would keep that session's state until the process exits.
    // `releasing` stops a slow acknowledgement from sending it twice.
    //
    // A release covers only the lifetime it was SENT for (#1392 review b,
    // round 4): if the id reappears (and appends, re-creating main's state)
    // while an acknowledgement is still in flight, that late ACK must not
    // retire the later lifetime. `seenSinceRelease` records a reappearance;
    // the ACK then leaves the id in `known`, and the next absence sends a new
    // release.
    //
    // Releasing keeps running while persistence is OFF (#767): a session that
    // appended while persistence was on still has state in main after the
    // user switches persistence off (#1392 review c). The release then tells
    // main not to persist unmarked drops, so it causes no disk write either
    // (review c, round 2).
    //
    // Known residual: a release that fails during the hook's own teardown
    // (workspace unmount) has no later tick to retry it. Main keeps that one
    // session's few numbers until it exits.
    const { known, releasing, seenSinceRelease } = releaseStateRef.current
    const releaseGone = (): void => {
      const runtimes = refs.latestRuntimesRef.current
      for (const sessionId of known) {
        if (runtimes[sessionId] || releasing.has(sessionId)) continue
        delete refs.persistedFeedDebugIdRef.current[sessionId]
        delete refs.inFlightFeedDebugIdRef.current[sessionId]
        releasing.add(sessionId)
        seenSinceRelease.delete(sessionId)
        // Promise.resolve().then: a synchronous throw (a test double without
        // the method) becomes a rejection, retried like any failed release,
        // instead of escaping the interval with `releasing` held.
        void Promise.resolve()
          // Off means no disk writes, including main's final drop marker
          // (#1392 review c, round 2); read at send time, not effect time.
          .then(() => window.api.forgetFeedDebugLog({ sessionId, persistUnmarkedDrops: enabledRef.current }))
          .then(() => { if (!seenSinceRelease.has(sessionId)) known.delete(sessionId) }, () => {})
          .finally(() => releasing.delete(sessionId))
      }
    }

    const flush = (): void => {
      for (const [sessionId, runtime] of Object.entries(refs.latestRuntimesRef.current)) {
        known.add(sessionId)
        if (releasing.has(sessionId)) seenSinceRelease.add(sessionId)
        // Disk writes only while persistence is on; releases always.
        if (enabled) flushSession(sessionId, runtime)
      }
      releaseGone()
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
      // Not when persistence was just switched off: the user asked for no
      // more disk writes.
      if (enabledRef.current) flush()
      else releaseGone()
    }
  }, [
    enabled,
    refs.inFlightFeedDebugIdRef,
    refs.latestRuntimesRef,
    refs.persistedFeedDebugIdRef,
  ])
}
