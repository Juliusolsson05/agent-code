import { useCallback } from 'react'

import type { SessionId } from '@renderer/workspace/types'
import { collectLeaves } from '@renderer/workspace/tile-tree/treeOps'
import {
  buildDispatchGroups,
  flattenDispatchRows,
  selectVisibleDispatchRow,
} from '@renderer/workspace/dispatch/dispatchSelectors'

import type {
  WorkspaceSetReaderMode,
  WorkspaceSetSpotlight,
  WorkspaceSetState,
} from '@renderer/workspace/hook/context'
import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'

// ReaderMode toggle. Mirrors toggleSpotlight: enters with the active
// tab's currently-focused session, exits if already on for the active
// tab. Closes Spotlight on entry; tile-tabs are preserved in state
// and suppressed by App.tsx render precedence.

export function useReaderActions(
  setReaderMode: WorkspaceSetReaderMode,
  setSpotlight: WorkspaceSetSpotlight,
  setState: WorkspaceSetState,
  refs: WorkspaceRefs,
): {
  toggleReaderMode: () => void
  setReaderModeSession: (sessionId: SessionId) => void
} {
  const toggleReaderMode = useCallback(() => {
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
    setSpotlight(null)
    setReaderMode(prev => {
      const tabId = dispatchRow?.tabId ?? activeTab.id
      if (prev?.tabId === tabId) return null
      return {
        tabId,
        focusedSessionId: dispatchRow?.sessionId ?? activeTab.focusedSessionId,
      }
    })
  }, [refs.stateRef, setReaderMode, setSpotlight])

  // Switch which session is being read inside ReaderMode.
  //
  // WHY Dispatch mode is special here: detached sessions are not tile-tree
  // leaves, and Tab.focusedSessionId is a grid-only invariant. The original
  // Reader implementation wrote every selected reader session into
  // Tab.focusedSessionId, which corrupts the tab whenever the selected row is
  // detached. In Dispatch, keep focus on dispatchMode.focusedSessionId and
  // activeTabId instead; outside Dispatch, preserve the older grid behavior.
  const setReaderModeSession = useCallback(
    (sessionId: SessionId) => {
      const snapshot = refs.stateRef.current
      const rows = snapshot.dispatchMode
        ? flattenDispatchRows(buildDispatchGroups(snapshot))
        : []
      const dispatchRow = rows.find(row => row.sessionId === sessionId) ?? null
      setReaderMode(prev => (
        prev
          ? {
              ...prev,
              tabId: dispatchRow?.tabId ?? prev.tabId,
              focusedSessionId: sessionId,
            }
          : prev
      ))
      setState(prev => {
        // Tab.focusedSessionId is a grid-only field (its invariant:
        // must be a leaf in `tab.root`). Non-Dispatch Reader now
        // surfaces detached agents in its session list (via
        // resolveTabSessions), so a detached id can reach this
        // handler. The pre-existing comment above already explained
        // the Dispatch case; the same reasoning applies to detached
        // sessions clicked from a non-Dispatch Reader view — only
        // mirror to focusedSessionId when the id is actually a leaf.
        // For a detached selection, Reader's own focusedSessionId
        // holds the choice; we don't need to (and must not) mirror
        // it to the grid-only field.
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
    [refs.stateRef, setReaderMode, setState],
  )

  return { toggleReaderMode, setReaderModeSession }
}
