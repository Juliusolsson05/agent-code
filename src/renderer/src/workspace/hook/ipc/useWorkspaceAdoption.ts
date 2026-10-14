import { useEffect, useRef } from 'react'

import type { PersistedWorkspace } from '@renderer/workspace/persistence'
import { adoptWorkspace } from '@renderer/workspace/adoptWorkspace'
import { loadIncomingHistory, seedIncomingRuntimes } from '@renderer/workspace/hook/ipc/seedIncomingSessions'
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
// Why the adopted sessions are seeded from backend snapshots instead of going
// through `recoverSession` (and how): see seedIncomingSessions.ts, shared with
// the live-window move (#1481).

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

    // WHY the migration is inside the same guard as a JSON failure (#1048
    // Codex review): adoptWorkspace migrates the incoming document, and that
    // now THROWS on a corrupt project container rather than silently
    // producing an empty pool. An escaping exception was only logged by the
    // callers, so main — which has already transferred session routing here
    // and recorded a pending bequest — never heard a refusal, and those
    // sessions stayed pinned to a window that would never display them.
    let adoption: ReturnType<typeof adoptWorkspace>
    try {
      adoption = adoptWorkspace(refs.latestStateRef.current, incoming)
    } catch (err) {
      console.warn('[workspace] unmigratable adoption payload:', err)
      await window.api.refuseWorkspaceAdoption(windowId)
      return
    }
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

    // Snapshot, seed and condition re-seed, in that order, before any row is
    // published. The reasons for each step live on seedIncomingRuntimes.
    const snapshots = await seedIncomingRuntimes({
      sessionIds: adoption.adoptedSessionIds,
      metas: adoption.state.sessions,
      drafts: adoption.drafts,
      setRuntimes,
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

    // Only sessions that arrived with a live backend (the ones the closed
    // window was actively running) load history eagerly. (Until #992 the
    // eager set was "the adopted tile leaves", a structural stand-in for the
    // same idea.)
    loadIncomingHistory({
      sessionIds: adoption.adoptedSessionIds,
      snapshots,
      metas: adoption.state.sessions,
      refs,
      setRuntimes,
    })
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
