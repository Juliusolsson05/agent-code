import { useCallback } from 'react'

import type { SessionId } from '@renderer/workspace/types'
import { collectLeaves } from '@renderer/workspace/tile-tree/treeOps'
import {
  buildVisibleDispatchRows,
  selectVisibleDispatchRow,
} from '@renderer/workspace/dispatch/dispatchSelectors'
import { dispatchFocusedSessionId } from '@renderer/workspace/dispatch/tiledDispatchSelectors'

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
          buildVisibleDispatchRows(current),
          // tiled-aware: focused lane's agent in Tiled Dispatch, not the
          // stale dispatchMode.focusedSessionId (which would spotlight tile 0).
          dispatchFocusedSessionId(current.dispatchMode),
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
        ? buildVisibleDispatchRows(snapshot)
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
      setState(prev => {
        // Tab.focusedSessionId has a hard invariant: it must be a
        // leaf in `tab.root`. The non-Dispatch Spotlight view now
        // surfaces detached agents (via resolveTabSessions), so a
        // detached id can land here. Writing it into focusedSessionId
        // would corrupt the tab — every downstream surface that
        // reads tab.focusedSessionId (resize, split, bury, command
        // target fallback) assumes it points at an actual tile. So
        // we only mirror to focusedSessionId when the id is provably
        // a grid leaf for the active tab. The Spotlight surface
        // itself already holds the chosen id; the grid-focus mirror
        // is just a convenience for the "Spotlight off → land on
        // this pane" handoff, which is moot for a detached session.
        const activeTab = prev.tabs.find(t => t.id === prev.activeTabId) ?? null
        const isGridLeaf = activeTab ? collectLeaves(activeTab.root).includes(sessionId) : false
        return {
          ...prev,
          activeTabId: dispatchRow?.tabId ?? prev.activeTabId,
          dispatchMode: prev.dispatchMode && dispatchRow
            ? { ...prev.dispatchMode, focusedSessionId: sessionId }
            : prev.dispatchMode,
          tabs: prev.dispatchMode
            ? prev.tabs
            : prev.tabs.map(t =>
                t.id === prev.activeTabId && isGridLeaf
                  ? { ...t, focusedSessionId: sessionId }
                  : t,
              ),
        }
      })
    },
    [refs.stateRef, setSpotlight, setState],
  )

  return { toggleSpotlight, setSpotlightSession }
}
