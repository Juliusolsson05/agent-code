import { useCallback } from 'react'

import type {
  DispatchGridRow,
  DispatchLane,
  DispatchModeState,
  SessionId,
  SessionMeta,
  TabId,
  WorkspaceState,
} from '@renderer/workspace/types'
import {
  clampTileCount,
  dispatchFocusedSessionId,
  withLaneSession,
} from '@renderer/workspace/dispatch/tiledDispatchSelectors'
import {
  clampIndexFraction,
  insertLaneRightIntoGrid,
  insertRowBelowInGrid,
  normalizeGridShape,
  removeLaneFromGrid,
  removeRowFromGrid,
  rowIndexForLane,
  setGridShape,
} from '@renderer/workspace/dispatch/gridShape'
import type {
  WorkspaceSetState,
  WorkspaceSetTileTabs,
} from '@renderer/workspace/hook/context'

/**
 * Write row METADATA without touching any row length.
 *
 * WHY metadata gets its own writer instead of each reducer spreading `rows`
 * itself: a hand-rolled spread is one keystroke away from also writing a
 * `length`, which silently breaks sum(rows[].length) === lanes.length — the one
 * invariant nothing downstream re-derives. Routing every metadata write through
 * a helper that CANNOT change lengths makes that class of bug unreachable
 * rather than merely unlikely.
 *
 * Normalizes first so a row index is meaningful even against state persisted
 * before the grid existed.
 */
function patchRow(
  prev: WorkspaceState,
  rowIndex: number,
  patch: Partial<Omit<DispatchGridRow, 'length'>>,
): WorkspaceState {
  const tiled = prev.dispatchMode?.tiled
  if (!tiled) return prev
  const grid = normalizeGridShape(tiled)
  if (!Number.isInteger(rowIndex) || rowIndex < 0 || rowIndex >= grid.rows.length) {
    return prev
  }
  return {
    ...prev,
    dispatchMode: {
      ...prev.dispatchMode!,
      tiled: {
        ...tiled,
        rows: grid.rows.map((row, i) => (i === rowIndex ? { ...row, ...patch } : row)),
        // Carried explicitly: normalizeGridShape may have just split a legacy
        // `ratios` array, and spreading `tiled` alone would put the stale one
        // back beside the fields it was split into.
        laneWeights: grid.laneWeights,
        ratios: undefined,
      },
    },
  }
}

/**
 * N blank lanes.
 *
 * Each lane is a fresh object rather than a shared literal: lanes are spread
 * and replaced individually by every writer, and a shared reference would make
 * two lanes alias one another the first time someone mutated instead of spread.
 */
function emptyLanes(count: number): DispatchLane[] {
  return Array.from({ length: Math.max(0, count) }, () => ({}))
}

export function useDispatchActions(
  state: { activeTabId: TabId; dispatchMode: DispatchModeState | null; sessions: Record<SessionId, SessionMeta> },
  setState: WorkspaceSetState,
  setTileTabs: WorkspaceSetTileTabs,
  closeNewAgentPlacement: () => void,
): {
  enterDispatchMode: (scope?: DispatchModeState['scope']) => Promise<void>
  exitDispatchMode: () => void
  setDispatchScope: (scope: DispatchModeState['scope']) => Promise<void>
  focusDispatchSession: (tabId: TabId, sessionId: SessionId) => void
  pinSession: (sessionId: SessionId) => void
  unpinSession: (sessionId: SessionId) => void
  setPinnedSessionIds: (ids: SessionId[]) => void
  // ---- Tiled Dispatch (issue #248) ----
  enterTiledDispatch: (count: number) => Promise<void>
  exitTiledDispatch: () => void
  setTiledLaneSession: (laneIndex: number, sessionId: SessionId) => void
  setTiledLaneCount: (count: number) => void
  insertTiledLaneRight: (laneIndex: number) => boolean
  removeTiledLane: (laneIndex: number) => void
  setTiledFocusedLane: (laneIndex: number) => void
  setTiledRatios: (ratios: number[]) => void
  // ---- Grid Dispatch rows (issue #681) ----
  insertDispatchRowBelow: (rowIndex: number) => boolean
  removeDispatchRow: (rowIndex: number) => void
  setDispatchGridShape: (rowLengths: number[]) => boolean
  setDispatchLaneWeights: (weights: number[]) => void
  setDispatchRowIndexFraction: (rowIndex: number, fraction: number) => void
  setDispatchRowHeights: (heights: number[]) => void
  setDispatchRowProject: (rowIndex: number, tabId: TabId | undefined) => void
  setDispatchRowCapChildren: (rowIndex: number, cap: boolean) => void
  toggleDispatchRowExpandedParent: (rowIndex: number, sessionId: SessionId) => void
} {
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

  // Enter (or freshly build) a Tiled Dispatch layout. Enters Dispatch if it
  // wasn't already on and clears tiled-tabs (mutually exclusive top-level mode).
  //
  // The lanes arrive EMPTY (#681). This used to auto-fill from unclaimed visible
  // agents on the theory that asking for N tiles means wanting to see N agents.
  // The cost of that convenience was a layout that rearranges itself: the same
  // helper ran on growth, and the render-time healer ran on every unresolved
  // lane, so killing an agent replaced it with an unrelated one. Making entry
  // the single exception would have left the user unable to predict which of
  // their slots the app feels entitled to fill.
  const enterTiledDispatch = useCallback(
    async (count: number) => {
      closeNewAgentPlacement()
      setState(prev => {
        const scope = prev.dispatchMode?.scope ?? 'project'
        const lanes = emptyLanes(clampTileCount(count))
        return {
          ...prev,
          dispatchMode: {
            scope,
            focusedSessionId: prev.dispatchMode?.focusedSessionId,
            tiled: { lanes, rows: [{ length: lanes.length }], focusedLane: 0 },
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
          i === laneIndex ? withLaneSession(lane, sessionId) : lane,
        )
        return {
          ...prev,
          dispatchMode: { ...prev.dispatchMode!, tiled: { ...tiled, lanes } },
        }
      })
    },
    [setState],
  )

  // Grow (append EMPTY lanes) or shrink (drop from the right). Surviving lanes
  // keep their selections; never reshuffle or respawn. We reset ratios on a
  // count change because a ratios array sized for the old boundary count would
  // mis-lay-out the new lane set; even distribution is the safe default and the
  // user can re-drag.
  //
  // Appended lanes are empty for the same reason New Lane's are (#673/#681):
  // more room is a request for space, not for particular agents.
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
            : [...tiled.lanes, ...emptyLanes(next - tiled.lanes.length)]
        const focusedLane = Math.min(tiled.focusedLane, lanes.length - 1)
        // The legacy count path only ever addressed a single row, and it stays
        // that way: it has no positional intent to spread across rows, so it
        // collapses whatever shape exists into one row of `next` lanes. The
        // grid-aware way to resize is setDispatchGridShape, which takes a
        // length per row. Leaving the old rows here would break
        // sum(rows[].length) === lanes.length on the very next read.
        return {
          ...prev,
          dispatchMode: {
            ...prev.dispatchMode!,
            tiled: {
              lanes,
              rows: [{ ...(tiled.rows?.[0] ?? {}), length: lanes.length }],
              focusedLane,
              laneWeights: undefined,
              ratios: undefined,
            },
          },
        }
      })
    },
    [setState],
  )

  /**
   * Insert ONE lane beside an existing lane without changing command focus.
   *
   * WHY this has an explicit lane index rather than reading focusedLane inside
   * the helper: command invocation captures one coherent UI snapshot. Passing
   * that coordinate makes a stale invocation harmless instead of letting a
   * later focus movement insert beside a different agent than the user saw.
   */
  const insertTiledLaneRight = useCallback(
    (laneIndex: number) => {
      let inserted = false
      setState(prev => {
        const tiled = prev.dispatchMode?.tiled
        if (!tiled) return prev
        const next = insertLaneRightIntoGrid(tiled, laneIndex)
        if (!next) return prev
        inserted = true
        return { ...prev, dispatchMode: { ...prev.dispatchMode!, tiled: next } }
      })
      // Zustand's workspace setter applies functional updaters synchronously,
      // so this reports the reducer's ACTUAL admission rather than the command
      // palette's earlier render snapshot. That distinction is what prevents a
      // stale programmatic invocation from announcing a lane that was refused
      // at the ceiling or after its coordinate disappeared.
      return inserted
    },
    [setState],
  )

  /**
   * Remove ONE lane, shrinking the grid by one.
   *
   * The splice/clamp/ratio rules live in `removeLaneFromTiled` so they can be
   * tested as a pure function; this is only the state wiring. A null return
   * means the removal was refused (at the lane floor, or a bad index), in
   * which case we hand back `prev` untouched rather than writing an identical
   * object and forcing a re-render.
   */
  const removeTiledLane = useCallback(
    (laneIndex: number) => {
      setState(prev => {
        const tiled = prev.dispatchMode?.tiled
        if (!tiled) return prev
        const next = removeLaneFromGrid(tiled, laneIndex)
        if (!next) return prev
        return { ...prev, dispatchMode: { ...prev.dispatchMode!, tiled: next } }
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

  // ---- Grid Dispatch row reducers (issue #681) ----
  //
  // Structural changes (insert/remove row, reshape) delegate to gridShape, which
  // returns a COMPLETE coherent shape or null. Row METADATA changes (project,
  // density, sizing) never touch lengths, so they go through patchRow below.
  // Keeping those two categories apart is what stops a metadata write from
  // silently breaking sum(rows[].length) === lanes.length.

  const insertDispatchRowBelow = useCallback(
    (rowIndex: number) => {
      let inserted = false
      setState(prev => {
        const tiled = prev.dispatchMode?.tiled
        if (!tiled) return prev
        const next = insertRowBelowInGrid(tiled, rowIndex)
        if (!next) return prev
        inserted = true
        return { ...prev, dispatchMode: { ...prev.dispatchMode!, tiled: next } }
      })
      // Reports the reducer's ACTUAL admission rather than the palette's earlier
      // render snapshot, so a stale invocation cannot announce a row that was
      // refused at the row or lane ceiling. Same contract as
      // insertTiledLaneRight.
      return inserted
    },
    [setState],
  )

  const removeDispatchRow = useCallback(
    (rowIndex: number) => {
      setState(prev => {
        const tiled = prev.dispatchMode?.tiled
        if (!tiled) return prev
        const next = removeRowFromGrid(tiled, rowIndex)
        if (!next) return prev
        return { ...prev, dispatchMode: { ...prev.dispatchMode!, tiled: next } }
      })
    },
    [setState],
  )

  const setDispatchGridShape = useCallback(
    (rowLengths: number[]) => {
      let applied = false
      setState(prev => {
        const tiled = prev.dispatchMode?.tiled
        if (!tiled) return prev
        const next = setGridShape(tiled, rowLengths)
        if (!next) return prev
        applied = true
        return { ...prev, dispatchMode: { ...prev.dispatchMode!, tiled: next } }
      })
      return applied
    },
    [setState],
  )

  const setDispatchLaneWeights = useCallback(
    (weights: number[]) => {
      setState(prev => {
        const tiled = prev.dispatchMode?.tiled
        if (!tiled) return prev
        // Length-checked here as well as on read: a weights array that does not
        // describe every lane is dropped by normalizeGridShape anyway, and
        // storing one would make the next drag start from a silently discarded
        // value.
        if (weights.length !== tiled.lanes.length) return prev
        return {
          ...prev,
          dispatchMode: { ...prev.dispatchMode!, tiled: { ...tiled, laneWeights: weights } },
        }
      })
    },
    [setState],
  )

  const setDispatchRowIndexFraction = useCallback(
    (rowIndex: number, fraction: number) => {
      setState(prev => patchRow(prev, rowIndex, { indexFraction: clampIndexFraction(fraction) }))
    },
    [setState],
  )

  const setDispatchRowHeights = useCallback(
    (heights: number[]) => {
      setState(prev => {
        const tiled = prev.dispatchMode?.tiled
        if (!tiled) return prev
        const grid = normalizeGridShape(tiled)
        if (heights.length !== grid.rows.length) return prev
        return {
          ...prev,
          dispatchMode: {
            ...prev.dispatchMode!,
            tiled: {
              ...tiled,
              rows: grid.rows.map((row, i) => ({ ...row, height: heights[i] })),
            },
          },
        }
      })
    },
    [setState],
  )

  const setDispatchRowProject = useCallback(
    (rowIndex: number, tabId: TabId | undefined) => {
      setState(prev => {
        const patched = patchRow(prev, rowIndex, { projectTabId: tabId })
        if (patched === prev || !patched.dispatchMode) return patched
        // Binding PROMOTES scope to global. Project scope builds its row set
        // from activeTabId alone, so a row bound to any other project would show
        // an empty index and every lane in it would fail to resolve. The same
        // promotion, for the same reason, already happens in
        // agentIndexNavigation when a cross-project label is used.
        //
        // Unbinding deliberately does NOT demote: the user may have several
        // rows still bound, and silently narrowing the scope out from under them
        // would empty those rows.
        if (tabId === undefined || patched.dispatchMode.scope === 'global') return patched
        return {
          ...patched,
          dispatchMode: { ...patched.dispatchMode, scope: 'global' },
        }
      })
    },
    [setState],
  )

  const setDispatchRowCapChildren = useCallback(
    (rowIndex: number, cap: boolean) => {
      // Flipping the row default also clears its per-parent overrides: those
      // are exceptions TO the default, so carrying them across a change of the
      // default would leave the row in a state the toggle cannot describe.
      setState(prev => patchRow(prev, rowIndex, { capChildren: cap, expandedParents: undefined }))
    },
    [setState],
  )

  const toggleDispatchRowExpandedParent = useCallback(
    (rowIndex: number, sessionId: SessionId) => {
      setState(prev => {
        const tiled = prev.dispatchMode?.tiled
        if (!tiled) return prev
        const current = normalizeGridShape(tiled).rows[rowIndex]?.expandedParents ?? []
        const next = current.includes(sessionId)
          ? current.filter(id => id !== sessionId)
          : [...current, sessionId]
        return patchRow(prev, rowIndex, {
          expandedParents: next.length > 0 ? next : undefined,
        })
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
    focusDispatchSession,
    pinSession,
    unpinSession,
    setPinnedSessionIds,
    enterTiledDispatch,
    exitTiledDispatch,
    setTiledLaneSession,
    setTiledLaneCount,
    insertTiledLaneRight,
    removeTiledLane,
    setTiledFocusedLane,
    setTiledRatios,
    insertDispatchRowBelow,
    removeDispatchRow,
    setDispatchGridShape,
    setDispatchLaneWeights,
    setDispatchRowIndexFraction,
    setDispatchRowHeights,
    setDispatchRowProject,
    setDispatchRowCapChildren,
    toggleDispatchRowExpandedParent,
  }
}
