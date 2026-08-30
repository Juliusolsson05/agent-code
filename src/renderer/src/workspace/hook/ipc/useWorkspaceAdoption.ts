import { useEffect, useRef } from 'react'

import type { SessionBackendSnapshot } from '@shared/types/session'
import { emptyRuntime } from '@renderer/session-runtime/state'
import type { SessionRuntime } from '@renderer/session-runtime/state'
import type { PersistedWorkspace } from '@renderer/workspace/persistence'
import type { SessionId, SessionMeta } from '@renderer/workspace/types'
import { adoptWorkspace } from '@renderer/workspace/adoptWorkspace'
import { seedResumedRuntimeFields } from '@renderer/workspace/providerSessionIdentity'
import { loadInitialHistoryForSession } from '@renderer/workspace/hook/actions/initialHistory'
import type { WorkspaceSetRuntimes, WorkspaceSetState } from '@renderer/workspace/hook/context'
import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'

// Taking over a closed window's workspace.
//
// The main process hands this window the closed window's last persisted slice
// and has ALREADY transferred those sessions' event routing here — see
// `windowRegistry.transferSessions`. That order matters: events emitted during
// the handoff must arrive at the window that is about to display them, not at
// one that is being torn down.
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
type AdoptedSnapshots = Map<SessionId, SessionBackendSnapshot | null>

function seedAdoptedRuntime(
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
  return {
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
}

export function useWorkspaceAdoption(
  refs: WorkspaceRefs,
  setState: WorkspaceSetState,
  setRuntimes: WorkspaceSetRuntimes,
  bootstrapComplete: boolean,
): void {
  /**
   * Adoptions that arrived before this window finished restoring itself.
   *
   * WHY they cannot simply be applied: `rehydrateWorkspace` publishes its
   * result as a WHOLESALE replacement of `tabs`/`sessions`/`detachedSessions`/
   * `buried`/`pinnedSessionIds` and rebuilds the runtime map from its own
   * restored set. Anything merged in before that publish is silently erased —
   * and since main deletes the closed window's slice on confirmation, the
   * erased workspace would be gone from disk too. Autosave is also disabled
   * until bootstrap completes, so a merge applied early could never become
   * durable in the first place.
   */
  const queuedRef = useRef<Array<{ windowId: string; workspace: string }>>([])
  const bootstrapCompleteRef = useRef(bootstrapComplete)
  bootstrapCompleteRef.current = bootstrapComplete

  // The applier is held in a ref so the IPC subscription can stay mounted for
  // the life of the window (re-subscribing would drop in-flight offers) while
  // still calling the latest closure.
  const applyRef = useRef<(request: { windowId: string; workspace: string }) => Promise<void>>()

  applyRef.current = async request => {
    const { windowId, workspace } = request

    let incoming: PersistedWorkspace
    try {
      incoming = (JSON.parse(workspace) as { workspace: PersistedWorkspace }).workspace
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[workspace] unreadable adoption payload:', err)
      await window.api.refuseWorkspaceAdoption(windowId)
      return
    }

    const adoption = adoptWorkspace(refs.latestStateRef.current, incoming)
    if (!adoption.ok) {
      // Refusing tells main to leave the slice on disk AND to roll back the
      // session routing it moved here optimistically. Staying silent would
      // leave those sessions pinned to a window that will never show them,
      // accumulating runtimes for panes that do not exist.
      // eslint-disable-next-line no-console
      console.warn('[workspace] refused to adopt a closed window:', adoption.reason)
      await window.api.refuseWorkspaceAdoption(windowId)
      return
    }

    // Snapshots are fetched BEFORE any state is published so an adopted pane
    // never paints in the "starting agent" state it would show from a bare
    // seed. A failed snapshot degrades to null, which is the same shape as a
    // parked session and is handled.
    const snapshots: AdoptedSnapshots = new Map()
    await Promise.all(adoption.adoptedSessionIds.map(async sessionId => {
      try {
        snapshots.set(sessionId, await window.api.getBackendSnapshot(sessionId))
      } catch {
        snapshots.set(sessionId, null)
      }
    }))

    // Runtimes first, state second. A tile leaf whose runtime does not exist
    // yet renders through `emptyRuntime()` as an idle pane with a `?` label
    // (see repairPersistedTabs' note on orphan leaves); seeding before the
    // tabs are visible means the adopted panes never paint in that state.
    //
    // WHY EVERY adopted session gets a runtime and not just the tile leaves:
    // `ensureSessionLive` — the wake path behind Attach to Grid and revive —
    // gates on `latestRuntimesRef.current[sessionId]` being present, and every
    // one of its `setRuntimes` writes no-ops when it is missing. A parked agent
    // adopted without a runtime therefore wakes into an empty feed with no
    // transcript and no way to report a failure, which is precisely the case
    // this whole feature exists to rescue.
    setRuntimes(prev => {
      const next = { ...prev }
      for (const sessionId of adoption.adoptedSessionIds) {
        next[sessionId] = seedAdoptedRuntime(
          prev[sessionId],
          adoption.state.sessions[sessionId],
          snapshots.get(sessionId) ?? null,
          adoption.drafts[sessionId],
        )
      }
      return next
    })

    setState(prev => ({
      ...prev,
      ...adoption.state,
      // Focus deliberately does NOT move to an adopted tab. Another window
      // closing is not a request to navigate; yanking the user out of what
      // they were doing would be the more surprising behavior by far.
      activeTabId: prev.activeTabId,
    }))

    // Queue the confirmation rather than sending it: main deletes the closed
    // window's slice when it arrives, and until this window's next autosave
    // commits, that slice is the only durable record of the adopted rows.
    refs.pendingAdoptionWindowIdsRef.current = [
      ...refs.pendingAdoptionWindowIdsRef.current,
      windowId,
    ]

    // History is loaded per session and not awaited as a batch: each pane fills
    // in as its transcript arrives, which is the same progressive behavior
    // bootstrap has. Only tile leaves are loaded eagerly — a parked agent's
    // transcript is fetched by `ensureSessionLive` when it is actually woken.
    for (const sessionId of adoption.adoptedLeafSessionIds) {
      void loadInitialHistoryForSession({
        sessionId: sessionId as SessionId,
        refs,
        setRuntimes,
        meta: adoption.state.sessions[sessionId],
      })
    }
  }

  useEffect(() => {
    const off = window.api.onWorkspaceAdopt(request => {
      if (!bootstrapCompleteRef.current) {
        queuedRef.current = [...queuedRef.current, request]
        return
      }
      void applyRef.current?.(request).catch(err => {
        // A throw here leaves main's slice in place (no confirmation was sent),
        // so the closed workspace returns as its own window next launch.
        // eslint-disable-next-line no-console
        console.warn('[workspace] adoption failed:', err)
      })
    })
    return off
  }, [])

  // Drain anything that arrived mid-bootstrap, once restore has published.
  useEffect(() => {
    if (!bootstrapComplete || queuedRef.current.length === 0) return
    const queued = queuedRef.current
    queuedRef.current = []
    for (const request of queued) {
      void applyRef.current?.(request).catch(err => {
        // eslint-disable-next-line no-console
        console.warn('[workspace] queued adoption failed:', err)
      })
    }
  }, [bootstrapComplete])
}
