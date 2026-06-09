import { useCallback, useRef } from 'react'

import type { DispatchModeState, SessionId, SessionMeta, TabId } from '@renderer/workspace/types'
import { collectLeaves, wrapRootWithLeaf } from '@renderer/workspace/tile-tree/treeOps'
import { findTerminalSessionInTab } from '@renderer/workspace/dispatch/dispatchSelectors'
import {
  buildAutoLanes,
  clampTileCount,
} from '@renderer/workspace/dispatch/tiledDispatchSelectors'
import type {
  WorkspaceSetState,
  WorkspaceSetTileTabs,
} from '@renderer/workspace/hook/context'
import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'
import type { SessionActions } from '@renderer/workspace/hook/actions/session'

export function useDispatchActions(
  state: { activeTabId: TabId; dispatchMode: DispatchModeState | null; sessions: Record<SessionId, SessionMeta> },
  setState: WorkspaceSetState,
  setTileTabs: WorkspaceSetTileTabs,
  refs: WorkspaceRefs,
  showToast: (message: string, durationMs?: number) => void,
  closeNewAgentPlacement: () => void,
  sessionActions: SessionActions,
): {
  enterDispatchMode: (scope?: DispatchModeState['scope']) => Promise<void>
  exitDispatchMode: () => void
  setDispatchScope: (scope: DispatchModeState['scope']) => Promise<void>
  ensureDispatchTerminal: (tabId?: TabId) => Promise<SessionId | null>
  focusDispatchSession: (tabId: TabId, sessionId: SessionId) => void
  pinSession: (sessionId: SessionId) => void
  unpinSession: (sessionId: SessionId) => void
  setPinnedSessionIds: (ids: SessionId[]) => void
  // ---- Tiled Dispatch (issue #248) ----
  enterTiledDispatch: (count: number) => Promise<void>
  exitTiledDispatch: () => void
  setTiledLaneSession: (laneIndex: number, sessionId: SessionId) => void
  setTiledLaneCount: (count: number) => void
  setTiledFocusedLane: (laneIndex: number) => void
  setTiledRatios: (ratios: number[]) => void
} {
  const pendingTerminalByTabRef = useRef(new Map<TabId, Promise<SessionId | null>>())

  const ensureDispatchTerminal = useCallback(
    async (tabId = refs.stateRef.current.activeTabId): Promise<SessionId | null> => {
      const snapshot = refs.stateRef.current
      const tab = snapshot.tabs.find(item => item.id === tabId)
      if (!tab) return null

      const leafIds = collectLeaves(tab.root)
      const existing = findTerminalSessionInTab(tab, snapshot)
      if (existing) return existing

      const anchorId = tab.focusedSessionId
      const cwd = snapshot.sessions[anchorId]?.cwd
        ?? leafIds.map(id => snapshot.sessions[id]?.cwd).find(Boolean)
      if (!cwd) {
        showToast('Could not create dispatch terminal: no project directory found')
        return null
      }

      const pending = pendingTerminalByTabRef.current.get(tabId)
      if (pending) return pending

      const created = (async () => {
        const latest = refs.stateRef.current
        const latestTab = latest.tabs.find(item => item.id === tabId)
        const latestTerminal = findTerminalSessionInTab(latestTab ?? null, latest)
        if (latestTerminal) return latestTerminal

        let terminalId: SessionId
        try {
          terminalId = await sessionActions.spawn(cwd, { kind: 'terminal' })
        } catch (err) {
          showToast(
            err instanceof Error && err.message.length > 0
              ? err.message
              : 'Failed to create dispatch terminal',
          )
          return null
        }

        let inserted = false
        setState(prev => {
          const tabs = prev.tabs.map(currentTab => {
            if (currentTab.id !== tabId) return currentTab
            if (findTerminalSessionInTab(currentTab, prev)) {
              return currentTab
            }
            inserted = true
            // Dispatch renders the terminal outside the grid, but the
            // session still needs to be a normal leaf so existing lifetime,
            // tmux recovery, persistence, and IPC routing keep working.
            // Preserving focusedSessionId keeps terminal creation invisible
            // to the agent the user was actively commanding.
            return {
              ...currentTab,
              root: wrapRootWithLeaf(currentTab.root, 'vertical', 'b', terminalId),
              focusedSessionId: currentTab.focusedSessionId,
            }
          })
          return { ...prev, tabs }
        })
        if (!inserted) {
          // A terminal can appear after spawn but before the leaf insert
          // (for example from another caller using the normal split path).
          // `spawn()` already registered this terminal in state.sessions, so
          // leaving it unattached would leak both renderer state and a PTY.
          await sessionActions.killSession(terminalId)
          return findTerminalInLatestTab(refs, tabId)
        }
        return terminalId
      })().finally(() => {
        pendingTerminalByTabRef.current.delete(tabId)
      })
      pendingTerminalByTabRef.current.set(tabId, created)
      return created
    },
    [refs.stateRef, sessionActions, setState, showToast],
  )

  const enterDispatchMode = useCallback(
    async (scope: DispatchModeState['scope'] = state.dispatchMode?.scope ?? 'project') => {
      closeNewAgentPlacement()
      setState(prev => ({
        ...prev,
        dispatchMode: {
          scope,
          focusedSessionId: prev.dispatchMode?.focusedSessionId,
        },
      }))
      setTileTabs(null)
      // Terminal mount is now gated by `settings.dispatchProjectTerminal`,
      // which lives outside this action's reach (settings live in the
      // settings store, dispatch state lives in workspace state).
      // DispatchLayout's useEffect reads the setting and calls
      // ensureDispatchTerminal itself when appropriate — meaning we
      // deliberately do NOT unconditionally fire it here anymore. Doing so
      // would spawn a terminal even with the setting OFF, which is the
      // exact bug shape we're fixing.
    },
    [closeNewAgentPlacement, setState, setTileTabs, state.dispatchMode?.scope],
  )

  const exitDispatchMode = useCallback(() => {
    setState(prev => ({
      ...prev,
      dispatchMode: null,
    }))
  }, [setState])

  const setDispatchScope = useCallback(
    async (scope: DispatchModeState['scope']) => {
      closeNewAgentPlacement()
      setState(prev => ({
        ...prev,
        dispatchMode: {
          scope,
          focusedSessionId: prev.dispatchMode?.focusedSessionId,
        },
      }))
      // Same rationale as enterDispatchMode: terminal mount is now the
      // DispatchLayout effect's responsibility, gated by the global
      // setting. Re-entering with a different scope must NOT spawn a
      // terminal behind the setting's back.
    },
    [closeNewAgentPlacement, setState],
  )

  const focusDispatchSession = useCallback(
    (tabId: TabId, sessionId: SessionId) => {
      setState(prev => {
        if (!prev.dispatchMode) return { ...prev, activeTabId: tabId }
        // WHY not update Tab.focusedSessionId here: Dispatch rows can now be
        // detached from the grid, while Tab.focusedSessionId is a tile-tree
        // invariant used by resize, reader, spotlight, and normal pane
        // commands. Dispatch focus is a mode-local selection; activeTabId still
        // follows it so project-scoped chrome and terminal selection stay in
        // sync with the visible command-center row.
        return {
          ...prev,
          activeTabId: tabId,
          dispatchMode: {
            ...prev.dispatchMode,
            focusedSessionId: sessionId,
          },
        }
      })
    },
    [setState],
  )

  // ---- Tiled Dispatch reducers (issue #248) ----
  //
  // These all read/write `dispatchMode.tiled`. The `tiled` block being
  // present is the single render fork (DispatchLayout renders the
  // multi-lane layout iff it exists). Every reducer is a no-op when there
  // is no dispatchMode/tiled, so a stray call from a stale keybind or
  // command can never corrupt classic Dispatch. Duplicates across lanes are
  // allowed (the views mirror — see DispatchLane), so these reducers no
  // longer reject a session that's open elsewhere.

  // Enter (or freshly build) a Tiled Dispatch layout. Enters Dispatch if
  // it wasn't already on, clears tiled-tabs (mutually exclusive top-level
  // mode), and auto-fills lanes from unclaimed visible agents so the user
  // lands on a populated cockpit rather than N empty lanes.
  const enterTiledDispatch = useCallback(
    async (count: number) => {
      closeNewAgentPlacement()
      setState(prev => {
        const scope = prev.dispatchMode?.scope ?? 'project'
        const lanes = buildAutoLanes(prev, clampTileCount(count))
        return {
          ...prev,
          dispatchMode: {
            scope,
            focusedSessionId: prev.dispatchMode?.focusedSessionId,
            tiled: { lanes, focusedLane: 0 },
          },
        }
      })
      setTileTabs(null)
    },
    [closeNewAgentPlacement, setState, setTileTabs],
  )

  // Return to classic single-view Dispatch. Agents keep running — we only
  // drop the `tiled` block. (Exiting Dispatch entirely via exitDispatchMode
  // already drops it along with the rest of dispatchMode.)
  const exitTiledDispatch = useCallback(() => {
    setState(prev => {
      if (!prev.dispatchMode?.tiled) return prev
      const { tiled: _tiled, ...rest } = prev.dispatchMode
      return { ...prev, dispatchMode: { ...rest } }
    })
  }, [setState])

  // Assign a lane's agent. Duplicates ARE allowed — the same session may sit
  // in multiple lanes (the views mirror; see DispatchLane). No-op for
  // out-of-range indexes so a stale keybind targeting a since-removed lane is
  // harmless, and a no-op when the lane already shows this session.
  const setTiledLaneSession = useCallback(
    (laneIndex: number, sessionId: SessionId) => {
      setState(prev => {
        const tiled = prev.dispatchMode?.tiled
        if (!tiled) return prev
        if (laneIndex < 0 || laneIndex >= tiled.lanes.length) return prev
        if (tiled.lanes[laneIndex]?.selectedSessionId === sessionId) return prev
        const lanes = tiled.lanes.map((lane, i) =>
          i === laneIndex ? { ...lane, selectedSessionId: sessionId } : lane,
        )
        return {
          ...prev,
          dispatchMode: { ...prev.dispatchMode!, tiled: { ...tiled, lanes } },
        }
      })
    },
    [setState],
  )

  // Grow (append auto-filled lanes) or shrink (drop from the right).
  // Surviving lanes keep their selections; never reshuffle or respawn. We
  // reset ratios on a count change because a ratios array sized for the old
  // boundary count would mis-lay-out the new lane set; even distribution is
  // the safe default and the user can re-drag.
  const setTiledLaneCount = useCallback(
    (count: number) => {
      setState(prev => {
        const tiled = prev.dispatchMode?.tiled
        if (!tiled) return prev
        const next = clampTileCount(count)
        if (next === tiled.lanes.length) return prev
        const lanes =
          next < tiled.lanes.length
            ? tiled.lanes.slice(0, next)
            : buildAutoLanes(prev, next, tiled.lanes)
        const focusedLane = Math.min(tiled.focusedLane, lanes.length - 1)
        return {
          ...prev,
          dispatchMode: {
            ...prev.dispatchMode!,
            tiled: { lanes, focusedLane, ratios: undefined },
          },
        }
      })
    },
    [setState],
  )

  // Move keyboard-selection focus between lanes. Clamped. Must never touch
  // any lane's selection — that's what keeps lanes independent.
  const setTiledFocusedLane = useCallback(
    (laneIndex: number) => {
      setState(prev => {
        const tiled = prev.dispatchMode?.tiled
        if (!tiled) return prev
        const clamped = Math.max(0, Math.min(laneIndex, tiled.lanes.length - 1))
        if (clamped === tiled.focusedLane) return prev
        return {
          ...prev,
          dispatchMode: { ...prev.dispatchMode!, tiled: { ...tiled, focusedLane: clamped } },
        }
      })
    },
    [setState],
  )

  // Persist resized lane-boundary ratios.
  const setTiledRatios = useCallback(
    (ratios: number[]) => {
      setState(prev => {
        const tiled = prev.dispatchMode?.tiled
        if (!tiled) return prev
        return {
          ...prev,
          dispatchMode: { ...prev.dispatchMode!, tiled: { ...tiled, ratios } },
        }
      })
    },
    [setState],
  )

  // Pin reducers. Three callbacks share the same invariant:
  //   pinnedSessionIds[i] -> state.sessions[id] is an agent (not a terminal,
  //   not undefined). The reducer is defensive on top of the command-palette
  //   `when` guard and the modal's row filter — multiple write paths can
  //   reach these (palette command, modal commit, programmatic) and the
  //   invariant has to be local rather than relying on every call site.
  //
  // append-on-pin ordering is the user-facing spec: "order you pin in is
  // the order it displays." First pin lands at index 0; subsequent pins
  // sink to the tail. Reordering is intentionally out of scope for v1.
  const pinSession = useCallback(
    (sessionId: SessionId) => {
      setState(prev => {
        if (prev.pinnedSessionIds.includes(sessionId)) return prev
        const meta = prev.sessions[sessionId]
        if (!meta || meta.kind === 'terminal') return prev
        return {
          ...prev,
          pinnedSessionIds: [...prev.pinnedSessionIds, sessionId],
        }
      })
    },
    [setState],
  )

  const unpinSession = useCallback(
    (sessionId: SessionId) => {
      setState(prev => {
        if (!prev.pinnedSessionIds.includes(sessionId)) return prev
        return {
          ...prev,
          pinnedSessionIds: prev.pinnedSessionIds.filter(id => id !== sessionId),
        }
      })
    },
    [setState],
  )

  const setPinnedSessionIds = useCallback(
    (ids: SessionId[]) => {
      setState(prev => {
        // Filter against the live sessions snapshot at write time so a
        // stale modal selection (the user pinned X, then X was killed
        // before they hit Enter) can never reintroduce an orphan into
        // the array. Same defensive shape as buildPinnedDispatchRows
        // at render time.
        const filtered = ids.filter(id => {
          const meta = prev.sessions[id]
          return meta !== undefined && meta.kind !== 'terminal'
        })
        // Deduplicate while preserving caller order (first occurrence wins).
        // The modal already enforces this client-side, but a programmatic
        // caller could pass duplicates; keeping the dedupe here means the
        // invariant "pinnedSessionIds is unique" doesn't depend on the caller.
        const seen = new Set<SessionId>()
        const ordered: SessionId[] = []
        for (const id of filtered) {
          if (seen.has(id)) continue
          seen.add(id)
          ordered.push(id)
        }
        // No-op fast path: if the resulting list matches what's already there
        // (same ids in the same order), don't churn the reference — same
        // pattern as the rest of the reducers in this file.
        if (
          ordered.length === prev.pinnedSessionIds.length &&
          ordered.every((id, i) => id === prev.pinnedSessionIds[i])
        ) {
          return prev
        }
        return { ...prev, pinnedSessionIds: ordered }
      })
    },
    [setState],
  )

  return {
    enterDispatchMode,
    exitDispatchMode,
    setDispatchScope,
    ensureDispatchTerminal,
    focusDispatchSession,
    pinSession,
    unpinSession,
    setPinnedSessionIds,
    enterTiledDispatch,
    exitTiledDispatch,
    setTiledLaneSession,
    setTiledLaneCount,
    setTiledFocusedLane,
    setTiledRatios,
  }
}

function findTerminalInLatestTab(
  refs: WorkspaceRefs,
  tabId: TabId,
): SessionId | null {
  const latest = refs.stateRef.current
  const tab = latest.tabs.find(item => item.id === tabId)
  return findTerminalSessionInTab(tab ?? null, latest)
}
