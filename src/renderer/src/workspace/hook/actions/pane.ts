import { useCallback } from 'react'

import type {
  BuriedPaneRecord,
  DispatchModeState,
  SessionId,
  SessionKind,
  SessionMeta,
  SplitDirection,
  Tab,
  TileNode,
} from '@renderer/workspace/types'
import { RATIO_DEFAULT } from '@renderer/workspace/types'
import {
  closeLeaf,
  collectLeaves,
  insertBesideLeaf,
  splitLeaf,
  wrapRootWithLeaf,
} from '@renderer/workspace/tile-tree/treeOps'
import { findBestRemainingFocus, findDirectionalNeighbor } from '@renderer/workspace/tile-tree/geometry'
import { findParentSplitInfo } from '@renderer/lib/undoClose'
import { titleFromCwd } from '@renderer/workspace/layout/helpers'
import type { PlacementTarget } from '@renderer/features/workspace/lib/newAgentPlacement'

import type {
  WorkspaceSetRuntimes,
  WorkspaceSetSpotlight,
  WorkspaceSetState,
  WorkspaceSetTileTabs,
} from '@renderer/workspace/hook/context'
import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'
import type { SessionActions } from '@renderer/workspace/hook/actions/session'

// -----------------------------------------------------------------------------
// Pane / focus / navigation actions.
//
// Covers: splitFocused, startNewAgentPlacement, commitNewAgentPlacement,
// closeFocused, closeSession, requestBuryFocused, buryFocused,
// reviveBuried, killBuried, focusSession, focusSessionInTab, navigate.
// -----------------------------------------------------------------------------

export function usePaneActions(
  state: {
    activeTabId: string
    dispatchMode: DispatchModeState | null
    sessions: Record<SessionId, SessionMeta>
    tabs: Tab[]
  },
  setState: WorkspaceSetState,
  setRuntimes: WorkspaceSetRuntimes,
  setSpotlight: WorkspaceSetSpotlight,
  setTileTabs: WorkspaceSetTileTabs,
  refs: WorkspaceRefs,
  showToast: (message: string, durationMs?: number) => void,
  openBuryPrompt: (sessionId: SessionId) => void,
  closeBuryPrompt: () => void,
  openNewAgentPlacement: () => void,
  closeNewAgentPlacement: () => void,
  sessionActions: SessionActions,
): {
  splitFocused: (direction: SplitDirection, kind?: SessionKind, resumeSessionId?: string) => Promise<void>
  startNewAgentPlacement: () => void
  commitNewAgentPlacement: (kind: SessionKind, target: PlacementTarget) => Promise<void>
  closeFocused: () => Promise<void>
  closeSession: (targetId: SessionId) => Promise<void>
  requestBuryFocused: () => void
  buryFocused: (note?: string, targetSessionId?: SessionId) => void
  reviveBuried: (buriedId: string) => void
  killBuried: (buriedId: string) => Promise<void>
  focusSession: (sessionId: SessionId) => void
  focusSessionInTab: (tabId: string, sessionId: SessionId) => void
  navigate: (direction: 'left' | 'right' | 'up' | 'down') => void
} {
  // Spawns a new session in the parent pane's cwd, inserts a new
  // leaf under a fresh split node, makes the new pane focused.
  const splitFocused = useCallback(
    async (
      direction: SplitDirection,
      kind: SessionKind = 'claude',
      resumeSessionId?: string,
    ) => {
      const tab = state.tabs.find(t => t.id === state.activeTabId)
      if (!tab) return
      const parentSessionId = tab.focusedSessionId
      const parentCwd = state.sessions[parentSessionId]?.cwd
      if (!parentCwd) return

      let newSessionId: SessionId
      try {
        newSessionId = await sessionActions.spawn(parentCwd, { kind, resumeSessionId })
      } catch (err) {
        showToast(
          err instanceof Error && err.message.length > 0
            ? err.message
            : 'Failed to split pane',
        )
        return
      }

      setState(prev => ({
        ...prev,
        tabs: prev.tabs.map(t => {
          if (t.id !== prev.activeTabId) return t
          return {
            ...t,
            root: splitLeaf(t.root, parentSessionId, direction, newSessionId),
            focusedSessionId: newSessionId,
          }
        }),
      }))
    },
    [sessionActions, setState, showToast, state.activeTabId, state.sessions, state.tabs],
  )

  const startNewAgentPlacement = useCallback(() => {
    const tab = state.tabs.find(t => t.id === state.activeTabId)
    if (!tab) return
    if (state.dispatchMode) {
      showToast('New Agent placement is only available in the tiled workspace')
      return
    }
    openNewAgentPlacement()
  }, [openNewAgentPlacement, showToast, state.activeTabId, state.dispatchMode, state.tabs])

  const commitNewAgentPlacement = useCallback(
    async (kind: SessionKind, target: PlacementTarget) => {
      const tab = state.tabs.find(t => t.id === state.activeTabId)
      if (!tab) return
      const anchorSessionId = tab.focusedSessionId
      const cwd = state.sessions[anchorSessionId]?.cwd
      if (!cwd) return

      let newSessionId: SessionId
      try {
        newSessionId = await sessionActions.spawn(cwd, { kind })
      } catch (err) {
        showToast(
          err instanceof Error && err.message.length > 0
            ? err.message
            : 'Failed to create pane',
        )
        return
      }
      setState(prev => ({
        ...prev,
        tabs: prev.tabs.map(currentTab => {
          if (currentTab.id !== prev.activeTabId) return currentTab
          return {
            ...currentTab,
            root:
              target.kind === 'wrap-root'
                ? wrapRootWithLeaf(
                    currentTab.root,
                    target.direction,
                    target.side,
                    newSessionId,
                  )
                : insertBesideLeaf(
                    currentTab.root,
                    target.targetSessionId,
                    target.direction,
                    RATIO_DEFAULT,
                    target.side,
                    newSessionId,
                  ),
            focusedSessionId: newSessionId,
          }
        }),
      }))
      closeNewAgentPlacement()
    },
    [
      closeNewAgentPlacement,
      sessionActions,
      setState,
      showToast,
      state.activeTabId,
      state.sessions,
      state.tabs,
    ],
  )

  // Removes the leaf from the tree and kills its session. If the
  // tree collapses to nothing, closes the whole tab. If that was
  // the last tab, leaves the workspace in an empty state — the UI
  // shows a welcome screen prompting for a new tab.
  //
  // Before destroying anything, we capture undo info and push it
  // onto the undo-close stack so the user can restore the pane (or
  // tab) with a single command within the next 2 minutes.
  const closeFocused = useCallback(async () => {
    const tab = state.tabs.find(t => t.id === state.activeTabId)
    if (!tab) return
    const targetId = tab.focusedSessionId
    const sessionMeta = state.sessions[targetId]

    // Capture undo info BEFORE mutating the tree. Two cases:
    //   1. Pane inside a split → record the parent split's geometry
    //      and the surviving sibling's anchor leaf so we can
    //      re-split.
    //   2. Last pane in a tab → record the whole tab so we can
    //      re-insert it at the same index.
    const parentInfo = findParentSplitInfo(tab.root, targetId)
    if (parentInfo && sessionMeta) {
      refs.undoStackRef.current.push({
        type: 'pane',
        closedAt: Date.now(),
        tabId: tab.id,
        sessionMeta,
        direction: parentInfo.direction,
        ratio: parentInfo.ratio,
        side: parentInfo.side,
        siblingLeafId: parentInfo.siblingLeafId,
      })
      // Pane-level close — show the kind+cwd basename so the user
      // can recognize which pane they killed when several look
      // alike.
      const kindLabel = sessionMeta.kind ?? 'claude'
      const cwdBase = sessionMeta.cwd.split('/').filter(Boolean).pop() ?? sessionMeta.cwd
      showToast(`Closed ${kindLabel} pane (${cwdBase}) — ⌘⇧T (Undo Close)`)
    } else if (!parentInfo && sessionMeta) {
      // This pane IS the root — closing it kills the tab. Capture
      // the tab-level undo entry.
      const tabIdx = state.tabs.findIndex(t => t.id === tab.id)
      const allMetas: Record<SessionId, SessionMeta> = {}
      for (const leafId of collectLeaves(tab.root)) {
        if (state.sessions[leafId]) allMetas[leafId] = state.sessions[leafId]
      }
      refs.undoStackRef.current.push({
        type: 'tab',
        closedAt: Date.now(),
        tab: { ...tab },
        tabIndex: tabIdx,
        sessionMetas: allMetas,
      })
      showToast(`Closed “${tab.title}” — ⌘⇧T (Undo Close)`)
    }

    await window.api.killSession(targetId)

    setRuntimes(prev => {
      const next = { ...prev }
      delete next[targetId]
      return next
    })
    delete refs.seenUuidsRef.current[targetId]
    delete refs.latestScreenRef.current[targetId]

    setState(prev => {
      const tabs = [...prev.tabs]
      const tabIdx = tabs.findIndex(t => t.id === prev.activeTabId)
      if (tabIdx === -1) return prev
      const currentTab = tabs[tabIdx]
      const nextRoot = closeLeaf(currentTab.root, targetId)

      if (nextRoot === null) {
        // Tab is now empty — close it and activate another tab.
        const remaining = tabs.filter((_, i) => i !== tabIdx)
        const sessions = { ...prev.sessions }
        delete sessions[targetId]
        return {
          ...prev,
          tabs: remaining,
          activeTabId: remaining[Math.max(0, tabIdx - 1)]?.id ?? '',
          sessions,
        }
      }

      const nextFocused =
        findBestRemainingFocus(currentTab.root, nextRoot, targetId) ??
        collectLeaves(nextRoot)[0]
      tabs[tabIdx] = {
        ...currentTab,
        root: nextRoot,
        focusedSessionId: nextFocused,
      }
      const sessions = { ...prev.sessions }
      delete sessions[targetId]
      return { ...prev, tabs, sessions }
    })
  }, [
    refs.latestScreenRef,
    refs.seenUuidsRef,
    refs.undoStackRef,
    setRuntimes,
    setState,
    showToast,
    state.activeTabId,
    state.sessions,
    state.tabs,
  ])

  // Mirrors closeFocused but operates on a caller-specified session
  // instead of the active tab's focused pane. Exists so UI surfaces
  // that list multiple panes at once (e.g. the Agent Activity
  // modal) can close stale sessions without first having to
  // focus-then-close, which would jank the visible layout for every
  // close and race with React's batched setState.
  //
  // Uses stateRef.current for the same reason buryFocused does: the
  // caller's action isn't bound to whatever happens to be active.
  const closeSession = useCallback(
    async (targetId: SessionId) => {
      const snapshot = refs.stateRef.current
      const owningTab = snapshot.tabs.find(t => collectLeaves(t.root).includes(targetId))
      if (!owningTab) return
      const sessionMeta = snapshot.sessions[targetId]

      // Same two-case undo capture as closeFocused: pane-in-split
      // vs. last-pane-in-tab. Keeps ⌘⇧T working for modal-driven
      // closes.
      const parentInfo = findParentSplitInfo(owningTab.root, targetId)
      if (parentInfo && sessionMeta) {
        refs.undoStackRef.current.push({
          type: 'pane',
          closedAt: Date.now(),
          tabId: owningTab.id,
          sessionMeta,
          direction: parentInfo.direction,
          ratio: parentInfo.ratio,
          side: parentInfo.side,
          siblingLeafId: parentInfo.siblingLeafId,
        })
        const kindLabel = sessionMeta.kind ?? 'claude'
        const cwdBase = sessionMeta.cwd.split('/').filter(Boolean).pop() ?? sessionMeta.cwd
        showToast(`Closed ${kindLabel} pane (${cwdBase}) — ⌘⇧T (Undo Close)`)
      } else if (!parentInfo && sessionMeta) {
        const tabIdx = snapshot.tabs.findIndex(t => t.id === owningTab.id)
        const allMetas: Record<SessionId, SessionMeta> = {}
        for (const leafId of collectLeaves(owningTab.root)) {
          if (snapshot.sessions[leafId]) allMetas[leafId] = snapshot.sessions[leafId]
        }
        refs.undoStackRef.current.push({
          type: 'tab',
          closedAt: Date.now(),
          tab: { ...owningTab },
          tabIndex: tabIdx,
          sessionMetas: allMetas,
        })
        showToast(`Closed “${owningTab.title}” — ⌘⇧T (Undo Close)`)
      }

      await window.api.killSession(targetId)

      setRuntimes(prev => {
        const next = { ...prev }
        delete next[targetId]
        return next
      })
      delete refs.seenUuidsRef.current[targetId]
      delete refs.latestScreenRef.current[targetId]

      setState(prev => {
        const tabs = [...prev.tabs]
        const tabIdx = tabs.findIndex(t => t.id === owningTab.id)
        // Tab may have been closed between modal-open and confirm.
        // Treat that as a no-op — the row will disappear on next
        // render anyway via the "visible sessions" selector.
        if (tabIdx === -1) return prev
        const currentTab = tabs[tabIdx]
        const nextRoot = closeLeaf(currentTab.root, targetId)

        if (nextRoot === null) {
          const remaining = tabs.filter((_, i) => i !== tabIdx)
          const sessions = { ...prev.sessions }
          delete sessions[targetId]
          // Only retarget activeTabId if we just removed the active
          // tab. Closing a pane in a BACKGROUND tab from the modal
          // must not yank the user out of the tab they see when the
          // modal closes.
          const nextActiveTabId = prev.activeTabId === owningTab.id
            ? (remaining[Math.max(0, tabIdx - 1)]?.id ?? '')
            : prev.activeTabId
          return {
            ...prev,
            tabs: remaining,
            activeTabId: nextActiveTabId,
            sessions,
          }
        }

        const nextFocused =
          findBestRemainingFocus(currentTab.root, nextRoot, targetId) ??
          collectLeaves(nextRoot)[0]
        tabs[tabIdx] = {
          ...currentTab,
          root: nextRoot,
          focusedSessionId: nextFocused,
        }
        const sessions = { ...prev.sessions }
        delete sessions[targetId]
        return { ...prev, tabs, sessions }
      })
    },
    [
      refs.latestScreenRef,
      refs.seenUuidsRef,
      refs.stateRef,
      refs.undoStackRef,
      setRuntimes,
      setState,
      showToast,
    ],
  )

  // Bury: remove the focused pane from the visible layout without
  // killing the underlying session. The session keeps running in
  // the background and remains eligible for revive.
  const requestBuryFocused = useCallback(() => {
    const tab = refs.stateRef.current.tabs.find(
      t => t.id === refs.stateRef.current.activeTabId,
    )
    if (!tab) return
    openBuryPrompt(tab.focusedSessionId)
  }, [openBuryPrompt, refs.stateRef])

  const buryFocused = useCallback(
    (note?: string, targetSessionId?: SessionId) => {
      // The bury prompt is modal on a specific session, not a
      // specific tab. It can outlive a tab switch: user opens the
      // prompt on pane X in tab A, switches to tab B, then hits
      // Enter. Earlier we resolved `tab` via `state.activeTabId`,
      // which meant that confirm-after-switch mutated tab B's tree
      // even though targetId still pointed at pane X in tab A.
      // Resolve the owning tab from the target session instead.
      const snapshot = refs.stateRef.current
      const activeTab = snapshot.tabs.find(t => t.id === snapshot.activeTabId)
      const targetId = targetSessionId ?? activeTab?.focusedSessionId
      if (!targetId) return

      const owningTab = snapshot.tabs.find(t => collectLeaves(t.root).includes(targetId))
      if (!owningTab) return

      const sessionMeta = snapshot.sessions[targetId]
      if (!sessionMeta) return

      const parentInfo = findParentSplitInfo(owningTab.root, targetId)
      const tabIndex = snapshot.tabs.findIndex(t => t.id === owningTab.id)
      const buriedRecord: BuriedPaneRecord = {
        id: targetId,
        sessionId: targetId,
        sessionMeta,
        buriedAt: Date.now(),
        sourceTabId: owningTab.id,
        sourceTabTitle: owningTab.title,
        sourceTabIndex: tabIndex,
        direction: parentInfo?.direction,
        ratio: parentInfo?.ratio,
        side: parentInfo?.side,
        siblingLeafId: parentInfo?.siblingLeafId,
        note: note?.trim() ? note.trim() : undefined,
      }

      const kindLabel = sessionMeta.kind ?? 'claude'
      const cwdBase = sessionMeta.cwd.split('/').filter(Boolean).pop() ?? sessionMeta.cwd
      showToast(`Buried ${kindLabel} pane (${cwdBase})`)

      setState(prev => {
        const tabs = [...prev.tabs]
        const tabIdx = tabs.findIndex(t => t.id === owningTab.id)
        // Tab may have been closed between prompt-open and confirm.
        // Treat that as a no-op rather than mutating an unrelated tab.
        if (tabIdx === -1) return prev

        const currentTab = tabs[tabIdx]
        const nextRoot = closeLeaf(currentTab.root, targetId)
        if (nextRoot === null) {
          const remaining = tabs.filter((_, i) => i !== tabIdx)
          // Only retarget activeTabId if we just removed the active
          // tab. Burying a pane in a background tab must not yank
          // the user out of the tab they're currently looking at.
          const nextActiveTabId = prev.activeTabId === owningTab.id
            ? (remaining[Math.max(0, tabIdx - 1)]?.id ?? '')
            : prev.activeTabId
          return {
            ...prev,
            tabs: remaining,
            activeTabId: nextActiveTabId,
            buried: [
              ...prev.buried.filter(entry => entry.sessionId !== targetId),
              buriedRecord,
            ],
          }
        }

        const nextFocused =
          findBestRemainingFocus(currentTab.root, nextRoot, targetId) ??
          collectLeaves(nextRoot)[0]
        tabs[tabIdx] = {
          ...currentTab,
          root: nextRoot,
          focusedSessionId: nextFocused,
        }
        return {
          ...prev,
          tabs,
          buried: [
            ...prev.buried.filter(entry => entry.sessionId !== targetId),
            buriedRecord,
          ],
        }
      })
      setSpotlight(prev => (prev?.tabId === owningTab.id ? null : prev))
      closeBuryPrompt()
    },
    [closeBuryPrompt, refs.stateRef, setSpotlight, setState, showToast],
  )

  // Restores a buried session into the most plausible visible
  // location. First choice is the original sibling anchor, then the
  // original tab, then the best current tab by cwd/kind/title
  // affinity, and finally a fresh single-pane tab if no good target
  // exists.
  const reviveBuried = useCallback(
    (buriedId: string) => {
      const current = refs.stateRef.current
      const entry = current.buried.find(item => item.id === buriedId)
      if (!entry) return

      const chooseFallbackTab = (): Tab | null => {
        const scored = current.tabs
          .map(tab => {
            let score = 0
            if (tab.id === entry.sourceTabId) score += 100
            if (tab.title === entry.sourceTabTitle) score += 20
            const leafIds = collectLeaves(tab.root)
            for (const leafId of leafIds) {
              const meta = current.sessions[leafId]
              if (!meta) continue
              if (meta.cwd === entry.sessionMeta.cwd) score += 15
              if ((meta.kind ?? 'claude') === (entry.sessionMeta.kind ?? 'claude')) score += 5
            }
            return { tab, score }
          })
          .filter(candidate => candidate.score > 0)
          .sort((a, b) => b.score - a.score)
        return scored[0]?.tab ?? current.tabs[0] ?? null
      }

      const anchorTab = entry.siblingLeafId
        ? current.tabs.find(tab => collectLeaves(tab.root).includes(entry.siblingLeafId!))
        : null
      const targetTab = anchorTab ?? chooseFallbackTab()

      setState(prev => {
        const nextBuried = prev.buried.filter(item => item.id !== buriedId)

        if (!targetTab) {
          const tabId = crypto.randomUUID()
          const title = titleFromCwd(entry.sessionMeta.cwd)
          const revivedTab: Tab = {
            id: tabId,
            title,
            root: { type: 'leaf', sessionId: entry.sessionId },
            focusedSessionId: entry.sessionId,
          }
          return {
            ...prev,
            tabs: [...prev.tabs, revivedTab],
            activeTabId: tabId,
            buried: nextBuried,
          }
        }

        const target = prev.tabs.find(tab => tab.id === targetTab.id)
        if (!target) {
          const tabId = crypto.randomUUID()
          const title = titleFromCwd(entry.sessionMeta.cwd)
          const revivedTab: Tab = {
            id: tabId,
            title,
            root: { type: 'leaf', sessionId: entry.sessionId },
            focusedSessionId: entry.sessionId,
          }
          return {
            ...prev,
            tabs: [...prev.tabs, revivedTab],
            activeTabId: tabId,
            buried: nextBuried,
          }
        }

        const leafIds = collectLeaves(target.root)
        const cwdLeaf =
          leafIds.find(leafId => prev.sessions[leafId]?.cwd === entry.sessionMeta.cwd) ?? null
        const anchorLeafId =
          (entry.siblingLeafId && leafIds.includes(entry.siblingLeafId))
            ? entry.siblingLeafId
            : (cwdLeaf ?? target.focusedSessionId ?? leafIds[0] ?? null)

        if (!anchorLeafId) {
          const tabId = crypto.randomUUID()
          const title = titleFromCwd(entry.sessionMeta.cwd)
          const revivedTab: Tab = {
            id: tabId,
            title,
            root: { type: 'leaf', sessionId: entry.sessionId },
            focusedSessionId: entry.sessionId,
          }
          return {
            ...prev,
            tabs: [...prev.tabs, revivedTab],
            activeTabId: tabId,
            buried: nextBuried,
          }
        }

        const revivedRoot = insertBesideLeaf(
          target.root,
          anchorLeafId,
          entry.direction ?? 'vertical',
          entry.ratio ?? RATIO_DEFAULT,
          entry.side ?? 'b',
          entry.sessionId,
        )

        return {
          ...prev,
          tabs: prev.tabs.map(tab =>
            tab.id === target.id
              ? {
                  ...tab,
                  root: revivedRoot,
                  focusedSessionId: entry.sessionId,
                }
              : tab,
          ),
          activeTabId: target.id,
          buried: nextBuried,
        }
      })
    },
    [refs.stateRef, setState],
  )

  const killBuried = useCallback(
    async (buriedId: string) => {
      const snapshot = refs.stateRef.current
      const entry = snapshot.buried.find(item => item.id === buriedId)
      if (!entry) return

      // Buried panes are live sessions removed from every visible tab
      // tree. `closeSession` intentionally only handles visible panes
      // because it needs tree geometry and undo-close placement data;
      // using it here would no-op. Killing a buried pane is a different
      // operation: terminate the hidden backend and delete the buried
      // record directly, without briefly reviving or mutating layout.
      await window.api.killSession(entry.sessionId)

      setRuntimes(prev => {
        const next = { ...prev }
        delete next[entry.sessionId]
        return next
      })
      delete refs.seenUuidsRef.current[entry.sessionId]
      delete refs.latestScreenRef.current[entry.sessionId]
      const bootstrapTimer = refs.bootstrapTimersRef.current.get(entry.sessionId)
      if (bootstrapTimer) {
        clearTimeout(bootstrapTimer)
        refs.bootstrapTimersRef.current.delete(entry.sessionId)
      }
      const paneToastTimer = refs.paneToastTimers.current[entry.sessionId]
      if (paneToastTimer) {
        clearTimeout(paneToastTimer)
        delete refs.paneToastTimers.current[entry.sessionId]
      }

      setState(prev => {
        const sessions = { ...prev.sessions }
        delete sessions[entry.sessionId]
        return {
          ...prev,
          sessions,
          buried: prev.buried.filter(item => item.id !== buriedId),
        }
      })

      const kindLabel = entry.sessionMeta.kind ?? 'claude'
      const cwdBase = entry.sessionMeta.cwd.split('/').filter(Boolean).pop() ?? entry.sessionMeta.cwd
      showToast(`Killed buried ${kindLabel} pane (${cwdBase})`)
    },
    [
      refs.bootstrapTimersRef,
      refs.latestScreenRef,
      refs.paneToastTimers,
      refs.seenUuidsRef,
      refs.stateRef,
      setRuntimes,
      setState,
      showToast,
    ],
  )

  const focusSession = useCallback(
    (sessionId: SessionId) => {
      setState(prev => ({
        ...prev,
        tabs: prev.tabs.map(t =>
          t.id === prev.activeTabId ? { ...t, focusedSessionId: sessionId } : t,
        ),
      }))
      setRuntimes(prev => {
        const current = prev[sessionId]
        if (!current || (current.unreadSince === null && current.unreadKind === null)) return prev
        return {
          ...prev,
          [sessionId]: { ...current, unreadSince: null, unreadKind: null },
        }
      })
      setSpotlight(prev => (
        prev && prev.tabId === refs.stateRef.current.activeTabId
          ? { ...prev, focusedSessionId: sessionId }
          : prev
      ))
    },
    [refs.stateRef, setRuntimes, setSpotlight, setState],
  )

  const focusSessionInTab = useCallback(
    (tabId: string, sessionId: SessionId) => {
      setState(prev => ({
        ...prev,
        activeTabId: tabId,
        tabs: prev.tabs.map(t =>
          t.id === tabId ? { ...t, focusedSessionId: sessionId } : t,
        ),
      }))
      setRuntimes(prev => {
        const current = prev[sessionId]
        if (!current || (current.unreadSince === null && current.unreadKind === null)) return prev
        return {
          ...prev,
          [sessionId]: { ...current, unreadSince: null, unreadKind: null },
        }
      })
      setSpotlight(prev => (
        prev && prev.tabId === tabId
          ? { ...prev, focusedSessionId: sessionId }
          : prev
      ))
      setTileTabs(prev => (
        prev && prev.tabIds.includes(tabId)
          ? { ...prev, focusedTabId: tabId }
          : prev
      ))
    },
    [setRuntimes, setSpotlight, setState, setTileTabs],
  )

  const navigate = useCallback(
    (direction: 'left' | 'right' | 'up' | 'down') => {
      const tab = state.tabs.find(t => t.id === state.activeTabId)
      if (!tab) return
      const next = findDirectionalNeighbor(tab.root, tab.focusedSessionId, direction)
      if (next) focusSession(next)
    },
    [focusSession, state.activeTabId, state.tabs],
  )

  return {
    splitFocused,
    startNewAgentPlacement,
    commitNewAgentPlacement,
    closeFocused,
    closeSession,
    requestBuryFocused,
    buryFocused,
    reviveBuried,
    killBuried,
    focusSession,
    focusSessionInTab,
    navigate,
  }
}
