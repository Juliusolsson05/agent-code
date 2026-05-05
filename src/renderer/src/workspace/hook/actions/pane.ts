import { useCallback, useRef } from 'react'

import type {
  BuriedPaneRecord,
  DispatchModeState,
  SessionId,
  SessionKind,
  SessionMeta,
  SplitDirection,
  Tab,
  TileNode,
  WorkspaceState,
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
import {
  buildDispatchGroups,
  flattenDispatchRows,
  selectVisibleDispatchRow,
} from '@renderer/workspace/dispatch/dispatchSelectors'
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
  createDetachedDispatchAgent: (kind: Exclude<SessionKind, 'terminal'>) => Promise<void>
  attachDetachedToGrid: (sessionId: SessionId, target: PlacementTarget) => void
  detachFocusedToDispatch: () => void
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
  const closeSessionRef = useRef<((targetId: SessionId) => Promise<void>) | null>(null)

  // Spawns a new session in the parent pane's cwd, inserts a new
  // leaf under a fresh split node, makes the new pane focused.
  const splitFocused = useCallback(
    async (
      direction: SplitDirection,
      kind: SessionKind = 'claude',
      resumeSessionId?: string,
    ) => {
      const dispatchSnapshot = refs.stateRef.current
      if (dispatchSnapshot.dispatchMode && kind !== 'terminal') {
        const tab = dispatchSnapshot.tabs.find(t => t.id === dispatchSnapshot.activeTabId)
        if (!tab) return

        const leafIds = collectLeaves(tab.root)
        const focusedDispatchId = dispatchSnapshot.dispatchMode.focusedSessionId
        const cwd =
          (focusedDispatchId ? dispatchSnapshot.sessions[focusedDispatchId]?.cwd : null) ??
          dispatchSnapshot.sessions[tab.focusedSessionId]?.cwd ??
          leafIds.map(id => dispatchSnapshot.sessions[id]?.cwd).find(Boolean)
        if (!cwd) {
          showToast('Could not create dispatch agent: no project directory found')
          return
        }

        let sessionId: SessionId
        try {
          sessionId = await sessionActions.spawn(cwd, { kind, resumeSessionId })
        } catch (err) {
          showToast(
            err instanceof Error && err.message.length > 0
              ? err.message
              : 'Failed to create dispatch agent',
          )
          return
        }

        setState(prev => {
          const latestTab = prev.tabs.find(t => t.id === tab.id)
          const projectTabIndex = prev.tabs.findIndex(t => t.id === tab.id)
          if (!latestTab) return prev

          // WHY splitFocused owns this Dispatch detour instead of making every
          // keybinding and command-palette entry remember Dispatch Mode:
          // `splitFocused` is the old "make me a new agent" primitive. Before
          // detached sessions, routing that through the tile tree was correct.
          // In Dispatch Mode it is now wrong: the command-center surface can
          // create many agents, and those agents must not mutate the normal grid
          // just because the user used the familiar Option-D/Option-C grammar.
          // Keeping the rule here makes all callers agree: normal mode splits
          // the grid; Dispatch Mode creates a detached dispatch row and focuses
          // it immediately.
          return {
            ...prev,
            activeTabId: latestTab.id,
            detachedSessions: {
              ...prev.detachedSessions,
              [sessionId]: {
                sessionId,
                surface: 'dispatch',
                projectTabId: latestTab.id,
                projectTabTitle: latestTab.title,
                projectTabIndex: projectTabIndex >= 0 ? projectTabIndex : 0,
                detachedAt: Date.now(),
              },
            },
            dispatchMode: prev.dispatchMode
              ? { ...prev.dispatchMode, focusedSessionId: sessionId }
              : prev.dispatchMode,
          }
        })
        closeNewAgentPlacement()
        return
      }

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
    [
      closeNewAgentPlacement,
      refs.stateRef,
      sessionActions,
      setState,
      showToast,
      state.activeTabId,
      state.sessions,
      state.tabs,
    ],
  )

  const startNewAgentPlacement = useCallback(() => {
    const tab = state.tabs.find(t => t.id === state.activeTabId)
    if (!tab) return
    openNewAgentPlacement()
  }, [openNewAgentPlacement, state.activeTabId, state.tabs])

  const createDetachedDispatchAgent = useCallback(
    async (kind: Exclude<SessionKind, 'terminal'>) => {
      const snapshot = refs.stateRef.current
      const tab = snapshot.tabs.find(t => t.id === snapshot.activeTabId)
      if (!tab) return

      const leafIds = collectLeaves(tab.root)
      const focusedDispatchId = snapshot.dispatchMode?.focusedSessionId
      const cwd =
        (focusedDispatchId ? snapshot.sessions[focusedDispatchId]?.cwd : null) ??
        snapshot.sessions[tab.focusedSessionId]?.cwd ??
        leafIds.map(id => snapshot.sessions[id]?.cwd).find(Boolean)
      if (!cwd) {
        showToast('Could not create dispatch agent: no project directory found')
        return
      }

      let sessionId: SessionId
      try {
        sessionId = await sessionActions.spawn(cwd, { kind })
      } catch (err) {
        showToast(
          err instanceof Error && err.message.length > 0
            ? err.message
            : 'Failed to create dispatch agent',
        )
        return
      }

      setState(prev => {
        const latestTab = prev.tabs.find(t => t.id === tab.id)
        const projectTabIndex = prev.tabs.findIndex(t => t.id === tab.id)
        if (!latestTab) return prev
        // Detached sessions are live workspace sessions with project affinity,
        // not children of Dispatch Mode. We deliberately do not insert this id
        // into latestTab.root, because the whole point is that creating ten
        // command-center agents must not explode the normal grid when Dispatch
        // Mode is turned off.
        return {
          ...prev,
          activeTabId: latestTab.id,
          detachedSessions: {
            ...prev.detachedSessions,
            [sessionId]: {
              sessionId,
              surface: 'dispatch',
              projectTabId: latestTab.id,
              projectTabTitle: latestTab.title,
              projectTabIndex: projectTabIndex >= 0 ? projectTabIndex : 0,
              detachedAt: Date.now(),
            },
          },
          dispatchMode: prev.dispatchMode
            ? { ...prev.dispatchMode, focusedSessionId: sessionId }
            : prev.dispatchMode,
        }
      })
      closeNewAgentPlacement()
    },
    [closeNewAgentPlacement, refs.stateRef, sessionActions, setState, showToast],
  )

  // Promote a detached dispatch session into the grid at a chosen
  // placement target.
  //
  // WHY this is a synchronous setState and not an IPC round-trip:
  // attaching is purely a workspace-state mutation. The session is
  // already running in the backend and already has a renderer runtime
  // entry — we are just moving its identity from `detachedSessions`
  // into a leaf in `tab.root`. No spawn, no kill, no IPC. That also
  // means no ghost window and no transcript flicker; the UI seam is
  // invisible to the user beyond the layout change.
  //
  // The target tab need not equal the detached record's projectTabId.
  // projectTabId was always *affinity* (cwd defaults / dispatch
  // grouping / terminal selection), never *ownership*. Letting the
  // user pin a project-A detached agent into project-B's grid is the
  // whole point of having a placement step.
  const attachDetachedToGrid = useCallback(
    (sessionId: SessionId, target: PlacementTarget) => {
      setState(prev => {
        const detached = prev.detachedSessions[sessionId]
        if (!detached) return prev
        const targetTab = prev.tabs.find(t => t.id === prev.activeTabId)
        if (!targetTab) return prev
        // For a split-leaf target, the anchor must still exist in the
        // chosen tab's tree. The placement overlay computes targets from
        // a snapshot of the tree, so a stale target after a concurrent
        // tab close would silently no-op via insertBesideLeaf returning
        // the input. Bail with no state change so the user can re-open
        // the picker rather than getting a confusing "I clicked place
        // and nothing happened."
        if (target.kind === 'split-leaf') {
          const anchorStillThere = collectLeaves(targetTab.root).includes(target.targetSessionId)
          if (!anchorStillThere) return prev
        }
        const detachedSessions = { ...prev.detachedSessions }
        delete detachedSessions[sessionId]
        return {
          ...prev,
          detachedSessions,
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
                      sessionId,
                    )
                  : insertBesideLeaf(
                      currentTab.root,
                      target.targetSessionId,
                      target.direction,
                      RATIO_DEFAULT,
                      target.side,
                      sessionId,
                    ),
              focusedSessionId: sessionId,
            }
          }),
          // Drop dispatch focus if it was pointing at this session —
          // the session now lives in the grid, and grid focus on the
          // active tab is what owns selection going forward. Leaving
          // the dispatch focus pointing at a now-grid-placed session
          // would make the dispatch list highlight a row that has
          // moved out of detachedSessions on the next render.
          dispatchMode:
            prev.dispatchMode?.focusedSessionId === sessionId
              ? { ...prev.dispatchMode, focusedSessionId: undefined }
              : prev.dispatchMode,
        }
      })
    },
    [setState],
  )

  // The reverse direction: take the focused grid pane out of the tile
  // tree without killing its session, and add it to the dispatch
  // detached bucket.
  //
  // Refuses in three cases, each surfaced as a toast so the user
  // understands why nothing happened:
  //   1. No focused session — nothing to detach.
  //   2. Focused session is a terminal — terminals already have a
  //      first-class slot in Dispatch (the right-hand project terminal),
  //      so detaching one would create two terminals fighting for the
  //      same surface.
  //   3. The focused pane is the only leaf in its tab — closeLeaf would
  //      return null and the tab.root type cannot represent an empty
  //      tree. We don't want to silently close the tab either, so we
  //      refuse and ask the user to add another pane first.
  const detachFocusedToDispatch = useCallback(() => {
    const snapshot = refs.stateRef.current
    const tab = snapshot.tabs.find(t => t.id === snapshot.activeTabId)
    if (!tab) return
    const sessionId = tab.focusedSessionId
    if (!sessionId) {
      showToast('No focused agent to detach')
      return
    }
    const meta = snapshot.sessions[sessionId]
    if (!meta) return
    if (meta.kind === 'terminal') {
      showToast('Terminals cannot be detached to Dispatch')
      return
    }
    const leaves = collectLeaves(tab.root)
    if (leaves.length <= 1) {
      showToast('Cannot detach the last pane in a tab — add another agent first')
      return
    }
    const tabIndex = snapshot.tabs.findIndex(t => t.id === tab.id)

    setState(prev => {
      const latestTab = prev.tabs.find(t => t.id === tab.id)
      if (!latestTab) return prev
      const nextRoot = closeLeaf(latestTab.root, sessionId)
      // Defensive guard: closeLeaf returning null here would mean a
      // race against a concurrent close emptied the tab between the
      // snapshot read and the setState. The leaves.length check above
      // already filtered the common case; this is for race-window
      // safety so the type stays sound.
      if (!nextRoot) return prev
      const nextLeafIds = collectLeaves(nextRoot)
      const nextFocus =
        latestTab.focusedSessionId === sessionId
          ? nextLeafIds[0] ?? ''
          : latestTab.focusedSessionId

      return {
        ...prev,
        tabs: prev.tabs.map(t =>
          t.id === tab.id
            ? { ...t, root: nextRoot, focusedSessionId: nextFocus }
            : t,
        ),
        detachedSessions: {
          ...prev.detachedSessions,
          [sessionId]: {
            sessionId,
            surface: 'dispatch',
            projectTabId: tab.id,
            projectTabTitle: latestTab.title,
            projectTabIndex: tabIndex >= 0 ? tabIndex : 0,
            detachedAt: Date.now(),
          },
        },
        // If Dispatch is currently active, focus the freshly detached
        // agent so the user sees the result of their action. If
        // Dispatch is not active, leave dispatchMode alone — toggling
        // into Dispatch later will pick this up via the existing
        // first-row fallback in selectActiveRow.
        dispatchMode: prev.dispatchMode
          ? { ...prev.dispatchMode, focusedSessionId: sessionId }
          : prev.dispatchMode,
      }
    })
    const cwdBase = meta.cwd.split('/').filter(Boolean).pop() ?? 'agent'
    showToast(`Detached "${cwdBase}" to Dispatch`)
  }, [refs.stateRef, setState, showToast])


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
    const snapshot = refs.stateRef.current
    const activeTab = snapshot.tabs.find(t => t.id === snapshot.activeTabId)
    const dispatchRows = snapshot.dispatchMode
      ? flattenDispatchRows(buildDispatchGroups(snapshot))
      : []
    const dispatchTargetId = snapshot.dispatchMode
      ? selectVisibleDispatchRow(
          dispatchRows,
          snapshot.dispatchMode.focusedSessionId,
          activeTab?.focusedSessionId,
        )?.sessionId
      : null
    if (dispatchTargetId) {
      // WHY Dispatch Mode delegates by the visible row's explicit id:
      //
      // Tab.focusedSessionId is intentionally grid-only. Dispatch selection can
      // point at a detached agent that has no tile-tree leaf, or at a grid
      // agent without mutating the underlying tab focus. The old close path
      // always read activeTab.focusedSessionId, so closing from Dispatch could
      // kill whichever grid pane happened to be focused underneath the visible
      // dispatch row. `closeSession` already owns the explicit-id close
      // semantics for both detached and grid sessions.
      //
      // We still cannot trust dispatchMode.focusedSessionId blindly: after a
      // scope switch, rehydrate miss, or rapid close, it may point at an id that
      // is no longer present in the visible Dispatch rows. DispatchLayout falls
      // back to grid focus and then the first visible row in that case, so close
      // must use the same row-derived target or the highlighted pane and the
      // destructive target diverge again.
      await closeSessionRef.current?.(dispatchTargetId)
      return
    }
    if (snapshot.dispatchMode) return

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
    refs.stateRef,
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
      const sessionMeta = snapshot.sessions[targetId]
      const detached = snapshot.detachedSessions[targetId]
      if (!owningTab && !detached) return

      if (!owningTab && detached) {
        await window.api.killSession(targetId)

        setRuntimes(prev => {
          const next = { ...prev }
          delete next[targetId]
          return next
        })
        delete refs.seenUuidsRef.current[targetId]
        delete refs.latestScreenRef.current[targetId]

        setState(prev => {
          const sessions = { ...prev.sessions }
          delete sessions[targetId]
          const detachedSessions = { ...prev.detachedSessions }
          delete detachedSessions[targetId]
          const next = {
            ...prev,
            sessions,
            detachedSessions,
          }
          return {
            ...next,
            dispatchMode: dispatchModeAfterSessionRemoval(prev, next, targetId),
          }
        })
        const kindLabel = sessionMeta?.kind ?? 'claude'
        const cwdBase = sessionMeta?.cwd.split('/').filter(Boolean).pop() ?? sessionMeta?.cwd ?? 'agent'
        showToast(`Closed detached ${kindLabel} agent (${cwdBase})`)
        return
      }
      if (!owningTab) return

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
            dispatchMode: dispatchModeAfterSessionRemoval(
              prev,
              {
                ...prev,
                tabs: remaining,
                activeTabId: nextActiveTabId,
                sessions,
              },
              targetId,
            ),
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
        const next = { ...prev, tabs, sessions }
        return {
          ...next,
          dispatchMode: dispatchModeAfterSessionRemoval(prev, next, targetId),
        }
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
  closeSessionRef.current = closeSession

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
      setSpotlight(prev => (
        prev && prev.tabId === refs.stateRef.current.activeTabId
          ? { ...prev, focusedSessionId: sessionId }
          : prev
      ))
    },
    [refs.stateRef, setSpotlight, setState],
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
    [setSpotlight, setState, setTileTabs],
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
    createDetachedDispatchAgent,
    attachDetachedToGrid,
    detachFocusedToDispatch,
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

function dispatchModeAfterSessionRemoval(
  before: WorkspaceState,
  after: WorkspaceState,
  removedSessionId: SessionId,
): DispatchModeState | null {
  if (!after.dispatchMode || after.dispatchMode.focusedSessionId !== removedSessionId) {
    // The user wasn't visibly commanding this row — leave Dispatch focus alone.
    //
    // This short-circuit matters because closeSession is also reached from
    // the Agent Activity modal, which kills *background* panes by id. Without
    // this branch, killing a stranger row would shuffle the user's visible
    // Dispatch selection on every removal.
    return after.dispatchMode
  }

  // Row-by-index successor selection.
  //
  // The previous version of this helper picked "first row in the same project
  // tab, else first row globally," which made closing row 6 of a project jump
  // visibly to row 1 — there is no list-UI convention where a delete moves
  // the cursor to the start of the list. Native list pickers (Finder, mail
  // clients, IDE file lists) all keep the cursor at the same visual position
  // after delete, falling back to the previous row when the deleted row was
  // last. We mirror that here so close-and-keep-going feels predictable.
  //
  // Why diff against `before` instead of just picking afterRows[0]:
  //   - The "same visual position" is only meaningful relative to where the
  //     removed row USED to be. We need the index from the pre-removal list
  //     to project it back into the post-removal list.
  //   - When removedIndex is past the end of afterRows (closed the last
  //     row), we fall back to afterRows[removedIndex - 1] so the cursor
  //     trails behind the deletion instead of leaping to the top.
  //
  // When removedIndex is -1 (the closed session wasn't in the visible scope
  // — e.g. project-scope close that collapsed the active tab and switched
  // activeTabId to a different project) we deliberately clear focus instead
  // of inventing a row. The DispatchLayout fallback effect will pick a sane
  // first-row default on the next render in the new scope.
  const beforeRows = flattenDispatchRows(buildDispatchGroups(before))
  const afterRows = flattenDispatchRows(buildDispatchGroups(after))
  const removedIndex = beforeRows.findIndex(row => row.sessionId === removedSessionId)
  const successor =
    removedIndex >= 0
      ? (afterRows[removedIndex] ?? afterRows[removedIndex - 1])
      : undefined

  return {
    ...after.dispatchMode,
    focusedSessionId: successor?.sessionId,
  }
}
