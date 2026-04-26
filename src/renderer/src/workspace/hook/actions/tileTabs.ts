import { useCallback } from 'react'

import type { SessionId, SplitDirection, TabId } from '@renderer/workspace/types'
import { equalRatios, normalizeRatios } from '@renderer/workspace/layout/helpers'

import type {
  WorkspaceSetSpotlight,
  WorkspaceSetState,
  WorkspaceSetTileTabs,
} from '@renderer/workspace/hook/context'
import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'

// Tile-tabs actions. Opening a tile-tab set tiles multiple tabs side
// by side inside a single tab view (meta-tabs). Focus + resize here
// operates on the tile-tabs slice, NOT the regular tab bar.

export function useTileTabsActions(
  setTileTabs: WorkspaceSetTileTabs,
  setSpotlight: WorkspaceSetSpotlight,
  setState: WorkspaceSetState,
  refs: WorkspaceRefs,
): {
  openTileTabs: (tabIds: TabId[], direction?: SplitDirection) => void
  closeTileTabs: () => void
  focusTiledTab: (tabId: TabId) => void
  focusTiledTabByIndex: (index: number) => void
  resizeFocusedTiledTab: (delta: number) => void
  resizeTiledTabByIndex: (index: number, delta: number) => void
} {
  const openTileTabs = useCallback(
    (tabIds: TabId[], direction: SplitDirection = 'vertical') => {
      const current = refs.stateRef.current
      const valid = tabIds.filter(id => current.tabs.some(t => t.id === id))
      if (valid.length < 2) return
      const focusedTabId = valid.includes(current.activeTabId)
        ? current.activeTabId
        : valid[0]
      setSpotlight(null)
      // Tile-tabs and Dispatch Mode are both top-level alternatives to
      // the normal grid. Letting both stay active made Dispatch persist
      // invisibly behind TileTabs, so entering one mode explicitly clears
      // the other.
      setTileTabs({
        tabIds: valid,
        focusedTabId,
        direction,
        ratios: equalRatios(valid.length),
      })
      setState(prev => ({
        ...prev,
        activeTabId: focusedTabId,
        dispatchMode: null,
      }))
    },
    [refs.stateRef, setSpotlight, setState, setTileTabs],
  )

  const closeTileTabs = useCallback(() => {
    setTileTabs(null)
  }, [setTileTabs])

  const focusTiledTab = useCallback(
    (tabId: TabId) => {
      setTileTabs(prev => (
        prev && prev.tabIds.includes(tabId)
          ? { ...prev, focusedTabId: tabId }
          : prev
      ))
      setState(prev => ({ ...prev, activeTabId: tabId }))
    },
    [setState, setTileTabs],
  )

  const focusTiledTabByIndex = useCallback(
    (index: number) => {
      setTileTabs(prev => {
        if (!prev) return prev
        const tabId = prev.tabIds[index]
        if (!tabId) return prev
        setState(statePrev => ({ ...statePrev, activeTabId: tabId }))
        return { ...prev, focusedTabId: tabId }
      })
    },
    [setState, setTileTabs],
  )

  const resizeFocusedTiledTab = useCallback(
    (delta: number) => {
      setTileTabs(prev => {
        if (!prev || prev.tabIds.length < 2) return prev
        const idx = prev.tabIds.indexOf(prev.focusedTabId)
        if (idx === -1) return prev

        const leftIndex = idx === prev.tabIds.length - 1 ? idx - 1 : idx
        const rightIndex = idx === prev.tabIds.length - 1 ? idx : idx + 1
        if (leftIndex < 0 || rightIndex >= prev.ratios.length) return prev

        const nextRatios = [...prev.ratios]
        const signedDelta = idx === prev.tabIds.length - 1 ? -delta : delta
        const nextLeft = nextRatios[leftIndex] + signedDelta
        const nextRight = nextRatios[rightIndex] - signedDelta
        const minRatio = 0.12
        if (nextLeft < minRatio || nextRight < minRatio) return prev

        nextRatios[leftIndex] = nextLeft
        nextRatios[rightIndex] = nextRight
        return {
          ...prev,
          ratios: normalizeRatios(nextRatios),
        }
      })
    },
    [setTileTabs],
  )

  const resizeTiledTabByIndex = useCallback(
    (index: number, delta: number) => {
      setTileTabs(prev => {
        if (!prev || prev.tabIds.length < 2) return prev
        if (index < 0 || index >= prev.tabIds.length) return prev

        const leftIndex = index === prev.tabIds.length - 1 ? index - 1 : index
        const rightIndex = index === prev.tabIds.length - 1 ? index : index + 1
        if (leftIndex < 0 || rightIndex >= prev.ratios.length) return prev

        const nextRatios = [...prev.ratios]
        const signedDelta = index === prev.tabIds.length - 1 ? -delta : delta
        const nextLeft = nextRatios[leftIndex] + signedDelta
        const nextRight = nextRatios[rightIndex] - signedDelta
        const minRatio = 0.12
        if (nextLeft < minRatio || nextRight < minRatio) return prev

        nextRatios[leftIndex] = nextLeft
        nextRatios[rightIndex] = nextRight
        return {
          ...prev,
          ratios: normalizeRatios(nextRatios),
        }
      })
    },
    [setTileTabs],
  )

  // Keep sessionId param reference for downstream hook-level deps.
  void (null as unknown as SessionId)

  return {
    openTileTabs,
    closeTileTabs,
    focusTiledTab,
    focusTiledTabByIndex,
    resizeFocusedTiledTab,
    resizeTiledTabByIndex,
  }
}
