import { useCallback, useRef } from 'react'

import type {
  BuriedPaneRecord,
  DetachedSessionRecord,
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
  normalizeTree,
  splitLeaf,
  wrapRootWithLeaf,
  wrapRootWithNode,
} from '@renderer/workspace/tile-tree/treeOps'
import { findBestRemainingFocus, findDirectionalNeighbor } from '@renderer/workspace/tile-tree/geometry'
import { findParentSplitInfo } from '@renderer/lib/undoClose'
import { titleFromCwd } from '@renderer/workspace/layout/helpers'
import {
  buildVisibleDispatchRows,
  detachedDispatchSessionIdsForTab,
  resolveDispatchSpawnTarget,
  selectVisibleDispatchRow,
} from '@renderer/workspace/dispatch/dispatchSelectors'
import type { DispatchAgentRow } from '@renderer/workspace/dispatch/dispatchSelectors'
import {
  clearTiledLaneSessions,
  dispatchFocusedSessionId,
} from '@renderer/workspace/dispatch/tiledDispatchSelectors'
import { commandTargetSessionIdForState } from '@renderer/workspace/hook/selectors/commandTargetSessionId'
import type { PlacementTarget } from '@renderer/features/workspace/lib/newAgentPlacement'
import type { BuiltInMcpDomain } from '@mcp/shared/types'
import type {
  OrchestrationAgentKind,
  OrchestrationAgentRecord,
} from '@mcp/shared/orchestrationTypes'

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

// Update dispatchMode after a new dispatch agent is spawned. In Tiled
// Dispatch the new agent takes over the lane the user is commanding
// (target.laneIndex) so it appears where they were looking; in classic
// Dispatch it becomes the single focus. Setting focusedSessionId in both
// cases keeps classic focus coherent if the user later exits the tiled view.
// The lane index is re-validated here (a stale resolution could outrun a
// concurrent count change), falling back to a plain focus update.
function applyDispatchSpawnFocus(
  dispatchMode: DispatchModeState | null,
  sessionId: SessionId,
  laneIndex: number | null,
): DispatchModeState | null {
  if (!dispatchMode) return dispatchMode
  const tiled = dispatchMode.tiled
  if (laneIndex !== null && tiled && laneIndex >= 0 && laneIndex < tiled.lanes.length) {
    const lanes = tiled.lanes.map((lane, i) =>
      i === laneIndex ? { ...lane, selectedSessionId: sessionId } : lane,
    )
    return {
      ...dispatchMode,
      focusedSessionId: sessionId,
      tiled: { ...tiled, lanes, focusedLane: laneIndex },
    }
  }
  return { ...dispatchMode, focusedSessionId: sessionId }
}

export function usePaneActions(
  state: {
    activeTabId: string
    detachedSessions: Record<SessionId, DetachedSessionRecord>
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
  createLinkedAgent: (
    kind: Exclude<SessionKind, 'terminal'>,
    parentId: SessionId,
  ) => Promise<void>
  createOrchestrationAgent: (params: {
    parentId: SessionId
    kind: OrchestrationAgentKind
    cwd?: string
    title?: string
    role?: string
    runId?: string
    builtInMcpDomains?: BuiltInMcpDomain[]
  }) => Promise<OrchestrationAgentRecord>
  attachDetachedToGrid: (sessionId: SessionId, target: PlacementTarget) => Promise<void>
  attachAllDetachedForTab: (tabId: string) => Promise<void>
  detachFocusedToDispatch: () => void
  closeFocused: () => Promise<void>
  closeSession: (targetId: SessionId) => Promise<void>
  requestBuryFocused: () => void
  buryFocused: (note?: string, targetSessionId?: SessionId) => void
  reviveBuried: (buriedId: string) => Promise<void>
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
        // Same target resolution as createDetachedDispatchAgent: follow the
        // focused lane in Tiled Dispatch so cwd and projectTab agree on the
        // project the user is commanding (issue #266 / #248).
        const target = resolveDispatchSpawnTarget(dispatchSnapshot)
        const tab = dispatchSnapshot.tabs.find(t => t.id === target.tabId)
        if (!tab) return

        const leafIds = collectLeaves(tab.root)
        const cwd =
          (target.cwdSessionId ? dispatchSnapshot.sessions[target.cwdSessionId]?.cwd : null) ??
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
            dispatchMode: applyDispatchSpawnFocus(prev.dispatchMode, sessionId, target.laneIndex),
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
      // Resolve the target project ONCE so cwd and projectTab agree. In Tiled
      // Dispatch this follows the focused lane, not the stale active tab —
      // reading cwd from focusedSessionId while filing under activeTabId is the
      // bug this fixes (issue #266 / #248). See resolveDispatchSpawnTarget.
      const target = resolveDispatchSpawnTarget(snapshot)
      const tab = snapshot.tabs.find(t => t.id === target.tabId)
      if (!tab) return

      const leafIds = collectLeaves(tab.root)
      const cwd =
        (target.cwdSessionId ? snapshot.sessions[target.cwdSessionId]?.cwd : null) ??
        // Do NOT fall back to tab.focusedSessionId: in Tiled Dispatch that's
        // stale grid focus (the focused lane's session is already
        // target.cwdSessionId via resolveDispatchSpawnTarget). Fall back to any
        // leaf cwd of the resolved tab — all are valid project dirs for it.
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
          dispatchMode: applyDispatchSpawnFocus(prev.dispatchMode, sessionId, target.laneIndex),
        }
      })
      closeNewAgentPlacement()
    },
    [closeNewAgentPlacement, refs.stateRef, sessionActions, setState, showToast],
  )

  // Spawn a "linked agent" — a normal detached dispatch agent that
  // records `parentId` as its `linkedParentId`. It lands in the
  // PARENT's project tab (not necessarily the active tab), which is
  // what lets the dispatch list render it indented under the parent;
  // and the close path cascade-closes it when the parent goes away.
  //
  // WHY this is a sibling of createDetachedDispatchAgent rather than
  // a flag on it: createDetachedDispatchAgent always targets the
  // ACTIVE tab and the active dispatch focus. A linked agent is
  // anchored to wherever its PARENT lives — possibly a background
  // tab, possibly a grid pane — so the tab resolution and the
  // linkedParentId stamp are enough extra logic to warrant their own
  // action. Closing the overlay is the caller's job (the overlay
  // owns its own lifecycle via closeLinkedAgent).
  const createLinkedAgent = useCallback(
    async (kind: Exclude<SessionKind, 'terminal'>, parentId: SessionId) => {
      const snapshot = refs.stateRef.current
      const parentMeta = snapshot.sessions[parentId]
      if (!parentMeta) {
        showToast('Could not create linked agent: parent agent is gone')
        return
      }
      // If the parent is ITSELF a linked agent, anchor the new agent
      // to the same top-level parent — linked agents never chain, so
      // the dispatch nesting stays exactly one level deep (see the
      // note on SessionMeta.linkedParentId).
      const rootParentId = parentMeta.linkedParentId ?? parentId
      const rootParentMeta = snapshot.sessions[rootParentId] ?? parentMeta

      // Resolve the parent's tab: a detached parent carries its tab
      // id on the detachedSessions record; a grid parent is found by
      // the tab whose tile tree contains its leaf.
      const parentDetached = snapshot.detachedSessions[rootParentId]
      const parentTab = parentDetached
        ? snapshot.tabs.find(t => t.id === parentDetached.projectTabId)
        : snapshot.tabs.find(t => collectLeaves(t.root).includes(rootParentId))
      if (!parentTab) {
        showToast('Could not create linked agent: parent tab not found')
        return
      }

      let sessionId: SessionId
      try {
        sessionId = await sessionActions.spawn(rootParentMeta.cwd, { kind })
      } catch (err) {
        showToast(
          err instanceof Error && err.message.length > 0
            ? err.message
            : 'Failed to create linked agent',
        )
        return
      }

      setState(prev => {
        const latestTab = prev.tabs.find(t => t.id === parentTab.id)
        const projectTabIndex = prev.tabs.findIndex(t => t.id === parentTab.id)
        if (!latestTab) return prev
        return {
          ...prev,
          activeTabId: latestTab.id,
          // Stamp the parent link onto the freshly-spawned child's
          // meta. spawn() already inserted sessions[sessionId]; we
          // patch that entry rather than racing spawn's own setState.
          sessions: {
            ...prev.sessions,
            [sessionId]: {
              ...(prev.sessions[sessionId] ?? { cwd: rootParentMeta.cwd, kind }),
              linkedParentId: rootParentId,
            },
          },
          // A linked agent is a detached dispatch agent — same record
          // shape as createDetachedDispatchAgent, just anchored to the
          // parent's tab instead of the active one.
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
          // Focus the new agent in dispatch — the user spawned it to
          // immediately hand it a prompt (typically a review prompt).
          dispatchMode: prev.dispatchMode
            ? { ...prev.dispatchMode, focusedSessionId: sessionId }
            : prev.dispatchMode,
        }
      })
    },
    [refs.stateRef, sessionActions, setState, showToast],
  )

  const createOrchestrationAgent = useCallback(
    async (params: {
      parentId: SessionId
      kind: OrchestrationAgentKind
      cwd?: string
      title?: string
      role?: string
      runId?: string
      builtInMcpDomains?: BuiltInMcpDomain[]
      inheritParentContext?: boolean
    }): Promise<OrchestrationAgentRecord> => {
      const snapshot = refs.stateRef.current
      const parentMeta = snapshot.sessions[params.parentId]
      if (!parentMeta) {
        throw new Error('Could not create orchestration agent: parent agent is gone')
      }

      const rootParentId = parentMeta.orchestrationRootId ?? params.parentId
      const rootParentMeta = snapshot.sessions[rootParentId] ?? parentMeta
      const parentDetached = snapshot.detachedSessions[rootParentId]
      const parentTab = parentDetached
        ? snapshot.tabs.find(t => t.id === parentDetached.projectTabId)
        : snapshot.tabs.find(t => collectLeaves(t.root).includes(rootParentId))
      if (!parentTab) {
        throw new Error('Could not create orchestration agent: parent tab not found')
      }

      const cwd = params.cwd ?? rootParentMeta.cwd
      const resumeSessionId: string | undefined = undefined

      // WHY context inheritance is commented out instead of quietly deleted:
      // this is the exact behavior a follow-up issue should rebuild, but the
      // current implementation is too flawed to keep behind a tool flag. It
      // relied on duplicating or translating the parent's provider transcript,
      // then resuming the child from that file. In real orchestration runs that
      // produced unstable identity, stale parent answers being reported as
      // child output, and provider-specific race edges around cloned/resumed
      // conversations. Until there is a more stable contract, orchestration
      // children must start clean and the parent must put required context in
      // the prompt it sends.
      //
      // Disabled implementation sketch:
      //
      // if (
      //   params.inheritParentContext !== false &&
      //   (parentMeta.kind === 'claude' || parentMeta.kind === 'codex') &&
      //   parentMeta.providerSessionId
      // ) {
      //   if (parentMeta.kind === params.kind) {
      //     const duplicate = await window.api.duplicateSession({
      //       provider: parentMeta.kind,
      //       sourceProviderSessionId: parentMeta.providerSessionId,
      //       cwd,
      //       sourceCwd: parentMeta.cwd,
      //       targetCwd: cwd,
      //     })
      //     resumeSessionId = duplicate.newProviderSessionId
      //   } else {
      //     const switched = await window.api.switchProvider({
      //       sourceKind: parentMeta.kind,
      //       sourceProviderSessionId: parentMeta.providerSessionId,
      //       cwd,
      //       sourceCwd: parentMeta.cwd,
      //       targetCwd: cwd,
      //     })
      //     resumeSessionId = switched.targetProviderSessionId
      //   }
      // }

      const sessionId = await sessionActions.spawn(cwd, {
        kind: params.kind,
        resumeSessionId,
        builtInMcpDomains: params.builtInMcpDomains,
      })

      const agent: OrchestrationAgentRecord = {
        sessionId,
        kind: params.kind,
        cwd,
        ...(params.title ? { title: params.title } : {}),
        orchestrationParentId: params.parentId,
        orchestrationRootId: rootParentId,
        ...(params.runId ? { orchestrationRunId: params.runId } : {}),
        ...(params.role ? { orchestrationRole: params.role } : {}),
      }

      setState(prev => {
        const latestTab = prev.tabs.find(t => t.id === parentTab.id)
        const projectTabIndex = prev.tabs.findIndex(t => t.id === parentTab.id)
        if (!latestTab) return prev
        return {
          ...prev,
          sessions: {
            ...prev.sessions,
            [sessionId]: {
              ...(prev.sessions[sessionId] ?? { cwd, kind: params.kind }),
              cwd,
              kind: params.kind,
              ...(params.title ? { title: params.title } : {}),
              orchestrationParentId: params.parentId,
              orchestrationRootId: rootParentId,
              ...(params.runId ? { orchestrationRunId: params.runId } : {}),
              ...(params.role ? { orchestrationRole: params.role } : {}),
            },
          },
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
          // WHY orchestration agents intentionally do not steal focus:
          // the MCP caller already gets `sessionId` back as the control handle,
          // and the user may be reading or editing the parent while the new
          // worker boots. Reusing Dispatch's visual nesting is correct, but
          // reusing its manual "new agent means jump to it" focus semantics is
          // wrong for orchestration because one prompt can create many agents.
          // Keeping the active tab and focused dispatch row unchanged preserves
          // the user's review surface while still linking the child into the
          // same project tree.
        }
      })

      return agent
    },
    [refs.stateRef, sessionActions, setState],
  )

  // Close every linked child of `parentId`, recursively. Linked
  // agents are lifecycle-bound to their parent: when the parent is
  // closed, every session that named it as `linkedParentId` is
  // closed too. Recursion via closeSessionRef means a (rare) chain
  // unwinds fully even though createLinkedAgent never builds one.
  // Called from BOTH close paths — closeSession (explicit / dispatch
  // / modal closes) and closeFocused's grid path — because a parent
  // can be either a detached dispatch agent or a grid pane.
  const closeLinkedChildren = useCallback(async (parentId: SessionId) => {
    const sessions = refs.stateRef.current.sessions
    const childIds = Object.keys(sessions).filter(
      id => sessions[id]?.linkedParentId === parentId,
    )
    for (const childId of childIds) {
      await closeSessionRef.current?.(childId)
    }
  }, [refs.stateRef])

  // Promote a detached dispatch session into the grid at a chosen placement
  // target.
  //
  // WHY this wakes before the state move:
  // Detached sessions are "live" only inside a single app process. After a full
  // Agent Code restart, rehydrate intentionally keeps their SessionMeta but
  // does not respawn their provider PTY; otherwise a workspace with dozens of
  // parked agents would fork-bomb on launch. Attaching one back to the grid is
  // the explicit user action that makes it live again. We wake under the same
  // SessionId before inserting the leaf so every relationship pointer
  // (orchestrationParentId/rootId, linkedParentId, tiled lanes, pins) remains
  // intact and the pane never becomes visibly commandable while main would drop
  // writes for a missing session.
  //
  // The target tab need not equal the detached record's projectTabId.
  // projectTabId was always *affinity* (cwd defaults / dispatch
  // grouping / terminal selection), never *ownership*. Letting the
  // user pin a project-A detached agent into project-B's grid is the
  // whole point of having a placement step.
  const attachDetachedToGrid = useCallback(
    async (sessionId: SessionId, target: PlacementTarget) => {
      try {
        await sessionActions.ensureSessionLive(sessionId)
      } catch (err) {
        showToast(
          err instanceof Error && err.message.length > 0
            ? err.message
            : 'Could not wake detached session before attaching it.',
        )
        return
      }
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
    [sessionActions, setState, showToast],
  )

  const attachAllDetachedForTab = useCallback(
    async (tabId: string) => {
      let attachedCount = 0
      const snapshot = refs.stateRef.current
      const detachedIds = detachedDispatchSessionIdsForTab(snapshot, tabId)
      if (detachedIds.length === 0) return
      const liveIds: SessionId[] = []
      for (const sessionId of detachedIds) {
        try {
          await sessionActions.ensureSessionLive(sessionId)
          liveIds.push(sessionId)
        } catch (err) {
          console.warn('[workspace] failed to wake detached session before bulk attach:', err)
        }
      }
      if (liveIds.length === 0) {
        showToast('Could not wake any detached sessions for this tab')
        return
      }
      setState(prev => {
        const tab = prev.tabs.find(t => t.id === tabId)
        if (!tab) return prev
        const attachableIds = liveIds.filter(sessionId => prev.detachedSessions[sessionId])
        if (attachableIds.length === 0) return prev
        attachedCount = attachableIds.length

        const detachedSessions = { ...prev.detachedSessions }
        for (const sessionId of attachableIds) {
          delete detachedSessions[sessionId]
        }

        // Bulk attach deliberately creates one new subtree for the
        // incoming Dispatch sessions and hard-normalizes ONLY that
        // subtree. The existing tab root is preserved byte-for-byte
        // below a single wrapper split; its internal ratios and pane
        // arrangement are not flattened. This gives users a predictable
        // "pin all background work beside my current grid" action
        // without punishing the layout they already curated.
        const attachedSubtree = normalizeTree(attachableIds)
        const nextRoot = wrapRootWithNode(
          tab.root,
          'vertical',
          'b',
          attachedSubtree,
        )
        const focusedSessionId = attachableIds[0]

        return {
          ...prev,
          activeTabId: tabId,
          detachedSessions,
          tabs: prev.tabs.map(currentTab =>
            currentTab.id === tabId
              ? {
                  ...currentTab,
                  root: nextRoot,
                  focusedSessionId,
                }
              : currentTab,
          ),
          // The attached sessions stop being detached records, but the first
          // one is still the user's target for the bulk attach action. Keep
          // Dispatch focus explicit so the highlighted row and command target
          // do not depend on selectVisibleDispatchRow's grid-focus fallback.
          dispatchMode: prev.dispatchMode
            ? { ...prev.dispatchMode, focusedSessionId }
            : prev.dispatchMode,
        }
      })
      if (attachedCount > 0) {
        showToast(
          `Attached ${attachedCount} Dispatch ${attachedCount === 1 ? 'session' : 'sessions'} to grid`,
        )
      }
    },
    [refs.stateRef, sessionActions, setState, showToast],
  )

  // The reverse direction: take the focused grid pane out of the tile
  // tree without killing its session, and add it to the dispatch
  // detached bucket.
  //
  // Refuses in two cases, each surfaced as a toast so the user
  // understands why nothing happened:
  //   1. No focused session — nothing to detach.
  //   2. The focused pane is the only leaf in its tab — closeLeaf would
  //      return null and the tab.root type cannot represent an empty
  //      tree. We don't want to silently close the tab either, so we
  //      refuse and ask the user to add another pane first.
  const detachFocusedToDispatch = useCallback(() => {
    const snapshot = refs.stateRef.current
    const sessionId = commandTargetSessionIdForState(snapshot)
    if (!sessionId) {
      showToast('No focused session to detach')
      return
    }
    const meta = snapshot.sessions[sessionId]
    if (!meta) return
    const tab = snapshot.tabs.find(t => collectLeaves(t.root).includes(sessionId))
    if (!tab) {
      // WHY detached rows no-op here instead of re-detaching:
      // This action means "move the grid pane out to Dispatch." A detached
      // session is already there; treating it as success would hide a stale
      // command-target bug, while trying to mutate it would duplicate the
      // ownership record. The attach command owns the reverse direction.
      showToast('Session is already detached to Dispatch')
      return
    }
    const leaves = collectLeaves(tab.root)
    if (leaves.length <= 1) {
      showToast('Cannot detach the last pane in a tab — add another pane first')
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
        // session so the user sees the result of their action. If
        // Dispatch is not active, leave dispatchMode alone — toggling
        // into Dispatch later will pick this up via the existing
        // first-row fallback in selectActiveRow.
        dispatchMode: prev.dispatchMode
          ? { ...prev.dispatchMode, focusedSessionId: sessionId }
          : prev.dispatchMode,
      }
    })
    const cwdBase = meta.cwd.split('/').filter(Boolean).pop() ?? 'session'
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
      ? buildVisibleDispatchRows(snapshot)
      : []
    const dispatchTargetId = snapshot.dispatchMode
      ? selectVisibleDispatchRow(
          dispatchRows,
          // tiled-aware: close the FOCUSED LANE's agent, not the stale
          // dispatchMode.focusedSessionId (which would close tile 0).
          dispatchFocusedSessionId(snapshot.dispatchMode),
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

    const tab = activeTab
    if (!tab) return
    const commandTargetId = commandTargetSessionIdForState(snapshot)
    if (commandTargetId && commandTargetId !== tab.focusedSessionId) {
      // WHY related child close delegates to explicit closeSession:
      // the grid leaf is still physically owned by the parent, but the visible
      // feed/composer can be a detached linked/orchestration child. Continuing
      // through the normal grid close path would remove the parent tile and,
      // for linked children, cascade-kill the very child the user intended to
      // close. closeSession already owns detached explicit-id semantics.
      await closeSessionRef.current?.(commandTargetId)
      return
    }
    const targetId = tab.focusedSessionId
    const sessionMeta = snapshot.sessions[targetId]

    // Cascade-close any linked agents whose parent is this grid pane.
    // The dispatch close path above already routes through
    // closeSession (which cascades on its own); this covers the
    // case where the parent is an ordinary grid pane closed from the
    // normal grid layout.
    await closeLinkedChildren(targetId)

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
      showToast(`Closed ${kindLabel} pane (${cwdBase}) — ⌘⇧T Undo Close; repeat for earlier closes`)
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
      showToast(`Closed “${tab.title}” — ⌘⇧T Undo Close; repeat for earlier closes`)
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
    closeLinkedChildren,
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

      // Linked agents are lifecycle-bound to their parent — close
      // any session that named `targetId` as its linkedParentId
      // before we close the parent itself.
      await closeLinkedChildren(targetId)

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
        const cwdBase = sessionMeta?.cwd.split('/').filter(Boolean).pop() ?? sessionMeta?.cwd ?? 'session'
        showToast(`Closed detached ${kindLabel} session (${cwdBase})`)
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
        showToast(`Closed ${kindLabel} pane (${cwdBase}) — ⌘⇧T Undo Close; repeat for earlier closes`)
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
        showToast(`Closed “${owningTab.title}” — ⌘⇧T Undo Close; repeat for earlier closes`)
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
      closeLinkedChildren,
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
  //
  // WHY commandTargetSessionIdForState instead of tab.focusedSessionId:
  // tab.focusedSessionId has a "must be a leaf in tab.root" invariant —
  // it's grid-only. In Dispatch Mode the user has a row selected, not
  // a grid focus, and reading tab.focusedSessionId silently opens the
  // bury prompt on whatever grid pane is focused underneath the
  // visible dispatch row — exactly the bug class issue #94 tracks.
  // Routing through commandTargetSessionIdForState makes Bury agree
  // with every other "act on the visible thing" command (close,
  // copy-assistant, scroll-to-latest, switch-provider, reload, rewind,
  // soft-reload-view — all already use this resolver).
  const requestBuryFocused = useCallback(() => {
    const sessionId = commandTargetSessionIdForState(refs.stateRef.current)
    if (!sessionId) return
    openBuryPrompt(sessionId)
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
      // The `?? activeTab?.focusedSessionId` fallback is intentionally
      // defensive belt-and-suspenders: every current caller passes an
      // explicit `targetSessionId` (the bury-prompt modal in App.tsx
      // owns the resolved id at confirm time; requestBuryFocused
      // resolves it via commandTargetSessionIdForState before opening
      // the prompt). The fallback exists so a future caller that
      // forgets to pass an id doesn't no-op silently — but it MUST
      // NOT become the primary path, because activeTab.focusedSessionId
      // is grid-only and would re-introduce the Dispatch-misses-target
      // bug from #94.
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
            // A buried session is hidden from the dispatch rows, so a tiled
            // lane still pointing at it would dangle; clear it so the lane
            // re-homes cleanly instead of bouncing to tile 0.
            dispatchMode: clearTiledLaneSessions(prev.dispatchMode, targetId),
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
          // See above: clear any tiled lane pointing at the buried session.
          dispatchMode: clearTiledLaneSessions(prev.dispatchMode, targetId),
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
    async (buriedId: string) => {
      const current = refs.stateRef.current
      const entry = current.buried.find(item => item.id === buriedId)
      if (!entry) return
      try {
        await sessionActions.ensureSessionLive(entry.sessionId)
      } catch (err) {
        showToast(
          err instanceof Error && err.message.length > 0
            ? err.message
            : 'Could not wake buried session before reviving it.',
        )
        return
      }

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
    [refs.stateRef, sessionActions, setState, showToast],
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
    createLinkedAgent,
    createOrchestrationAgent,
    attachDetachedToGrid,
    attachAllDetachedForTab,
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
  // Always clear the removed session out of any TILED LANE first. A lane can
  // hold a session that is NOT the classic dispatch focus, so the
  // focusedSessionId short-circuit below must not skip lane cleanup — otherwise
  // the lane dangles at a dead id and the layout's auto-fill effect bounces it
  // to the first agent. clearTiledLaneSessions is a no-op (same ref) when there
  // is no tiled layout or no lane held the removed session.
  const cleared = clearTiledLaneSessions(after.dispatchMode, removedSessionId)
  if (!cleared || cleared.focusedSessionId !== removedSessionId) {
    // The user wasn't visibly commanding this row — leave Dispatch focus alone.
    //
    // This short-circuit matters because closeSession is also reached from
    // the Agent Activity modal, which kills *background* panes by id. Without
    // this branch, killing a stranger row would shuffle the user's visible
    // Dispatch selection on every removal.
    return cleared
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
  const beforeRows = buildVisibleDispatchRows(before)
  const afterRows = buildVisibleDispatchRows(after)
  const removedIndex = beforeRows.findIndex(row => row.sessionId === removedSessionId)

  // Project-first successor selection (issue #261).
  //
  // In this codebase a "project" IS a tab — every Dispatch row carries a
  // `tabId`, and that is the ONLY reliable project key (cwd is not: two tabs
  // can share a directory, and a tab's cwd can change). The old logic picked
  // the successor purely by flat-list position
  // (`afterRows[removedIndex] ?? afterRows[removedIndex - 1]`). That is fine
  // mid-project, but when the closed row was its project's LAST row,
  // `afterRows[removedIndex]` is the FIRST row of the *next* project, so focus
  // silently jumped across the project boundary and the user lost the context
  // they were working in. We never want a single close to evict you from your
  // project unless the project itself is now gone.
  //
  // So: as long as the closed row's project still has any rows, keep the
  // cursor INSIDE that project — prefer the next pane down (first surviving
  // same-project row at or after the removed index, preserving the "cursor
  // trails the deletion" feel), and only when nothing survives below do we
  // fall back to the last same-project pane above (the bottom-of-project
  // close — the actual bug being fixed here).
  //
  // Only when the project is fully emptied (e.g. closing a single-pane
  // project) do we defer to the legacy GLOBAL fallback and let focus leave the
  // project — there is no in-project row left to land on, so the flat-list
  // neighbour is the sane "same visual position" choice.
  //
  // removedIndex < 0 stays unchanged: the closed session wasn't in the visible
  // scope, so we clear focus (undefined successor) and let DispatchLayout's
  // fallback effect pick a first-row default in the new scope.
  let successor: DispatchAgentRow | undefined
  if (removedIndex >= 0) {
    const removedTabId = beforeRows[removedIndex].tabId
    const sameProjectAfter = afterRows.filter(row => row.tabId === removedTabId)
    if (sameProjectAfter.length > 0) {
      // Project survives: never cross the boundary. Next pane down in-project,
      // else nearest pane up in-project.
      successor =
        sameProjectAfter.find(row => afterRows.indexOf(row) >= removedIndex) ??
        sameProjectAfter[sameProjectAfter.length - 1]
    } else {
      // Project is now empty: only NOW may focus leave the project. Legacy
      // global "same visual position, trailing on last-row close" rule.
      successor = afterRows[removedIndex] ?? afterRows[removedIndex - 1]
    }
  }

  return {
    ...cleared,
    focusedSessionId: successor?.sessionId,
  }
}
