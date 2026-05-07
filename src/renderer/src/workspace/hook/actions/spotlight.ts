import { useCallback } from 'react'

import type { SessionId } from '@renderer/workspace/types'
import {
  buildDispatchGroups,
  flattenDispatchRows,
  selectVisibleDispatchRow,
} from '@renderer/workspace/dispatch/dispatchSelectors'

import type {
  WorkspaceSetSpotlight,
  WorkspaceSetState,
} from '@renderer/workspace/hook/context'
import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'

// Spotlight mode — focused-pane zoom within the active tab. toggleSpotlight
// enters with the active tab's currently-focused session; exits if already
// on for the active tab. setSpotlightSession switches which session is
// showing inside Spotlight.

export function useSpotlightActions(
  setSpotlight: WorkspaceSetSpotlight,
  setState: WorkspaceSetState,
  refs: WorkspaceRefs,
): {
  toggleSpotlight: () => void
  setSpotlightSession: (sessionId: SessionId) => void
} {
  const toggleSpotlight = useCallback(() => {
    const current = refs.stateRef.current
    const activeTab = current.tabs.find(t => t.id === current.activeTabId)
    if (!activeTab) return
    const dispatchRow = current.dispatchMode
      ? selectVisibleDispatchRow(
          flattenDispatchRows(buildDispatchGroups(current)),
          current.dispatchMode.focusedSessionId,
          activeTab.focusedSessionId,
        )
      : null
    setSpotlight(prev => {
      const tabId = dispatchRow?.tabId ?? activeTab.id
      if (prev?.tabId === tabId) return null
      return {
        tabId,
        focusedSessionId: dispatchRow?.sessionId ?? activeTab.focusedSessionId,
      }
    })
  }, [refs.stateRef, setSpotlight])

  const setSpotlightSession = useCallback(
    (sessionId: SessionId) => {
      const snapshot = refs.stateRef.current
      const rows = snapshot.dispatchMode
        ? flattenDispatchRows(buildDispatchGroups(snapshot))
        : []
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
      setState(prev => ({
        ...prev,
        activeTabId: dispatchRow?.tabId ?? prev.activeTabId,
        dispatchMode: prev.dispatchMode && dispatchRow
          ? { ...prev.dispatchMode, focusedSessionId: sessionId }
          : prev.dispatchMode,
        tabs: prev.dispatchMode
          ? prev.tabs
          : prev.tabs.map(t =>
              t.id === prev.activeTabId ? { ...t, focusedSessionId: sessionId } : t,
            ),
      }))
    },
    [refs.stateRef, setSpotlight, setState],
  )

  return { toggleSpotlight, setSpotlightSession }
}
