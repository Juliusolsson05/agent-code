import { useCallback } from 'react'

import type {
  DispatchGridRow,
  SessionId,
  SessionMeta,
  TabId,
  WorkspaceState,
} from '@renderer/workspace/types'
import { withLaneSession } from '@renderer/workspace/dispatch/tiledDispatchSelectors'
import type { GridShapeRow } from '@renderer/workspace/dispatch/gridShape'
import {
  clampIndexFraction,
  insertLaneRightIntoGrid,
  insertRowBelowInGrid,
  normalizeGridShape,
  removeLaneFromGrid,
  removeRowFromGrid,
  rowIndexForLane,
  rowStartIndex,
  setGridShape,
} from '@renderer/workspace/dispatch/gridShape'
import type {
  WorkspaceSetRuntimes,
  WorkspaceSetState,
} from '@renderer/workspace/hook/context'
import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'
import type { SessionActions } from '@renderer/workspace/hook/actions/session'
import { isProcessSessionKind } from '@shared/types/providerKind'
import { clearPooledSpawnBadge } from '@renderer/workspace/hook/actions/pooledSpawnBadge'

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
  const tiled = prev.stage
  const grid = normalizeGridShape(tiled)
  if (!Number.isInteger(rowIndex) || rowIndex < 0 || rowIndex >= grid.rows.length) {
    return prev
  }
  return {
    ...prev,
    stage: {
      ...tiled,
      rows: grid.rows.map((row, i) => (i === rowIndex ? { ...row, ...patch } : row)),
      // Carried explicitly: normalizeGridShape may have just split a legacy
      // `ratios` array, and spreading `tiled` alone would put the stale one
      // back beside the fields it was split into.
      laneWeights: grid.laneWeights,
      ratios: undefined,
    },
  }
}

export function useDispatchActions(
  setState: WorkspaceSetState,
  setRuntimes: WorkspaceSetRuntimes,
  refs: WorkspaceRefs,
  ensureSessionLive: SessionActions['ensureSessionLive'],
  showToast: (message: string, durationMs?: number) => void,
): {
  pinSession: (sessionId: SessionId) => void
  unpinSession: (sessionId: SessionId) => void
  setPinnedSessionIds: (ids: SessionId[]) => void
  // ---- Lanes (issue #248) ----
  selectTiledLaneSession: (laneIndex: number, sessionId: SessionId) => Promise<void>
  clearTiledLane: (laneIndex: number) => void
  insertTiledLaneRight: (laneIndex: number) => boolean
  removeTiledLane: (laneIndex: number) => void
  setTiledFocusedLane: (laneIndex: number) => void
  // ---- Grid Dispatch rows (issue #681) ----
  insertDispatchRowBelow: (rowIndex: number) => boolean
  removeDispatchRow: (rowIndex: number) => void
  setDispatchGridShape: (rows: GridShapeRow[]) => boolean
  setDispatchLaneWeights: (weights: number[]) => void
  setDispatchRowIndexFraction: (rowIndex: number, fraction: number) => void
  setDispatchRowHeights: (heights: number[]) => void
  setDispatchRowProjects: (rowIndex: number, tabIds: TabId[]) => void
  setDispatchRowCapChildren: (rowIndex: number, cap: boolean) => void
  toggleDispatchRowExpandedParent: (rowIndex: number, sessionId: SessionId) => void
} {
  // enterDispatchMode, exitDispatchMode, setDispatchScope, focusDispatchSession,
  // enterTiledDispatch and exitTiledDispatch lived here until #992. They
  // turned the lane grid ON and OFF, switched a layout-wide project/global
  // scope, and tracked a classic single-selection focus. The stage is a
  // required field now: nothing is entered or exited, every index lists every
  // project (a row's projectTabIds is the only filter), and the focused lane
  // is the one focus. The entry seed (#977) survives only in the v2 migration.
  //
  // Every reducer below reads and writes `stage` directly. They used to guard
  // on `dispatchMode?.tiled` being present; that guard is gone because the
  // state it protected against can no longer be represented.

  // Assign a lane's agent. NOT exposed on the workspace: every caller must go
  // through `selectTiledLaneSession` below, which wakes a hibernated agent
  // first. Handing out the raw writer is what let four separate call sites
  // place a dead backend in a lane (#690), and a wrapper that can be bypassed
  // only fixes the callers that exist today.
  //
  // Duplicates ARE allowed — the same session may sit
  // in multiple lanes (the views mirror; see DispatchLane). No-op for
  // out-of-range indexes so a stale keybind targeting a since-removed lane is
  // harmless, and a no-op when the lane already shows this session.
  const setTiledLaneSession = useCallback(
    (laneIndex: number, sessionId: SessionId) => {
      let wrote = false
      setState(prev => {
        const tiled = prev.stage
        if (laneIndex < 0 || laneIndex >= tiled.lanes.length) return prev
        if (tiled.lanes[laneIndex]?.selectedSessionId === sessionId) return prev
        wrote = true
        const lanes = tiled.lanes.map((lane, i) =>
          i === laneIndex ? withLaneSession(lane, sessionId) : lane,
        )
        return { ...prev, stage: { ...tiled, lanes } }
      })
      // Placing a session is the user ANSWERING the "new in the pool" badge
      // (#992 §4.3). The index click, lane strip, ⌘N and the ⌥↑/↓ walk place
      // through here; label navigation and every control-plane "show" place
      // through agentIndexNavigation, which clears it the same way. Without
      // that, the chip outlives its question and trains the user to ignore it.
      if (wrote) clearPooledSpawnBadge(setRuntimes, sessionId)
    },
    [setRuntimes, setState],
  )

  /**
   * Put a session into a lane, WAKING it first when it has no backend.
   *
   * Rehydrate deliberately does not respawn parked sessions — they survive a
   * restart as metadata with no provider process (see rehydrate.ts). Something
   * has to wake them before they are used, and agent-index navigation already
   * says exactly why:
   *
   *   "Wake under the SAME SessionId before exposing one in a lane/grid slot;
   *    otherwise the navigation appears to work but the first keystroke lands
   *    on a dead backend."
   *
   * That was true of every OTHER way a session reaches a lane. The index click,
   * the strip click, ⌥↑/↓ and ⌘N all wrote straight through
   * `setTiledLaneSession`, so a hibernated agent could be selected, rendered,
   * and typed into — and main rejected the prompt as "not a live agent session"
   * with `reason: never-owned` (#690). The composer's own retry papers over it
   * inconsistently, which made the failure look intermittent.
   *
   * WHY the wake completes BEFORE the lane is written: writing first exposes a
   * dead pane the user can type into during the gap, which is the very state
   * this is fixing.
   *
   * The cost is paid once per session per app run: after the first wake its
   * runtime reads 'started' and every later selection is the synchronous path.
   * (Until #992 the fork was "is it a detached record", which EVERY lane agent
   * was, so every gesture paid a `session:recover` round-trip and a transient
   * `spawning` flip even for an agent that was already running.)
   */
  const selectTiledLaneSession = useCallback(
    async (laneIndex: number, sessionId: SessionId) => {
      // Already has a backend: stays synchronous, so no coordinate can shift
      // underneath it.
      //
      // The test is the RUNTIME. Until #992 it was "has no detachedSessions
      // record" (i.e. is a tile leaf), which was a structural guess with a
      // documented gap: a leaf whose respawn failed at rehydrate, or whose
      // process died since, was written into the lane un-woken and needed the
      // pane's own Retry. `processStatus` closes that gap — 'failed' and
      // 'exited' now take the wake path below, which is also the retry path —
      // and removes its mirror image, re-waking an agent that was already up.
      // Agent-index navigation uses the identical predicate.
      if (refs.latestRuntimesRef.current[sessionId]?.processStatus === 'started') {
        setTiledLaneSession(laneIndex, sessionId)
        return
      }

      // The gesture targets a (row, column), not a flat index.
      //
      // WHY that distinction matters once the write is async: `lanes` is flat
      // and row-major, so a lane added or removed in an EARLIER row shifts
      // every later index. `setTiledLaneSession`'s bounds check catches an
      // index that fell off the end, but an index that is merely now a
      // DIFFERENT row's lane is still in range — the write would land in the
      // wrong row. Re-deriving from the coordinate after the wake fixes that.
      //
      // The follow is gated on the ROW DESCRIPTOR surviving by reference, not
      // on its index still being in range.
      //
      // WHY reference identity is the right test: a row index is positional and
      // is only stable against changes to row LENGTHS, never to row MEMBERSHIP.
      // Checking range alone drops correctly in a 2-row grid (the stale index
      // falls off the end) and silently writes into the WRONG row from three
      // rows up — removing row 0 of [1,2,2] would have written the agent into
      // what used to be row 2. Every grid mutation preserves untouched row
      // objects (`insertLaneRightIntoGrid`/`removeLaneFromGrid` map, the row ops
      // slice/filter), so identity follows exactly the grow/shrink cases and
      // drops every membership change.
      //
      // Dropping is the honest outcome for a membership change — silently
      // retargeting a slot the user did not choose is the surprise this whole
      // change removes. If rows ever gain durable ids this becomes a real
      // follow instead.
      //
      // The window is NOT narrow, which is why this matters: a cold wake allows
      // up to 30s, and Remove Row / Close Agent sit on a confirmation dialog
      // inside it.
      const before = normalizeGridShape(refs.stateRef.current.stage)
      const rowIndex = rowIndexForLane(before.rows, laneIndex)
      const column = rowIndex >= 0 ? laneIndex - rowStartIndex(before.rows, rowIndex) : -1
      // Checked BEFORE the wake: an unresolvable coordinate can never produce a
      // write, and spawning a provider process only to discard it is waste.
      if (rowIndex < 0 || column < 0) return

      try {
        await ensureSessionLive(sessionId, 'dispatch-lane.select')
      } catch (error) {
        // Do NOT place a session we could not wake: leaving the lane on its
        // previous occupant is honest, where showing a dead pane is not.
        showToast(
          error instanceof Error && error.message.length > 0
            ? error.message
            : 'Could not wake agent.',
        )
        return
      }

      const after = normalizeGridShape(refs.stateRef.current.stage)
      const row = after.rows[rowIndex]
      // Not the same row any more (removed, or displaced by an insert above),
      // or it shrank past the column the user aimed at.
      if (!row || row !== before.rows[rowIndex] || column >= row.length) return
      setTiledLaneSession(rowStartIndex(after.rows, rowIndex) + column, sessionId)
    },
    [refs, ensureSessionLive, showToast, setTiledLaneSession],
  )

  /**
   * Empty ONE lane without ending anything: the occupant returns to the pool
   * alive (#992 §4.4, "Clear Lane"). The lane is NOT removed — Remove Lane
   * owns that — and nothing refills it (#681): the user asked for the space
   * back, not for a different agent in it.
   *
   * WHY this is an action and not just a command-local state write: it is the
   * non-destructive half of a pair whose destructive half (Close Agent and
   * Remove Lane) is an action, and closeAgentRemoveLane's suite pins their
   * shared lane-index semantics. A command-local write would drift from
   * whatever lane validation the close path settles on.
   *
   * No undo entry, deliberately: the undo stack is for CLOSES (things whose
   * sessions are gone). Undoing a lane clear is just selecting the session
   * back into the lane — one click in the index it never left.
   */
  const clearTiledLane = useCallback(
    (laneIndex: number) => {
      setState(prev => {
        const tiled = prev.stage
        if (laneIndex < 0 || laneIndex >= tiled.lanes.length) return prev
        if (tiled.lanes[laneIndex]?.selectedSessionId === undefined) return prev
        const lanes = tiled.lanes.map((lane, i) =>
          i === laneIndex ? { ...lane, selectedSessionId: undefined } : lane,
        )
        return { ...prev, stage: { ...tiled, lanes } }
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
        const tiled = prev.stage
        const next = insertLaneRightIntoGrid(tiled, laneIndex)
        if (!next) return prev
        inserted = true
        return { ...prev, stage: next }
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
   * The splice/clamp/weight rules live in `removeLaneFromGrid` so they can be
   * tested as a pure function; this is only the state wiring. A null return
   * means the removal was refused (at the lane floor, or a bad index), in
   * which case we hand back `prev` untouched rather than writing an identical
   * object and forcing a re-render.
   */
  const removeTiledLane = useCallback(
    (laneIndex: number) => {
      setState(prev => {
        const tiled = prev.stage
        const next = removeLaneFromGrid(tiled, laneIndex)
        if (!next) return prev
        return { ...prev, stage: next }
      })
    },
    [setState],
  )

  // Move keyboard-selection focus between lanes. Clamped. Must never touch
  // any lane's selection — that's what keeps lanes independent.
  const setTiledFocusedLane = useCallback(
    (laneIndex: number) => {
      setState(prev => {
        const tiled = prev.stage
        const clamped = Math.max(0, Math.min(laneIndex, tiled.lanes.length - 1))
        if (clamped === tiled.focusedLane) return prev
        return { ...prev, stage: { ...tiled, focusedLane: clamped } }
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
        const tiled = prev.stage
        const next = insertRowBelowInGrid(tiled, rowIndex)
        if (!next) return prev
        inserted = true
        return { ...prev, stage: next }
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
        const tiled = prev.stage
        const next = removeRowFromGrid(tiled, rowIndex)
        if (!next) return prev
        return { ...prev, stage: next }
      })
    },
    [setState],
  )

  const setDispatchGridShape = useCallback(
    (rows: GridShapeRow[]) => {
      let applied = false
      setState(prev => {
        const tiled = prev.stage
        const next = setGridShape(tiled, rows)
        if (!next) return prev
        applied = true
        return { ...prev, stage: next }
      })
      return applied
    },
    [setState],
  )

  const setDispatchLaneWeights = useCallback(
    (weights: number[]) => {
      setState(prev => {
        const tiled = prev.stage
        // Length-checked here as well as on read: a weights array that does not
        // describe every lane is dropped by normalizeGridShape anyway, and
        // storing one would make the next drag start from a silently discarded
        // value.
        if (weights.length !== tiled.lanes.length) return prev
        return { ...prev, stage: { ...tiled, laneWeights: weights } }
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
        const tiled = prev.stage
        const grid = normalizeGridShape(tiled)
        if (heights.length !== grid.rows.length) return prev
        return {
          ...prev,
          stage: {
            ...tiled,
            rows: grid.rows.map((row, i) => ({ ...row, height: heights[i] })),
          },
        }
      })
    },
    [setState],
  )

  const setDispatchRowProjects = useCallback(
    (rowIndex: number, tabIds: TabId[]) => {
      setState(prev => {
        // Empty normalizes to ABSENT here, not to an empty array: "any project"
        // must have exactly one representation or every reader needs to test
        // for both.
        // (Binding used to PROMOTE a layout-wide scope to 'global' so a row
        // bound to another project did not list nothing. The scope is gone —
        // every index already lists every project — so this is the whole write.)
        return patchRow(prev, rowIndex, {
          projectTabIds: tabIds.length > 0 ? tabIds : undefined,
        })
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
        const tiled = prev.stage
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
  //   pinnedSessionIds[i] -> state.sessions[id] exists. Any session kind can be
  //   pinned (#865); terminals were excluded until shells became full Dispatch
  //   rows (#671) made that exclusion a leftover of the #152 v1 scope.
  //
  // append-on-pin ordering is the user-facing spec: "order you pin in is
  // the order it displays." First pin lands at index 0; subsequent pins
  // sink to the tail. Reordering is intentionally out of scope for v1.
  const pinSession = useCallback(
    (sessionId: SessionId) => {
      setState(prev => {
        if (prev.pinnedSessionIds.includes(sessionId)) return prev
        const meta = prev.sessions[sessionId]
        if (!meta || !isProcessSessionKind(meta.kind)) return prev
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
          return meta !== undefined && isProcessSessionKind(meta.kind)
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
    pinSession,
    unpinSession,
    setPinnedSessionIds,
    selectTiledLaneSession,
    clearTiledLane,
    insertTiledLaneRight,
    removeTiledLane,
    setTiledFocusedLane,
    insertDispatchRowBelow,
    removeDispatchRow,
    setDispatchGridShape,
    setDispatchLaneWeights,
    setDispatchRowIndexFraction,
    setDispatchRowHeights,
    setDispatchRowProjects,
    setDispatchRowCapChildren,
    toggleDispatchRowExpandedParent,
  }
}
