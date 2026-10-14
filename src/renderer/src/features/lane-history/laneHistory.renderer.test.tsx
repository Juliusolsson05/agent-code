import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useAppStore } from '@renderer/app-state/store'
import type { CommandContext } from '@renderer/features/command-palette/types'
import { layoutCommands } from '@renderer/features/workspace/commands/layoutCommands'
import type { DispatchLane, SessionId } from '@renderer/workspace/types'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import { LaneHistoryModal } from './LaneHistoryModal'

afterEach(() => {
  cleanup()
  useAppStore.getState().closeLaneHistory()
})

const S = (n: string): SessionId => `session-${n}`
const MIN = 60_000

function workspaceWith(lanes: DispatchLane[], focusedLane = 0, live = ['a', 'b', 'c']) {
  const selectTiledLaneSession = vi.fn().mockResolvedValue(undefined)
  const setTiledFocusedLane = vi.fn()
  const workspace = {
    state: {
      stage: { lanes, rows: [{ length: lanes.length }], focusedLane },
      sessions: Object.fromEntries(live.map(id => [S(id), { cwd: `/work/${id}`, kind: 'terminal', title: `Agent ${id.toUpperCase()}` }])),
    },
    selectTiledLaneSession,
    setTiledFocusedLane,
  } as unknown as Workspace
  return { workspace, selectTiledLaneSession, setTiledFocusedLane }
}

const rowTexts = () =>
  within(screen.getByRole('list', { name: 'Lane history' }))
    .getAllByRole('button')
    .map(button => button.textContent)

describe('Lane History dialog', () => {
  it('lists the current agent, then past agents newest first with how long ago they left', () => {
    const now = Date.now()
    const { workspace } = workspaceWith([
      { selectedSessionId: S('a'), history: [{ sessionId: S('b'), at: now - 5 * MIN }, { sessionId: S('c'), at: now - 3 * 60 * MIN }] },
    ])
    render(<LaneHistoryModal laneIndex={0} workspace={workspace} onClose={vi.fn()} />)

    expect(rowTexts()).toEqual(['Agent ANow', 'Agent B5m ago', 'Agent C3h ago'])
  })

  it('hides agents that no longer exist', () => {
    // Autosave prunes on its own tick, so a just-closed agent can still be in
    // the lane's history; a row for it would be a click that goes nowhere.
    const { workspace } = workspaceWith(
      [{ selectedSessionId: S('a'), history: [{ sessionId: S('closed'), at: Date.now() }, { sessionId: S('b'), at: Date.now() }] }],
      0,
      ['a', 'b'],
    )
    render(<LaneHistoryModal laneIndex={0} workspace={workspace} onClose={vi.fn()} />)

    expect(rowTexts()).toEqual(['Agent ANow', 'Agent Bjust now'])
  })

  it('clicking a past agent puts it back in THIS lane, focuses the lane and closes', () => {
    const onClose = vi.fn()
    const { workspace, selectTiledLaneSession, setTiledFocusedLane } = workspaceWith(
      [{ selectedSessionId: S('c') }, { selectedSessionId: S('a'), history: [{ sessionId: S('b'), at: Date.now() }] }],
      0,
    )
    // The dialog is for lane 1 even though lane 0 is focused: the lane is
    // captured when the command runs, never re-read from focus.
    render(<LaneHistoryModal laneIndex={1} workspace={workspace} onClose={onClose} />)

    fireEvent.click(screen.getByRole('button', { name: /Agent B/ }))

    expect(selectTiledLaneSession).toHaveBeenCalledWith(1, S('b'))
    expect(setTiledFocusedLane).toHaveBeenCalledWith(1)
    expect(onClose).toHaveBeenCalled()
  })

  it('closes, and refuses the pick, when a different lane slides into its slot', () => {
    // #1504 review: uiShell holds a flat index. Removing lane 0 while the
    // dialog is open for lane 1 slides old lane 2 into slot 1; listing that
    // lane's past, or placing the pick there, would act on a lane the user
    // never opened.
    const onClose = vi.fn()
    const target: DispatchLane = { selectedSessionId: S('a'), history: [{ sessionId: S('b'), at: Date.now() }] }
    const other: DispatchLane = { selectedSessionId: S('c') }
    const { workspace, selectTiledLaneSession } = workspaceWith([{}, target, other])
    const view = render(<LaneHistoryModal laneIndex={1} workspace={workspace} onClose={onClose} />)
    expect(onClose).not.toHaveBeenCalled()

    const button = screen.getByRole('button', { name: /Agent B/ })
    ;(workspace.state as { stage: { lanes: DispatchLane[] } }).stage.lanes = [{}, other]
    view.rerender(<LaneHistoryModal laneIndex={1} workspace={workspace} onClose={onClose} />)

    expect(onClose).toHaveBeenCalled()
    fireEvent.click(button)
    expect(selectTiledLaneSession).not.toHaveBeenCalled()
  })

  it('focuses the newest past agent: row 1 when row 0 is "Now", row 0 after Clear Lane', () => {
    const now = Date.now()
    const withCurrent = workspaceWith([{ selectedSessionId: S('a'), history: [{ sessionId: S('b'), at: now }] }])
    const first = render(<LaneHistoryModal laneIndex={0} workspace={withCurrent.workspace} onClose={vi.fn()} />)
    expect(document.activeElement?.textContent).toContain('Agent B')
    first.unmount()

    // #1504 review: an emptied lane has no "Now" row; skipping row 0 anyway
    // put Enter on the OLDER agent.
    const cleared = workspaceWith([{ history: [{ sessionId: S('b'), at: now }, { sessionId: S('a'), at: now - MIN }] }])
    render(<LaneHistoryModal laneIndex={0} workspace={cleared.workspace} onClose={vi.fn()} />)
    expect(document.activeElement?.textContent).toContain('Agent B')
  })

  it('says so when the lane has never held an agent', () => {
    const { workspace } = workspaceWith([{}])
    render(<LaneHistoryModal laneIndex={0} workspace={workspace} onClose={vi.fn()} />)

    expect(screen.getByText('No agents have been in this lane yet.')).toBeTruthy()
  })
})

describe('Lane History command', () => {
  const command = layoutCommands.find(candidate => candidate.id === 'lane-history')
  if (!command) throw new Error('Lane History command is missing')

  it('opens the dialog for the lane focused when it ran', () => {
    const { workspace } = workspaceWith([{}, { selectedSessionId: S('a') }], 1)
    const context = { workspace, ui: {}, flags: {} } as unknown as CommandContext

    expect(command.when?.(context)).toBe(true)
    command.run(context)

    expect(useAppStore.getState().laneHistoryLane).toBe(1)
  })

  it('is inert when focus names no lane', () => {
    const { workspace } = workspaceWith([{}], 3)
    const context = { workspace, ui: {}, flags: {} } as unknown as CommandContext

    expect(command.when?.(context)).toBe(false)
    command.run(context)

    expect(useAppStore.getState().laneHistoryLane).toBeNull()
  })
})
