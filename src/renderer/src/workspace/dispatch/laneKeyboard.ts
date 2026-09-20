import { buildVisibleDispatchRows } from '@renderer/workspace/dispatch/dispatchSelectors'
import { nextTiledRowIndex } from '@renderer/workspace/dispatch/tiledDispatchSelectors'
import { rowScopedRows } from '@renderer/workspace/dispatch/rowScopedRows'
import {
  normalizeGridShape,
  rowIndexForLane,
  rowStartIndex,
} from '@renderer/workspace/dispatch/gridShape'
import type { Workspace } from '@renderer/workspace/hook'

// The stage's keyboard grammar (#992 stage 5). ⌥↑/↓ walk the focused lane's
// selection through its row's index; ⌥←/→ move lane focus within the row.
// These lived as an unregistered inline branch in useKeybinds from #687 until
// the unified layout re-homed keyboard — the deferred debt #681 §7.1 filed.
// They are commands now: rebindable, visible in the shortcuts surface, and
// participating in collision checking like every other owner of a chord.
//
// The module takes `Workspace` (the hook surface) rather than bare state
// because walking selection WRITES through `selectTiledLaneSession`, never the
// raw lane writer: a hibernated agent must wake before it is placed (#690),
// and that action owns the wake. `moveLaneFocusWithinRow` only moves the
// cursor and needs no action, but it stays here so the whole grammar has one
// home.

/** The lane keyboard grammar acts on the FOCUSED lane, always. */
export function focusedLaneIndex(workspace: Workspace): number {
  return workspace.stage.focusedLane
}

/**
 * The rows the focused lane's ROW actually offers.
 *
 * Keyboard selection must see the same list the user does. The row's index
 * and strips are filtered by `rowScopedRows` (project binding + child cap),
 * so walking the unfiltered canonical set would let ⌥↓ drop a project-A
 * agent into a row bound to project B — one the row's own selector does not
 * list. Labels are NOT renumbered: these are the canonical rows, filtered. A
 * bound row shows gaps, which is what keeps ⌘N and the visible chip in
 * agreement.
 */
export function focusedLaneRowScopedRows(workspace: Workspace) {
  const all = buildVisibleDispatchRows(workspace.state)
  const grid = normalizeGridShape(workspace.stage)
  const rowIndex = rowIndexForLane(grid.rows, grid.focusedLane)
  const gridRow = rowIndex >= 0 ? grid.rows[rowIndex] : undefined
  if (!gridRow) return all
  return rowScopedRows(all, gridRow).flatMap(item => (item.kind === 'agent' ? [item.row] : []))
}

/** ⌘N addresses a LABEL, and labels are canonical (never renumbered). */
export function focusRowByLabel(workspace: Workspace, index: number) {
  const row = focusedLaneRowScopedRows(workspace).find(candidate => candidate.globalIndex === index + 1)
  if (!row) return
  // Wakes a hibernated agent before placing it (#690).
  void workspace.selectTiledLaneSession(focusedLaneIndex(workspace), row.sessionId)
}

/**
 * Walk the FOCUSED lane's selection one step through its row's index,
 * wrapping. Duplicates are allowed: we do NOT skip rows shown in other lanes —
 * landing on one just mirrors that agent into this lane too.
 */
export function moveLaneSelection(workspace: Workspace, delta: number) {
  const rows = focusedLaneRowScopedRows(workspace)
  if (rows.length === 0) return
  const laneIndex = workspace.stage.focusedLane
  const currentId = workspace.stage.lanes[laneIndex]?.selectedSessionId
  const currentIndex = currentId ? rows.findIndex(row => row.sessionId === currentId) : -1
  const probe = nextTiledRowIndex(currentIndex, delta, rows.length)
  const row = rows[probe]
  if (row) void workspace.selectTiledLaneSession(laneIndex, row.sessionId)
}

/**
 * Move lane focus one step, STOPPING at the row's edges.
 *
 * Wrapping into the neighbouring row would make one keystroke move focus a
 * single lane or jump it across the layout depending on where you started —
 * fine when you are looking, wrong when you are typing fast. Crossing rows is
 * the deliberate job of Focus Row Above/Below.
 */
export function moveLaneFocusWithinRow(workspace: Workspace, delta: number) {
  const grid = normalizeGridShape(workspace.stage)
  const rowIndex = rowIndexForLane(grid.rows, grid.focusedLane)
  if (rowIndex < 0) return
  const start = rowStartIndex(grid.rows, rowIndex)
  const end = start + (grid.rows[rowIndex]?.length ?? 0) - 1
  const next = grid.focusedLane + delta
  if (next < start || next > end) return
  workspace.setTiledFocusedLane(next)
}
