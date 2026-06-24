import {
  buildVisibleDispatchRows,
  selectVisibleDispatchRow,
  type DispatchAgentRow,
} from '@renderer/workspace/dispatch/dispatchSelectors'
import type { SessionId, TabId, WorkspaceState } from '@renderer/workspace/types'

export type DispatchVisualTarget = {
  row: DispatchAgentRow
  laneIndex: number | null
  source: 'tiled-lane' | 'classic-focus' | 'grid-fallback' | 'first-row'
}

export type DispatchAttachTarget = {
  sessionId: SessionId
  targetTabId: TabId
}

/**
 * Resolve the visible Dispatch row a command should act on.
 *
 * WHY this is separate from `dispatchFocusedSessionId` and
 * `resolveDispatchSpawnTarget`:
 * Tiled Dispatch has two legitimate target semantics that used to be
 * collapsed into one fallback chain. Lifecycle/destructive commands need
 * STRICT visual intent: if the focused lane is empty or stale, there is no
 * session selected and the command must not silently fall through to classic
 * focus, grid focus, or row 1. Spawn/defaulting flows are different: an empty
 * lane can still inherit a useful project from classic focus or the active
 * tab. Keeping this helper command-shaped makes call sites choose their policy
 * instead of inheriting a convenient fallback by accident.
 */
export function resolveDispatchVisualTarget(
  state: WorkspaceState,
  options: { strictTiledLane: boolean },
): DispatchVisualTarget | null {
  const dispatchMode = state.dispatchMode
  if (!dispatchMode) return null

  const rows = buildVisibleDispatchRows(state)
  if (rows.length === 0) return null

  if (dispatchMode.tiled) {
    const laneIndex = dispatchMode.tiled.focusedLane
    const laneSessionId = dispatchMode.tiled.lanes[laneIndex]?.selectedSessionId ?? null
    const laneRow = laneSessionId
      ? rows.find(row => row.sessionId === laneSessionId) ?? null
      : null
    if (laneRow) return { row: laneRow, laneIndex, source: 'tiled-lane' }
    if (options.strictTiledLane) return null
  }

  const activeTab = state.tabs.find(tab => tab.id === state.activeTabId)
  const row = selectVisibleDispatchRow(
    rows,
    dispatchMode.focusedSessionId,
    activeTab?.focusedSessionId,
  )
  if (!row) return null
  const source = row.sessionId === dispatchMode.focusedSessionId
    ? 'classic-focus'
    : row.sessionId === activeTab?.focusedSessionId
      ? 'grid-fallback'
      : 'first-row'
  return { row, laneIndex: null, source }
}

export function resolveStrictDispatchCommandTarget(
  state: WorkspaceState,
): DispatchVisualTarget | null {
  return resolveDispatchVisualTarget(state, { strictTiledLane: true })
}

export function resolveDispatchAttachTarget(
  state: WorkspaceState,
): DispatchAttachTarget | null {
  const target = resolveStrictDispatchCommandTarget(state)
  if (!target) return null
  return {
    sessionId: target.row.sessionId,
    targetTabId: target.row.tabId,
  }
}
