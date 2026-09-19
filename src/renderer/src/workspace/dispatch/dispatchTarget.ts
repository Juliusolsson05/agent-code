import {
  buildVisibleDispatchRows,
  selectVisibleDispatchRow,
} from '@renderer/workspace/dispatch/dispatchSelectors'
import type { DispatchAgentRow } from '@renderer/workspace/dispatch/dispatchSelectors'
import type { WorkspaceState } from '@renderer/workspace/types'

export type DispatchVisualTarget = {
  row: DispatchAgentRow
  laneIndex: number | null
  // 'classic-focus' and 'grid-fallback' were members until #992: the classic
  // single-selection focus and the tile tree's focused pane. Neither exists,
  // so neither can be the source of a target.
  source: 'tiled-lane' | 'first-row'
}

/**
 * Resolve the visible Dispatch row a command should act on.
 *
 * WHY this is separate from `dispatchFocusedSessionId` and
 * `resolveDispatchSpawnTarget`:
 * The stage has two legitimate target semantics that used to be collapsed
 * into one fallback chain. Lifecycle/destructive commands need STRICT visual
 * intent: if the focused lane is empty or stale, there is no session selected
 * and the command must not silently fall through to row 1. Spawn/defaulting
 * flows are different: an empty lane can still inherit a useful project from
 * the first visible row or the active project. Keeping this helper command-shaped makes call sites choose their policy
 * instead of inheriting a convenient fallback by accident.
 */
export function resolveDispatchVisualTarget(
  state: WorkspaceState,
  options: { strictTiledLane: boolean },
): DispatchVisualTarget | null {
  const rows = buildVisibleDispatchRows(state)
  if (rows.length === 0) return null

  const laneIndex = state.stage.focusedLane
  const laneSessionId = state.stage.lanes[laneIndex]?.selectedSessionId ?? null
  const laneRow = laneSessionId
    ? rows.find(row => row.sessionId === laneSessionId) ?? null
    : null
  if (laneRow) return { row: laneRow, laneIndex, source: 'tiled-lane' }
  if (options.strictTiledLane) return null

  // Non-strict (spawn/defaulting) callers may still want SOME project when
  // the focused lane is empty. The classic single-selection focus that used
  // to answer first is gone (#992); the first visible row is the fallback.
  const row = selectVisibleDispatchRow(rows, null, null)
  if (!row) return null
  return { row, laneIndex: null, source: 'first-row' }
}

export function resolveStrictDispatchCommandTarget(
  state: WorkspaceState,
): DispatchVisualTarget | null {
  return resolveDispatchVisualTarget(state, { strictTiledLane: true })
}
