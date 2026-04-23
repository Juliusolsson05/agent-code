import { useCallback } from 'react'

import type { SessionId, SessionKind, SessionMeta, Tab, TabId } from '../../types'
import { collectLeaves } from '../../tile-tree/treeOps'
import { sanitizeTileTabsState, titleFromCwd } from '../../layout/helpers'

import type {
  WorkspaceSetReaderMode,
  WorkspaceSetRuntimes,
  WorkspaceSetSpotlight,
  WorkspaceSetState,
  WorkspaceSetTileTabs,
} from '../context'
import type { WorkspaceRefs } from '../refs'
import type { SessionActions } from './session'

// Tab actions — open/close + tab-navigation keybinds.

export function useTabActions(
  state: { activeTabId: string; sessions: Record<SessionId, SessionMeta>; tabs: Tab[] },
  tileTabs: { tabIds: TabId[]; focusedTabId: TabId } | null,
  setState: WorkspaceSetState,
  setRuntimes: WorkspaceSetRuntimes,
  setTileTabs: WorkspaceSetTileTabs,
  setSpotlight: WorkspaceSetSpotlight,
  setReaderMode: WorkspaceSetReaderMode,
  refs: WorkspaceRefs,
  showToast: (message: string, durationMs?: number) => void,
  sessionActions: SessionActions,
): {
  newTab: (cwd: string, resumeSessionId?: string, kind?: SessionKind) => Promise<{ tabId: TabId; sessionId: SessionId }>
  closeTab: (tabId: TabId) => Promise<void>
  activateTab: (tabId: TabId) => void
  activateTabByIndex: (index: number) => void
  nextTab: () => void
  prevTab: () => void
} {
  // Spawns a new session in the given cwd, creates a tab with one
  // leaf, and makes it active. Pass `resumeSessionId` to resume an
  // existing CC session rather than starting a fresh one.
  const newTab = useCallback(
    async (cwd: string, resumeSessionId?: string, kind?: SessionKind) => {
      let sessionId: SessionId
      try {
        sessionId = await sessionActions.spawn(cwd, { resumeSessionId, kind })
      } catch (err) {
        showToast(
          err instanceof Error && err.message.length > 0
            ? err.message
            : 'Failed to create session',
        )
        throw err
      }
      const tabId = crypto.randomUUID()
      const title = titleFromCwd(cwd)
      setState(prev => {
        const tab: Tab = {
          id: tabId,
          title,
          root: { type: 'leaf', sessionId },
          focusedSessionId: sessionId,
        }
        return {
          ...prev,
          tabs: [...prev.tabs, tab],
          activeTabId: tabId,
        }
      })
      return { tabId, sessionId }
    },
    [sessionActions, setState, showToast],
  )

  const closeTab = useCallback(
    async (tabId: TabId) => {
      const tab = state.tabs.find(t => t.id === tabId)
      if (!tab) return

      // Capture undo info before killing anything.
      const tabIdx = state.tabs.findIndex(t => t.id === tabId)
      const ids = collectLeaves(tab.root)
      const allMetas: Record<SessionId, SessionMeta> = {}
      for (const id of ids) {
        if (state.sessions[id]) allMetas[id] = state.sessions[id]
      }
      refs.undoStackRef.current.push({
        type: 'tab',
        closedAt: Date.now(),
        tab: { ...tab },
        tabIndex: tabIdx,
        sessionMetas: allMetas,
      })
      // Surface a brief undo hint. The label uses the tab title so
      // the user can confirm at a glance which thing they killed.
      showToast(`Closed “${tab.title}” — ⌘⇧T (Undo Close)`)

      // Kill every session in this tab.
      await Promise.all(ids.map(id => window.api.killSession(id)))
      setRuntimes(prev => {
        const next = { ...prev }
        for (const id of ids) delete next[id]
        return next
      })
      for (const id of ids) {
        delete refs.seenUuidsRef.current[id]
        delete refs.latestScreenRef.current[id]
      }
      setState(prev => {
        const tabs = prev.tabs.filter(t => t.id !== tabId)
        const sessions = { ...prev.sessions }
        for (const id of ids) delete sessions[id]
        const activeTabId =
          prev.activeTabId === tabId
            ? (tabs[0]?.id ?? '')
            : prev.activeTabId
        return { ...prev, tabs, activeTabId, sessions }
      })
      setTileTabs(prev => {
        if (!prev) return prev
        const sanitized = sanitizeTileTabsState({
          ...prev,
          tabIds: prev.tabIds.filter(id => id !== tabId),
          focusedTabId: prev.focusedTabId === tabId
            ? (prev.tabIds.find(id => id !== tabId) ?? prev.focusedTabId)
            : prev.focusedTabId,
        })
        return sanitized
      })
      setSpotlight(prev => (prev?.tabId === tabId ? null : prev))
      setReaderMode(prev => (prev?.tabId === tabId ? null : prev))
    },
    [
      refs.latestScreenRef,
      refs.seenUuidsRef,
      refs.undoStackRef,
      setReaderMode,
      setRuntimes,
      setSpotlight,
      setState,
      setTileTabs,
      showToast,
      state.sessions,
      state.tabs,
    ],
  )

  const activateTab = useCallback(
    (tabId: TabId) => {
      setState(prev => ({ ...prev, activeTabId: tabId }))
      setSpotlight(null)
      // Preserve tile-tabs mode when the activated tab is part of
      // the tiled set — just shift the focused tile. If it's NOT
      // part of the set, leave tile-tabs ALONE rather than nuking
      // the mode. The previous behavior (setting null) caused the
      // tile layout to silently collapse whenever the user clicked
      // any other tab in the bar, which read as a phantom
      // "auto-deselect."
      setTileTabs(prev => {
        if (!prev) return prev
        if (prev.tabIds.includes(tabId)) {
          return { ...prev, focusedTabId: tabId }
        }
        return prev
      })
    },
    [setSpotlight, setState, setTileTabs],
  )

  const activateTabByIndex = useCallback(
    (index: number) => {
      setState(prev => {
        const t = prev.tabs[index]
        return t ? { ...prev, activeTabId: t.id } : prev
      })
      setSpotlight(null)
      // Same preservation rule as activateTab — see comment there.
      setTileTabs(prev => {
        const target = refs.stateRef.current.tabs[index]
        if (!prev) return prev
        if (!target) return prev
        if (prev.tabIds.includes(target.id)) {
          return { ...prev, focusedTabId: target.id }
        }
        return prev
      })
    },
    [refs.stateRef, setSpotlight, setState, setTileTabs],
  )

  const nextTab = useCallback(() => {
    const tiled = tileTabs
    if (tiled && tiled.tabIds.length > 1) {
      const idx = tiled.tabIds.indexOf(tiled.focusedTabId)
      const nextId = tiled.tabIds[(idx + 1 + tiled.tabIds.length) % tiled.tabIds.length]
      setState(prev => ({ ...prev, activeTabId: nextId }))
      setTileTabs(prev => (prev ? { ...prev, focusedTabId: nextId } : prev))
      return
    }
    setState(prev => {
      const idx = prev.tabs.findIndex(t => t.id === prev.activeTabId)
      if (idx === -1) return prev
      const next = prev.tabs[(idx + 1) % prev.tabs.length]
      return { ...prev, activeTabId: next.id }
    })
    setSpotlight(null)
  }, [setSpotlight, setState, setTileTabs, tileTabs])

  const prevTab = useCallback(() => {
    const tiled = tileTabs
    if (tiled && tiled.tabIds.length > 1) {
      const idx = tiled.tabIds.indexOf(tiled.focusedTabId)
      const nextId =
        tiled.tabIds[(idx - 1 + tiled.tabIds.length) % tiled.tabIds.length]
      setState(prev => ({ ...prev, activeTabId: nextId }))
      setTileTabs(prev => (prev ? { ...prev, focusedTabId: nextId } : prev))
      return
    }
    setState(prev => {
      const idx = prev.tabs.findIndex(t => t.id === prev.activeTabId)
      if (idx === -1) return prev
      const next = prev.tabs[(idx - 1 + prev.tabs.length) % prev.tabs.length]
      return { ...prev, activeTabId: next.id }
    })
    setSpotlight(null)
  }, [setSpotlight, setState, setTileTabs, tileTabs])

  return {
    newTab,
    closeTab,
    activateTab,
    activateTabByIndex,
    nextTab,
    prevTab,
  }
}
