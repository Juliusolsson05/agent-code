import { describe, expect, it, vi } from 'vitest'

import { buildVisibleDispatchRows } from '@renderer/workspace/dispatch/dispatchSelectors'
import { focusRowByLabel, moveLaneFocusWithinRow, moveLaneSelection } from '@renderer/workspace/dispatch/laneKeyboard'
import type { Workspace } from '@renderer/workspace/hook'
import { loadRecordedDispatchWorkspace } from '@renderer/workspace/testing/recordedDispatchWorkspace'
import type { TiledDispatchState, WorkspaceState } from '@renderer/workspace/types'

// The lane keyboard grammar (#992 stage 5) had no behavioural test, only
// "the chord routes to the command id" (#1013 review B, finding 14). These
// cases run the real grammar on the recorded global-Dispatch workspace: 4
// lanes in one row, lane 1 focused, 24 index rows across 4 projects.
// selectTiledLaneSession is the action boundary (it wakes and writes, and it
// has its own suite), so it is observed here, not re-implemented.

function recorded(stage?: Partial<TiledDispatchState>) {
  const { state } = loadRecordedDispatchWorkspace()
  const next: WorkspaceState = stage ? { ...state, stage: { ...state.stage, ...stage } } : state
  const selectTiledLaneSession = vi.fn(async () => undefined)
  const setTiledFocusedLane = vi.fn()
  const workspace = { state: next, stage: next.stage, selectTiledLaneSession, setTiledFocusedLane } as unknown as Workspace
  return { workspace, state: next, selectTiledLaneSession, setTiledFocusedLane }
}

describe('⌘N: fill the focused lane from the index by label', () => {
  it('places the row whose label number is N into the focused lane', () => {
    const { workspace, state, selectTiledLaneSession } = recorded()
    const row7 = buildVisibleDispatchRows(state).find(row => row.globalIndex === 7)!
    focusRowByLabel(workspace, 6)
    expect(selectTiledLaneSession).toHaveBeenCalledExactlyOnceWith(state.stage.focusedLane, row7.sessionId)
  })

  it('does nothing for a number past the last row', () => {
    const { workspace, selectTiledLaneSession } = recorded()
    focusRowByLabel(workspace, 98)
    expect(selectTiledLaneSession).not.toHaveBeenCalled()
  })

  it('in a row bound to one project, a label from another project places nothing', () => {
    // Labels are canonical, never renumbered: a bound row shows gaps, and ⌘N
    // must agree with the chips the row shows.
    const base = recorded()
    const rows = buildVisibleDispatchRows(base.state)
    const [first] = rows
    const foreign = rows.find(row => row.tabId !== first!.tabId)!
    const { workspace, selectTiledLaneSession } = recorded({ rows: [{ length: base.state.stage.lanes.length, projectTabIds: [first!.tabId] }] })
    focusRowByLabel(workspace, foreign.globalIndex - 1)
    expect(selectTiledLaneSession).not.toHaveBeenCalled()
  })
})

describe('⌥↑/↓: walk the focused lane through its row\'s index', () => {
  it('steps to the next row and wraps from the last to the first', () => {
    const base = recorded()
    const rows = buildVisibleDispatchRows(base.state)
    const lanes = base.state.stage.lanes.map((lane, index) => (index === base.state.stage.focusedLane ? { ...lane, selectedSessionId: rows.at(-1)!.sessionId } : lane))
    const { workspace, selectTiledLaneSession } = recorded({ lanes })
    moveLaneSelection(workspace, 1)
    expect(selectTiledLaneSession).toHaveBeenCalledExactlyOnceWith(base.state.stage.focusedLane, rows[0]!.sessionId)
  })

  it('steps back from the first row to the last', () => {
    const base = recorded()
    const rows = buildVisibleDispatchRows(base.state)
    const lanes = base.state.stage.lanes.map((lane, index) => (index === base.state.stage.focusedLane ? { ...lane, selectedSessionId: rows[0]!.sessionId } : lane))
    const { workspace, selectTiledLaneSession } = recorded({ lanes })
    moveLaneSelection(workspace, -1)
    expect(selectTiledLaneSession).toHaveBeenCalledExactlyOnceWith(base.state.stage.focusedLane, rows.at(-1)!.sessionId)
  })
})

describe('⌥←/→: move lane focus within the row, stopping at its edges', () => {
  it('moves one lane at a time', () => {
    const { workspace, state, setTiledFocusedLane } = recorded()
    moveLaneFocusWithinRow(workspace, 1)
    expect(setTiledFocusedLane).toHaveBeenCalledExactlyOnceWith(state.stage.focusedLane + 1)
  })

  it('stops at the first and the last lane instead of wrapping', () => {
    const first = recorded({ focusedLane: 0 })
    moveLaneFocusWithinRow(first.workspace, -1)
    expect(first.setTiledFocusedLane).not.toHaveBeenCalled()
    const lastIndex = first.state.stage.lanes.length - 1
    const last = recorded({ focusedLane: lastIndex })
    moveLaneFocusWithinRow(last.workspace, 1)
    expect(last.setTiledFocusedLane).not.toHaveBeenCalled()
  })
})
