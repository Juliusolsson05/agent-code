import { useCallback } from 'react'

import type { SessionId, TabId } from '@renderer/workspace/types'
import {
  adjustNearestSplitRatio,
  collectLeaves,
  equalizeRatios,
  normalizeTree,
  resizeInDirection,
  rotateTree,
} from '@renderer/workspace/tile-tree/treeOps'
import { setRatioBetween } from '@renderer/workspace/layout/helpers'

import type {
  WorkspaceSetState,
  WorkspaceSetTileTabs,
} from '@renderer/workspace/hook/context'

// Resize + layout normalization actions.
//
// resizeFocused              — adjust the nearest split ratio
// resizeFocusedDirectional   — grow focused pane toward a direction (tmux-style)
// setSplitRatio              — set a specific split's ratio directly (drag)
// setSplitRatioInTab         — same, but targets a specific tab by id
// normalizeLayout            — soft: every split ratio = 0.5, tree unchanged
// hardNormalizeLayout        — flatten & rebuild as a rows×cols grid
// rotateLayout               — flip every split direction

export function useResizeActions(
  setState: WorkspaceSetState,
  setTileTabs: WorkspaceSetTileTabs,
): {
  resizeFocused: (delta: number) => void
  resizeFocusedDirectional: (direction: 'left' | 'right' | 'up' | 'down', delta: number) => void
  setSplitRatio: (fromSessionId: SessionId, toSessionId: SessionId, ratio: number) => void
  setSplitRatioInTab: (tabId: TabId, fromSessionId: SessionId, toSessionId: SessionId, ratio: number) => void
  normalizeLayout: () => void
  hardNormalizeLayout: () => void
  rotateLayout: () => void
} {
  const resizeFocused = useCallback(
    (delta: number) => {
      setState(prev => ({
        ...prev,
        tabs: prev.tabs.map(t => {
          if (t.id !== prev.activeTabId) return t
          return {
            ...t,
            root: adjustNearestSplitRatio(t.root, t.focusedSessionId, delta),
          }
        }),
      }))
    },
    [setState],
  )

  // Grows the focused pane toward the given direction by `delta`. See
  // resizeInDirection in treeOps.ts for the full tmux-style semantics.
  const resizeFocusedDirectional = useCallback(
    (direction: 'left' | 'right' | 'up' | 'down', delta: number) => {
      setState(prev => ({
        ...prev,
        tabs: prev.tabs.map(t => {
          if (t.id !== prev.activeTabId) return t
          return {
            ...t,
            root: resizeInDirection(t.root, t.focusedSessionId, direction, delta),
          }
        }),
      }))
    },
    [setState],
  )

  // Walks the tree and finds the split whose `a` side contains fromId
  // and whose `b` side contains toId, then sets its ratio directly.
  const setSplitRatio = useCallback(
    (fromSessionId: SessionId, toSessionId: SessionId, ratio: number) => {
      setState(prev => ({
        ...prev,
        tabs: prev.tabs.map(t => {
          if (t.id !== prev.activeTabId) return t
          return { ...t, root: setRatioBetween(t.root, fromSessionId, toSessionId, ratio) }
        }),
      }))
    },
    [setState],
  )

  const setSplitRatioInTab = useCallback(
    (tabId: TabId, fromSessionId: SessionId, toSessionId: SessionId, ratio: number) => {
      setState(prev => {
        let changed = prev.activeTabId !== tabId
        const tabs = prev.tabs.map(t => {
          if (t.id !== tabId) return t
          const root = setRatioBetween(t.root, fromSessionId, toSessionId, ratio)
          if (root === t.root) return t
          changed = true
          return { ...t, root }
        })
        return changed ? { ...prev, activeTabId: tabId, tabs } : prev
      })
      setTileTabs(prev => (
        prev && prev.focusedTabId !== tabId && prev.tabIds.includes(tabId)
          ? { ...prev, focusedTabId: tabId }
          : prev
      ))
    },
    [setState, setTileTabs],
  )

  // Keep the existing tree structure but set every split ratio to
  // 0.5. Equalizes spacing without rearranging panes — if you have
  // three vertical panes on the left and one on the right, they stay
  // that way but all dividers move to the midpoint.
  const normalizeLayout = useCallback(() => {
    setState(prev => ({
      ...prev,
      tabs: prev.tabs.map(t =>
        t.id === prev.activeTabId
          ? { ...t, root: equalizeRatios(t.root) }
          : t,
      ),
    }))
  }, [setState])

  // Flatten the tree and rebuild as a balanced grid where every pane
  // gets equal space. Changes the arrangement — all panes end up in
  // a rows × cols grid. No sessions are spawned or killed.
  const hardNormalizeLayout = useCallback(() => {
    setState(prev => {
      const tab = prev.tabs.find(t => t.id === prev.activeTabId)
      if (!tab) return prev
      const leaves = collectLeaves(tab.root)
      if (leaves.length <= 1) return prev
      const newRoot = normalizeTree(leaves)
      return {
        ...prev,
        tabs: prev.tabs.map(t =>
          t.id === prev.activeTabId ? { ...t, root: newRoot } : t,
        ),
      }
    })
  }, [setState])

  // Flip every split direction in the active tab's tree: vertical
  // becomes horizontal and vice versa. Turns rows into columns.
  const rotateLayout = useCallback(() => {
    setState(prev => ({
      ...prev,
      tabs: prev.tabs.map(t =>
        t.id === prev.activeTabId
          ? { ...t, root: rotateTree(t.root) }
          : t,
      ),
    }))
  }, [setState])

  return {
    resizeFocused,
    resizeFocusedDirectional,
    setSplitRatio,
    setSplitRatioInTab,
    normalizeLayout,
    hardNormalizeLayout,
    rotateLayout,
  }
}
