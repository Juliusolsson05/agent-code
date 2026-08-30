import { useEffect } from 'react'

import { emptyRuntime } from '@renderer/session-runtime/state'
import type { PersistedWorkspace } from '@renderer/workspace/persistence'
import type { SessionId } from '@renderer/workspace/types'
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
// deadline to establish something we already know.

export function useWorkspaceAdoption(
  refs: WorkspaceRefs,
  setState: WorkspaceSetState,
  setRuntimes: WorkspaceSetRuntimes,
): void {
  useEffect(() => {
    const off = window.api.onWorkspaceAdopt(async ({ windowId, workspace }) => {
      let incoming: PersistedWorkspace
      try {
        incoming = (JSON.parse(workspace) as { workspace: PersistedWorkspace }).workspace
      } catch (err) {
        // Not confirming leaves the closed window's slice on disk, so its
        // workspace comes back as its own window on the next launch rather than
        // being deleted along with an adoption that never happened.
        // eslint-disable-next-line no-console
        console.warn('[workspace] unreadable adoption payload; leaving it on disk:', err)
        return
      }

      const adoption = adoptWorkspace(refs.latestStateRef.current, incoming)
      if (!adoption.ok) {
        // eslint-disable-next-line no-console
        console.warn('[workspace] refused to adopt a closed window:', adoption.reason)
        return
      }

      // Runtimes first, state second. A tile leaf whose runtime does not exist
      // yet renders through `emptyRuntime()` as an idle pane with a `?` label
      // (see repairPersistedTabs' note on orphan leaves); seeding before the
      // tabs are visible means the adopted panes never paint in that state.
      setRuntimes(prev => {
        const next = { ...prev }
        for (const sessionId of adoption.adoptedLeafSessionIds) {
          const meta = adoption.state.sessions[sessionId]
          const draft = adoption.drafts[sessionId]
          next[sessionId] = {
            ...emptyRuntime(),
            ...seedResumedRuntimeFields(prev[sessionId], meta),
            ...(draft ? { draftInput: draft } : {}),
          }
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

      // History is loaded per session and not awaited as a batch: each pane
      // fills in as its transcript arrives, which is the same progressive
      // behavior bootstrap has. Failures are already surfaced per pane through
      // `transcriptStatus`.
      for (const sessionId of adoption.adoptedLeafSessionIds) {
        void loadInitialHistoryForSession({
          sessionId: sessionId as SessionId,
          refs,
          setRuntimes,
          meta: adoption.state.sessions[sessionId],
        })
      }

      // Only now is it safe for main to forget the closed window: this window's
      // next autosave will carry the adopted rows, and until that lands the
      // closed slice is the only durable record of them.
      await window.api.confirmWorkspaceAdoption(windowId)
    })
    return off
  }, [refs, setRuntimes, setState])
}
