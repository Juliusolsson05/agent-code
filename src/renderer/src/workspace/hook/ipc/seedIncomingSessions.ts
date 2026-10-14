import type { SessionBackendSnapshot } from '@shared/types/session'
import { emptyRuntime } from '@renderer/session-runtime/state'
import type { SessionRuntime } from '@renderer/session-runtime/state'
import type { SessionId, SessionMeta } from '@renderer/workspace/types'
import { seedResumedRuntimeFields } from '@renderer/workspace/providerSessionIdentity'
import { loadInitialHistoryForSession } from '@renderer/workspace/hook/actions/initialHistory'
import type { WorkspaceSetRuntimes } from '@renderer/workspace/hook/context'
import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'

// Seeding a window's view of sessions that are ALREADY ALIVE and already
// routed to it: a closed window's workspace being adopted, or agents another
// live window moved here (#1481).
//
// WHY one module for both: until #1481 this lived inline in
// useWorkspaceAdoption. A move needs exactly the same three steps (snapshot
// before paint, runtime for every session, condition re-seed after the seed,
// history only for live backends), and every one of them was a bug fix with a
// regression test behind it (#895, #1083). A second copy would have to rediscover
// each of those fixes; one copy keeps them in force for both paths.
//
// WHY the adopted sessions are seeded from a backend snapshot instead of going
// through `recoverSession` the way bootstrap does:
//
// There is nothing to recover. `recover()` exists to reconcile a persisted id
// with a backend that may or may not still exist after an app restart — it can
// adopt, spawn, or fail. Here every backend is alive, healthy, and already
// owned by main; the only thing missing is this renderer's view of it. Calling
// `recover` would take a generation fence, an ownership claim, and a 30-second
// deadline to establish something we already know. What we DO need from main is
// the readiness snapshot, because `setInputReadiness` dedupes on
// `(ready, reason)` — a healthy agent already sitting at `ready: true` emits
// nothing further to a renderer that just started watching it, so without the
// snapshot every adopted pane would sit on "starting agent" forever and its
// first send would detour through a full recovery round trip.

/**
 * A backend snapshot per adopted session, or null where there is no backend.
 *
 * Parked (detached) and buried sessions deliberately have no process — that is
 * the whole point of the live-vs-owned split in `sessionOwnership.ts` — so a
 * null here is the normal case for them, not a failure.
 */
export type AdoptedSnapshots = Map<SessionId, SessionBackendSnapshot | null>

export function seedAdoptedRuntime(
  previous: SessionRuntime | undefined,
  meta: SessionMeta | undefined,
  snapshot: SessionBackendSnapshot | null,
  draft: string | undefined,
): SessionRuntime {
  const base: SessionRuntime = {
    ...emptyRuntime(),
    ...seedResumedRuntimeFields(previous, meta),
    ...(draft ? { draftInput: draft } : {}),
  }
  if (!snapshot) {
    // No backend: a parked or buried agent. `seedResumedRuntimeFields` reports
    // `started`, which would be a lie about a session that has no process, and
    // would make the row claim it is running. Idle is what rehydrate leaves
    // hibernated sessions in.
    return { ...base, processStatus: 'idle' }
  }
  // Same authority rule as rehydrate: a snapshot older than what this runtime
  // has already observed must not roll readiness backwards.
  const snapshotIsAuthoritative = snapshot.input.revision >= base.inputReadinessRevision
  // WHY an exit observed during the fetch survives it (#1083 review, finding
  // 2): routing moves to this window BEFORE the offer arrives, so the live
  // channel can write `exited` while `getBackendSnapshot` is still in flight.
  // The reply was computed while the backend was alive; applying it blindly
  // repaints a dead agent as `started` with an enabled composer. Both sibling
  // seed sites already guard this (`rehydrate.ts`, `session.ts`); adoption did
  // not, and only `conditions` had been defended.
  const observedTerminalProcess =
    (previous?.processStatus === 'failed' || previous?.processStatus === 'exited') &&
    previous.recoveryFailureCode === null
  if (observedTerminalProcess) {
    // `base` starts from `emptyRuntime()`, so returning it would erase the
    // very thing being preserved. The observed end state is carried over
    // whole; `recoveryFailureCode` is already null by the condition above.
    return {
      ...base,
      processStatus: previous.processStatus,
      processError: previous.processError,
      exited: previous.exited,
      recoveryFailureCode: null,
    }
  }
  const seeded: SessionRuntime = {
    ...base,
    processStatus: snapshot.lifecycle === 'live' ? 'started' : 'spawning',
    processError: null,
    recoveryFailureCode: null,
    exited: null,
    ...(snapshotIsAuthoritative
      ? {
          inputReady: snapshot.input.ready,
          inputReadinessRevision: snapshot.input.revision,
          inputReadinessReason: snapshot.input.reason ?? null,
          inputReadinessChangedAt: Date.now(),
        }
      : {}),
  }
  // WHY conditions need their own ordering check rather than riding
  // `snapshotIsAuthoritative` (#895): readiness and conditions are separate
  // channels with separate counters, and `previous` here is not "what this
  // window used to show" — it is whatever the LIVE channel has already written
  // for a session whose routing moved here before the adoption offer arrived.
  // `onSessionConditions` creates a runtime for a session it has never seen,
  // so a prompt dismissed while this snapshot was in flight is already in the
  // map, and seeding over it would put the dismissed prompt back in the
  // surface the user acts on.
  //
  // Note `base` deliberately starts from `emptyRuntime()`, which is exactly
  // the bug: without this the adopted pane began with `conditions: null`, and
  // providers publish conditions only when they CHANGE, so nothing ever
  // re-sent the blocker.
  return seeded
}


/**
 * Fetch a backend snapshot for each incoming session, then seed a runtime for
 * EVERY one of them before any row is published.
 *
 * Snapshots come first so a pane never paints the "starting agent" state a
 * bare seed shows. A failed snapshot degrades to null, the same shape as a
 * parked session, which is handled. Every session gets a runtime, not just the
 * ones with a backend: `ensureSessionLive`, the wake path behind lane
 * selection, no-ops without one, so a parked agent seeded without a runtime
 * would wake into an empty feed with no way to report a failure.
 *
 * Conditions are re-seeded AFTER the seed (#895): providers publish them only
 * when they change, so an agent already blocked on a permission sends nothing
 * to a window that just started watching it, and `seedAdoptedRuntime` builds
 * from `emptyRuntime()`, so anything delivered before the seed is overwritten.
 */
export async function seedIncomingRuntimes(params: {
  sessionIds: readonly SessionId[]
  metas: Record<SessionId, SessionMeta | undefined>
  drafts: Record<SessionId, string>
  setRuntimes: WorkspaceSetRuntimes
}): Promise<AdoptedSnapshots> {
  const snapshots: AdoptedSnapshots = new Map()
  await Promise.all(params.sessionIds.map(async sessionId => {
    try {
      snapshots.set(sessionId, await window.api.getBackendSnapshot(sessionId))
    } catch {
      snapshots.set(sessionId, null)
    }
  }))
  params.setRuntimes(prev => {
    const next = { ...prev }
    for (const sessionId of params.sessionIds) {
      next[sessionId] = seedAdoptedRuntime(
        prev[sessionId],
        params.metas[sessionId],
        snapshots.get(sessionId) ?? null,
        params.drafts[sessionId],
      )
    }
    return next
  })
  // Not awaited: it arrives on the event channel like any other condition
  // change, and a pane painting one turn without its blocker is far better
  // than holding up the whole handoff for it.
  void window.api.reseedSessionConditions?.(params.sessionIds as string[])
  return snapshots
}

/**
 * Load history for the incoming sessions that arrived WITH A LIVE BACKEND,
 * each progressively as its transcript arrives (the same behaviour bootstrap
 * has). A parked agent's transcript is fetched by `ensureSessionLive` when it
 * is actually woken, so loading it here would only spend IO on rows nobody
 * looked at.
 */
export function loadIncomingHistory(params: {
  sessionIds: readonly SessionId[]
  snapshots: AdoptedSnapshots
  metas: Record<SessionId, SessionMeta | undefined>
  refs: WorkspaceRefs
  setRuntimes: WorkspaceSetRuntimes
}): void {
  for (const sessionId of params.sessionIds.filter(id => params.snapshots.get(id) != null)) {
    void loadInitialHistoryForSession({
      sessionId: sessionId as SessionId,
      refs: params.refs,
      setRuntimes: params.setRuntimes,
      meta: params.metas[sessionId],
    })
  }
}
