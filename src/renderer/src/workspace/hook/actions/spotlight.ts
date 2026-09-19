import { useCallback } from 'react'

import type { SessionId } from '@renderer/workspace/types'
import {
  buildVisibleDispatchRows,
} from '@renderer/workspace/dispatch/dispatchSelectors'
import { resolveFocusSurfaceTarget } from '@renderer/workspace/hook/actions/focusSurfaceTarget'

import type {
  WorkspaceSetSpotlight,
  WorkspaceSetState,
} from '@renderer/workspace/hook/context'
import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'

// Spotlight mode — a full-window takeover of the current command target.
// toggleSpotlight exits whenever Spotlight is already open; otherwise it enters
// on the same command target lifecycle commands use (the focused lane's
// agent). setSpotlightSession switches which session is showing inside
// Spotlight, and while Spotlight is open that session IS the command target
// (commandTargetSessionIdForState reads the takeover first).

export function useSpotlightActions(
  setSpotlight: WorkspaceSetSpotlight,
  setState: WorkspaceSetState,
  refs: WorkspaceRefs,
): {
  setSpotlightTarget: (sessionId: SessionId | null) => boolean
  toggleSpotlight: () => void
  setSpotlightSession: (sessionId: SessionId) => void
} {
  // Explicit desired state lets command clients select a non-focused agent
  // without a focus-then-toggle race. Ownership uses the same placement query
  // as UI toggles, including detached and related sessions.
  const setSpotlightTarget = useCallback((sessionId: SessionId | null) => {
    if (sessionId === null) { setSpotlight(null); return true }
    const current = refs.stateRef.current
    const target = resolveFocusSurfaceTarget(current, sessionId)
    if (!target) return false
    setState(prev => ({ ...prev, activeTabId: target.tabId }))
    setSpotlight({ tabId: target.tabId, focusedSessionId: sessionId })
    return true
  }, [refs.stateRef, setSpotlight, setState])

  const toggleSpotlight = useCallback(() => {
    const current = refs.stateRef.current
    const target = resolveFocusSurfaceTarget(current)
    setSpotlight(prev => {
      if (prev) return null
      if (!target) return prev
      return {
        tabId: target.tabId,
        focusedSessionId: target.sessionId,
      }
    })
  }, [refs.stateRef, setSpotlight])

  const setSpotlightSession = useCallback(
    (sessionId: SessionId) => {
      const snapshot = refs.stateRef.current
      const rows = buildVisibleDispatchRows(snapshot)
      const dispatchRow = rows.find(row => row.sessionId === sessionId) ?? null
      setSpotlight(prev => (
        prev
          ? {
              ...prev,
              tabId: dispatchRow?.tabId ?? prev.tabId,
              focusedSessionId: sessionId,
            }
          : prev
      ))
      // Only the active PROJECT follows the Spotlight selection — it is a label
      // (U4) that decides where the next agent defaults and which header is
      // highlighted, so it should name the project the user is looking at.
      //
      // WHY no lane is written, although this used to mirror the selection
      // into a classic-Dispatch focus (and, outside Dispatch, into the tree's
      // Tab.focusedSessionId): both of those fields are gone (#992), and the
      // stage has no equivalent on purpose. Spotlight is a takeover that holds
      // its own focusedSessionId; browsing agents inside it is not the user
      // naming a lane occupant (U2, #681), so leaving Spotlight returns to the
      // stage exactly as it was left.
      setState(prev => {
        const activeTabId = dispatchRow?.tabId ?? prev.activeTabId
        return activeTabId === prev.activeTabId ? prev : { ...prev, activeTabId }
      })
    },
    [refs.stateRef, setSpotlight, setState],
  )

  return { setSpotlightTarget, toggleSpotlight, setSpotlightSession }
}
