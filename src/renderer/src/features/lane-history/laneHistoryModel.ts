import { useAppStore } from '@renderer/app-state/hooks'
import { buildVisibleDispatchRows } from '@renderer/workspace/dispatch/dispatchSelectors'
import { normalizeGridShape, rowIndexForLane, rowStartIndex } from '@renderer/workspace/dispatch/gridShape'
import { sessionDisplayLabel } from '@renderer/workspace/tile-tree/paneLabels'
import type { SessionId, WorkspaceState } from '@renderer/workspace/types'
import type { Workspace } from '@renderer/workspace/workspaceStore'

// The ONE reading of a lane's history, shared by every Lane History surface:
// ⌥B (Lane Back), the "↶ A2" chip in the pane header, its right-click menu,
// the "Recently here" list in an empty lane, and the Lane History dialog.
//
// WHY one module and not a helper per surface: the four surfaces must agree on
// what "the previous agent" is. If the chip said A2 while ⌥B went to A5 (one
// filtering dead agents, the other not), the chip would be advertising a key
// that does something else. Everything below is pure over WorkspaceState
// except `goBackInLane`, which is the single place a pick is APPLIED.

/** A past occupant of a lane that still exists, newest first. */
export type LanePastEntry = {
  sessionId: SessionId
  /** Epoch ms the agent left the lane. */
  at: number
}

/**
 * The lane's past occupants that still exist, newest first, never including
 * the current occupant.
 *
 * WHY filter dead agents here as well as at autosave: the prune runs on its
 * own tick, so between a close and the next save the lane can still name an
 * agent that is gone. A row, chip or ⌥B target for it would be a pick that
 * cannot go anywhere.
 */
export function lanePastEntries(state: WorkspaceState, laneIndex: number): LanePastEntry[] {
  const lane = state.stage.lanes[laneIndex]
  if (!lane?.history) return []
  return lane.history.filter(entry =>
    entry.sessionId !== lane.selectedSessionId && state.sessions[entry.sessionId] !== undefined)
}

/** The agent ⌥B would bring back into this lane, or null. */
export function previousLaneSession(state: WorkspaceState, laneIndex: number): SessionId | null {
  return lanePastEntries(state, laneIndex)[0]?.sessionId ?? null
}

/**
 * The index label ("A2", "★1") a user already knows an agent by.
 *
 * WHY the label and not the title: the chip strip, the index and ⌘N all name
 * agents by label, so "↶ A2" is recognisable at a glance in a 10px header
 * where a title would be truncated to nothing. `null` for a session the index
 * cannot label (it is mid-reload) — callers fall back to the title.
 */
export function laneAgentLabel(state: WorkspaceState, sessionId: SessionId): string | null {
  return sessionDisplayLabel(state, sessionId, buildVisibleDispatchRows(state))
}

/**
 * "Row 1 · Lane 2", 1-based, for titles that must say WHICH lane they are
 * about. The first Lane History dialog said nothing, so a user whose focus
 * was in another lane than they thought got that lane's history with no clue.
 */
export function lanePositionLabel(state: WorkspaceState, laneIndex: number): string | null {
  const grid = normalizeGridShape(state.stage)
  const row = rowIndexForLane(grid.rows, laneIndex)
  if (row < 0) return null
  const column = laneIndex - rowStartIndex(grid.rows, row)
  // A one-row stage has no row to disambiguate; "Row 1" there is noise.
  return grid.rows.length > 1 ? `Row ${row + 1} · Lane ${column + 1}` : `Lane ${column + 1}`
}

/**
 * Put `target` (default: the previous agent) back into `laneIndex` and focus
 * that lane. Returns false when there was nothing to go back to.
 *
 * Through `selectTiledLaneSession`, never the raw lane writer: a hibernated
 * agent has to wake before it is placed (#690). That same writer records the
 * agent being replaced as a departure, which is what makes ⌥B a TOGGLE — the
 * agent you just left becomes the newest history entry, so pressing ⌥B again
 * returns to it, like Alt-Tab.
 *
 * The toast goes to the ARRIVING agent's pane (pane toasts are session-scoped)
 * and names the agent a second ⌥B would return to, so the toggle is
 * discoverable from the first press. `chord` is passed in rather than read
 * here so this stays callable from non-React code with the user's binding.
 */
export function goBackInLane(
  workspace: Workspace,
  laneIndex: number,
  options: { target?: SessionId; chord?: string | null } = {},
): boolean {
  // The LIVE state, not `workspace.state`: callers include an awaited native
  // menu, and the Workspace object captured when it opened carries the state
  // from before. The store's workspace slice is the source the actions write
  // synchronously, so this is the same state they will act on. (The actions
  // themselves read through refs, so a captured Workspace is fine for them.)
  const state = (useAppStore.getState().workspaceState as WorkspaceState | undefined) ?? workspace.state
  const lane = state.stage.lanes[laneIndex]
  if (!lane) return false
  const target = options.target ?? previousLaneSession(state, laneIndex)
  if (!target || target === lane.selectedSessionId || !state.sessions[target]) return false
  const leaving = lane.selectedSessionId && state.sessions[lane.selectedSessionId]
    ? lane.selectedSessionId
    : null

  void workspace.selectTiledLaneSession(laneIndex, target)
  workspace.setTiledFocusedLane(laneIndex)

  const arriving = laneAgentLabel(state, target) ?? 'agent'
  const returnTo = leaving ? laneAgentLabel(state, leaving) : null
  const message = returnTo && options.chord
    ? `Back to ${arriving} · ${options.chord} returns to ${returnTo}`
    : `Back to ${arriving}`
  workspace.showPaneToast(target, message)
  return true
}
