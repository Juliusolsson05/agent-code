import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useAppStore } from '@renderer/app-state/store'
import type { CommandContext } from '@renderer/features/command-palette/types'
import { layoutCommands } from '@renderer/features/workspace/commands/layoutCommands'
import { withLaneSession } from '@renderer/workspace/dispatch/tiledDispatchSelectors'
import { PaneHeader } from '@renderer/workspace/tile-tree/TileLeaf/PaneHeader'
import type { DispatchLane, SessionId, WorkspaceState } from '@renderer/workspace/types'
import { WorkspaceProvider } from '@renderer/workspace/WorkspaceContext'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import { laneHistoryMenuItems, leftAgo } from './LaneBackChip'
import { goBackInLane, lanePastEntries, lanePositionLabel, previousLaneSession } from './laneHistoryModel'
import { LaneHistoryModal } from './LaneHistoryModal'
import { LaneRecentList } from './LaneRecentList'
import { LaneSlotProvider } from './LaneSlotContext'

// Lane History's four surfaces — ⌥B (Lane Back), the "↶ A2" header chip and
// its native menu, the empty lane's "Recently here" list, and the dialog —
// over ONE workspace that lives in the real app store, the way the app runs:
// the store slice is the live workspace state, and the fake actions below
// write it through the real selection helper (`withLaneSession`), so the
// departure recording that makes ⌥B a toggle is the production code, not a
// stand-in.

const MIN = 60_000
const initialWorkspaceState = useAppStore.getState().workspaceState

function baseState(lanes: DispatchLane[], focusedLane = 0, rows?: number[]): WorkspaceState {
  return {
    tabs: [{ id: 'tab-a', title: 'alpha' }, { id: 'tab-b', title: 'beta' }],
    activeTabId: 'tab-a',
    stage: { lanes, rows: (rows ?? [lanes.length]).map(length => ({ length })), focusedLane },
    sessions: {
      a1: { cwd: '/work/alpha/one', kind: 'claude', projectId: 'tab-a', joinedAt: 0, title: 'Fix the auth tests' },
      a2: { cwd: '/work/alpha/two', kind: 'codex', projectId: 'tab-a', joinedAt: 1, title: 'Build settings page' },
      a3: { cwd: '/work/alpha/three', kind: 'claude', projectId: 'tab-a', joinedAt: 2, title: 'Refactor queue' },
      b1: { cwd: '/work/beta/one', kind: 'codex', projectId: 'tab-b', joinedAt: 0, title: 'Deploy script' },
    },
    pinnedSessionIds: [],
  } as WorkspaceState
}

function harness(lanes: DispatchLane[], focusedLane = 0, rows?: number[]) {
  useAppStore.setState({ workspaceState: baseState(lanes, focusedLane, rows) })
  const setState = (update: (prev: WorkspaceState) => WorkspaceState) =>
    useAppStore.getState().setWorkspaceState(update as never)
  const showPaneToast = vi.fn()
  const selectTiledLaneSession = vi.fn(async (laneIndex: number, sessionId: SessionId) => {
    setState(prev => ({
      ...prev,
      stage: {
        ...prev.stage,
        lanes: prev.stage.lanes.map((lane, i) => (i === laneIndex ? withLaneSession(lane, sessionId) : lane)),
      },
    }))
  })
  const setTiledFocusedLane = vi.fn((laneIndex: number) => {
    setState(prev => ({ ...prev, stage: { ...prev.stage, focusedLane: laneIndex } }))
  })
  const workspace = {
    get state() { return useAppStore.getState().workspaceState },
    selectTiledLaneSession,
    setTiledFocusedLane,
    showPaneToast,
  } as unknown as Workspace
  const lane = (index: number) => useAppStore.getState().workspaceState.stage.lanes[index]!
  return { workspace, selectTiledLaneSession, setTiledFocusedLane, showPaneToast, lane }
}

beforeEach(() => {
  window.api = { ...window.api, showPopupMenu: vi.fn().mockResolvedValue(null) } as typeof window.api
})

afterEach(() => {
  cleanup()
  useAppStore.getState().closeLaneHistory()
  useAppStore.setState({ workspaceState: initialWorkspaceState })
})

describe('the model all four surfaces share', () => {
  it('lists live past agents newest first, never the occupant or a closed agent', () => {
    const state = baseState([{
      selectedSessionId: 'a1',
      history: [
        { sessionId: 'closed', at: 3 },
        { sessionId: 'a2', at: 2 },
        { sessionId: 'b1', at: 1 },
      ],
    }])
    expect(lanePastEntries(state, 0).map(entry => entry.sessionId)).toEqual(['a2', 'b1'])
    expect(previousLaneSession(state, 0)).toBe('a2')
  })

  it('names the lane, adding the row only when there is more than one', () => {
    expect(lanePositionLabel(baseState([{}, {}]), 1)).toBe('Lane 2')
    expect(lanePositionLabel(baseState([{}, {}, {}], 0, [2, 1]), 2)).toBe('Row 2 · Lane 1')
  })

  it('says when an agent LEFT, not when it was opened', () => {
    const now = Date.now()
    expect(leftAgo(now - 5 * MIN, now)).toBe('left 5m ago')
    expect(leftAgo(now, now)).toBe('left just now')
  })
})

describe('Lane Back (⌥B)', () => {
  const command = layoutCommands.find(candidate => candidate.id === 'lane-back')
  if (!command) throw new Error('Lane Back command is missing')

  it('toggles between the last two agents, like Alt-Tab', async () => {
    const t = harness([{ selectedSessionId: 'a1' }])
    await act(async () => { await t.workspace.selectTiledLaneSession(0, 'a2') })
    const context = () => ({ workspace: t.workspace, ui: {}, flags: {} }) as unknown as CommandContext

    expect(command.when?.(context())).toBe(true)
    await act(async () => { await command.run(context()) })
    expect(t.lane(0).selectedSessionId).toBe('a1')

    // The agent just left is now the newest entry, so the same key returns.
    await act(async () => { await command.run(context()) })
    expect(t.lane(0).selectedSessionId).toBe('a2')
  })

  it('toasts the ARRIVING pane with where a second press goes', async () => {
    const t = harness([{ selectedSessionId: 'a2', history: [{ sessionId: 'a1', at: Date.now() }] }])
    await goBackInLane(t.workspace, 0, { chord: '⌥B' })
    expect(t.showPaneToast).toHaveBeenCalledWith('a1', 'Back to A1 · ⌥B returns to A2')
  })

  it('toasts only after a cold wake places the agent, once, and never for a failed wake', async () => {
    // #1511 review: the toast used to fire before the wake, so a slow wake
    // outlived it, a failed wake still announced success, and a second ⌥B
    // during the wake started a second wake.
    const t = harness([{ selectedSessionId: 'a2', history: [{ sessionId: 'a1', at: Date.now() }] }])
    let finishWake!: () => void
    const place = t.selectTiledLaneSession.getMockImplementation()!
    t.selectTiledLaneSession.mockImplementationOnce((laneIndex, sessionId) =>
      new Promise<void>(resolve => { finishWake = () => { void place(laneIndex, sessionId).then(resolve) } }))

    const first = goBackInLane(t.workspace, 0)
    expect(await goBackInLane(t.workspace, 0)).toBe(false)
    expect(t.selectTiledLaneSession).toHaveBeenCalledTimes(1)
    expect(t.showPaneToast).not.toHaveBeenCalled()

    await act(async () => { finishWake() })
    expect(await first).toBe(true)
    expect(t.showPaneToast).toHaveBeenCalledTimes(1)

    // A wake that fails leaves the lane alone: no "Back to" over it.
    t.showPaneToast.mockClear()
    t.selectTiledLaneSession.mockImplementationOnce(async () => {})
    expect(await goBackInLane(t.workspace, 0)).toBe(false)
    expect(t.showPaneToast).not.toHaveBeenCalled()
  })

  it('decides from the LIVE store, not the Workspace object it was handed', async () => {
    // The native menu awaits; the Workspace captured when it opened is stale.
    // A snapshot that still shows a1 as previous must not win over the store,
    // where the lane has since moved on.
    const t = harness([{ selectedSessionId: 'a2', history: [{ sessionId: 'a1', at: 1 }] }])
    const stale = { ...t.workspace, state: t.workspace.state } as Workspace
    await act(async () => { await t.workspace.selectTiledLaneSession(0, 'a1') })

    await goBackInLane(stale, 0)
    // Live: a1 is the occupant and a2 the previous agent, so back goes to a2.
    expect(t.lane(0).selectedSessionId).toBe('a2')
  })

  it('is not offered, and does nothing, when the lane has no live previous agent', async () => {
    const t = harness([{ selectedSessionId: 'a1', history: [{ sessionId: 'closed', at: 1 }] }])
    const context = { workspace: t.workspace, ui: {}, flags: {} } as unknown as CommandContext
    expect(command.when?.(context)).toBe(false)
    expect(await goBackInLane(t.workspace, 0)).toBe(false)
    expect(t.selectTiledLaneSession).not.toHaveBeenCalled()
  })
})

describe('the ↶ chip in the pane header', () => {
  const header = (t: ReturnType<typeof harness>, laneIndex: number | null) => (
    <WorkspaceProvider workspace={t.workspace}>
      {laneIndex === null
        ? <PaneHeader sessionId="a2" projectDir="/work/alpha/two" statusMode={false} isSessionLive={false} />
        : (
          <LaneSlotProvider value={laneIndex}>
            <PaneHeader sessionId="a2" projectDir="/work/alpha/two" statusMode={false} isSessionLive={false} />
          </LaneSlotProvider>
        )}
    </WorkspaceProvider>
  )

  it('shows the previous agent in a lane and puts it back on click', async () => {
    const t = harness([{ selectedSessionId: 'a2', history: [{ sessionId: 'a1', at: Date.now() }] }])
    render(header(t, 0))

    const chip = screen.getByRole('button', { name: /Back to A1/ })
    expect(chip.textContent).toContain('↶')
    expect(chip.textContent).toContain('A1')
    await act(async () => { fireEvent.click(chip) })
    expect(t.lane(0).selectedSessionId).toBe('a1')
  })

  it('is absent outside a lane (Spotlight, Sidekick) and in a lane with no past', () => {
    const t = harness([{ selectedSessionId: 'a2', history: [{ sessionId: 'a1', at: Date.now() }] }, { selectedSessionId: 'a3' }])
    const outside = render(header(t, null))
    expect(screen.queryByRole('button', { name: /Back to/ })).toBeNull()
    outside.unmount()

    render(header(t, 1))
    expect(screen.queryByRole('button', { name: /Back to/ })).toBeNull()
  })

  it('right-click opens the lane history as a native menu, and a pick puts that agent back', async () => {
    const t = harness([{
      selectedSessionId: 'a2',
      history: [{ sessionId: 'a1', at: Date.now() - MIN }, { sessionId: 'b1', at: Date.now() - 60 * MIN }],
    }])
    const showPopupMenu = vi.fn().mockResolvedValue('lane-history:pick:b1')
    window.api = { ...window.api, showPopupMenu } as typeof window.api
    render(header(t, 0))

    await act(async () => { fireEvent.contextMenu(screen.getByRole('button', { name: /Back to A1/ })) })

    const { items } = showPopupMenu.mock.calls[0]![0] as { items: Array<{ type: string; label?: string }> }
    expect(items.map(item => item.label ?? item.type)).toEqual([
      'Back to A1  Fix the auth tests  ·  left 1m ago',
      // B4, not B1: index labels count rows across the whole index, and the
      // label shown must be the one the index and strip show for that agent.
      'B4  Deploy script  ·  left 1h ago',
      'separator',
      'Lane History…',
    ])
    expect(t.lane(0).selectedSessionId).toBe('b1')
  })

  it('the menu\'s last item opens the full dialog for this lane', async () => {
    const state = baseState([{ selectedSessionId: 'a2', history: [{ sessionId: 'a1', at: 0 }] }])
    const items = laneHistoryMenuItems(state, 0, 'Alt+B')
    expect(items[0]).toMatchObject({ accelerator: 'Alt+B' })
    expect(items.at(-1)).toMatchObject({ id: 'lane-history:dialog', label: 'Lane History…' })

    const t = harness([{ selectedSessionId: 'a2', history: [{ sessionId: 'a1', at: 0 }] }])
    window.api = { ...window.api, showPopupMenu: vi.fn().mockResolvedValue('lane-history:dialog') } as typeof window.api
    render(header(t, 0))
    await act(async () => { fireEvent.contextMenu(screen.getByRole('button', { name: /Back to A1/ })) })
    expect(useAppStore.getState().laneHistoryLane).toBe(0)
  })

  it('drops a menu pick when a different lane slid into its slot while it was open', async () => {
    // #1511 review: removing an earlier lane during the (modal, awaited) menu
    // moved another lane into the captured index; the pick replaced THAT
    // lane's agent.
    const t = harness([{ selectedSessionId: 'b1' }, { selectedSessionId: 'a2', history: [{ sessionId: 'a1', at: 0 }] }, { selectedSessionId: 'a3' }])
    window.api = {
      ...window.api,
      showPopupMenu: vi.fn(async () => {
        useAppStore.getState().setWorkspaceState((prev: WorkspaceState) => ({
          ...prev,
          stage: { ...prev.stage, lanes: [prev.stage.lanes[1]!, prev.stage.lanes[2]!], rows: [{ length: 2 }] },
        }))
        return 'lane-history:pick:a1'
      }),
    } as typeof window.api
    render(header(t, 1))
    await act(async () => { fireEvent.contextMenu(screen.getByRole('button', { name: /Back to A1/ })) })

    expect(t.selectTiledLaneSession).not.toHaveBeenCalled()
    expect(t.lane(1).selectedSessionId).toBe('a3')
  })
})

describe('"Recently here" in an empty lane', () => {
  it('lists the agents a cleared lane held and puts one back on click', async () => {
    const t = harness([{ history: [{ sessionId: 'a1', at: Date.now() - 2 * MIN }, { sessionId: 'b1', at: Date.now() - 60 * MIN }] }])
    render(<LaneRecentList laneIndex={0} workspace={t.workspace} />)

    const list = screen.getByRole('listbox', { name: 'Agents recently in this lane' })
    const rows = within(list).getAllByRole('option').map(row => row.textContent)
    expect(rows).toEqual([
      expect.stringMatching(/^A1.*Fix the auth tests.*left 2m ago$/),
      expect.stringMatching(/^B4.*Deploy script.*left 1h ago$/),
    ])

    await act(async () => { fireEvent.click(within(list).getAllByRole('option')[1]!) })
    expect(t.lane(0).selectedSessionId).toBe('b1')
    expect(t.setTiledFocusedLane).toHaveBeenCalledWith(0)
  })

  it('keeps the highlight on the same agent when one above it closes, and links the rest', async () => {
    const now = Date.now()
    const history = ['a1', 'a2', 'a3', 'b1'].map((sessionId, i) => ({ sessionId, at: now - i * MIN }))
    const t = harness([{ history }])
    // Two per list here would need 6+ live agents; the cap is 5, so add one
    // past entry the list cannot show to prove the "more" link.
    useAppStore.getState().setWorkspaceState((prev: WorkspaceState) => ({
      ...prev,
      sessions: Object.fromEntries([...Object.entries(prev.sessions), ...['c1', 'c2'].map((id, i) => [id, { cwd: `/w/${id}`, kind: 'claude', projectId: 'tab-b', joinedAt: 5 + i }])]),
      stage: { ...prev.stage, lanes: [{ history: [...history, { sessionId: 'c1', at: 0 }, { sessionId: 'c2', at: 0 }] }] },
    }))
    render(<LaneRecentList laneIndex={0} workspace={t.workspace} />)
    const list = screen.getByRole('listbox', { name: 'Agents recently in this lane' })
    // Six live past agents, five shown: the "more" link is a real tab stop
    // OUTSIDE the listbox (a listbox may only contain options).
    const more = screen.getByRole('button', { name: /more — Lane History/ })
    expect(list.contains(more)).toBe(false)
    expect(more.tabIndex).toBe(0)

    fireEvent.keyDown(list, { key: 'ArrowDown' })
    fireEvent.keyDown(list, { key: 'ArrowDown' })

    // a1 (above the highlighted a3) closes.
    act(() => {
      useAppStore.getState().setWorkspaceState((prev: WorkspaceState) => {
        const { a1: _closed, ...sessions } = prev.sessions
        return { ...prev, sessions }
      })
    })
    await act(async () => { fireEvent.keyDown(list, { key: 'Enter' }) })
    expect(t.lane(0).selectedSessionId).toBe('a3')

  })

  it('renders nothing for a lane that never held an agent', () => {
    const t = harness([{}])
    const { container } = render(<LaneRecentList laneIndex={0} workspace={t.workspace} />)
    expect(container.innerHTML).toBe('')
  })
})

describe('Lane History dialog', () => {
  it('says which lane, lists past agents only, and shows the occupant as "Now"', () => {
    const now = Date.now()
    const t = harness([{}, {
      selectedSessionId: 'a3',
      history: [{ sessionId: 'a1', at: now - 5 * MIN }, { sessionId: 'b1', at: now - 3 * 60 * MIN }],
    }])
    render(<LaneHistoryModal laneIndex={1} workspace={t.workspace} onClose={vi.fn()} />)

    expect(screen.getByText('Lane History — Lane 2')).toBeTruthy()
    const rows = within(screen.getByRole('listbox', { name: 'Lane history' })).getAllByRole('option')
    expect(rows.map(row => row.textContent)).toEqual([
      expect.stringMatching(/^A1.*Fix the auth tests.*alpha.*left 5m ago$/),
      expect.stringMatching(/^B4.*Deploy script.*beta.*left 3h ago$/),
    ])
    expect(screen.getByText(/^Now:/).textContent).toContain('A3')
  })

  it('focuses the list on the newest agent; ↓ then Enter puts the second one back', async () => {
    const onClose = vi.fn()
    const t = harness([{ selectedSessionId: 'a3', history: [{ sessionId: 'a1', at: 2 }, { sessionId: 'b1', at: 1 }] }])
    render(<LaneHistoryModal laneIndex={0} workspace={t.workspace} onClose={onClose} />)

    const list = screen.getByRole('listbox', { name: 'Lane history' })
    expect(document.activeElement).toBe(list)
    fireEvent.keyDown(list, { key: 'ArrowDown' })
    await act(async () => { fireEvent.keyDown(list, { key: 'Enter' }) })

    expect(t.lane(0).selectedSessionId).toBe('b1')
    // Exactly once: the footer's Put Back must not also act on that Enter.
    expect(t.selectTiledLaneSession).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalled()
  })

  it('closes, and refuses the pick, when a different lane slides into its slot', () => {
    // #1504 review: uiShell holds a flat index. Removing lane 0 while the
    // dialog is open for lane 1 slides old lane 2 into slot 1; listing that
    // lane's past, or placing the pick there, would act on a lane the user
    // never opened.
    const onClose = vi.fn()
    const t = harness([{}, { selectedSessionId: 'a3', history: [{ sessionId: 'a1', at: 1 }] }, { selectedSessionId: 'b1' }])
    const view = render(<LaneHistoryModal laneIndex={1} workspace={t.workspace} onClose={onClose} />)
    const row = within(screen.getByRole('listbox', { name: 'Lane history' })).getAllByRole('option')[0]!

    act(() => {
      useAppStore.getState().setWorkspaceState((prev: WorkspaceState) => ({
        ...prev,
        stage: { ...prev.stage, lanes: [prev.stage.lanes[0]!, prev.stage.lanes[2]!], rows: [{ length: 2 }] },
      }))
    })
    view.rerender(<LaneHistoryModal laneIndex={1} workspace={t.workspace} onClose={onClose} />)

    expect(onClose).toHaveBeenCalled()
    fireEvent.click(row)
    expect(t.selectTiledLaneSession).not.toHaveBeenCalled()
  })

  it('says so when no other agent has been in the lane', () => {
    const t = harness([{ selectedSessionId: 'a1' }])
    render(<LaneHistoryModal laneIndex={0} workspace={t.workspace} onClose={vi.fn()} />)
    expect(screen.getByText('No other agent has been in this lane yet.')).toBeTruthy()
  })
})

describe('Lane History command', () => {
  const command = layoutCommands.find(candidate => candidate.id === 'lane-history')
  if (!command) throw new Error('Lane History command is missing')

  it('opens the dialog for the lane focused when it ran', () => {
    const t = harness([{}, { selectedSessionId: 'a1' }], 1)
    const context = { workspace: t.workspace, ui: {}, flags: {} } as unknown as CommandContext

    expect(command.when?.(context)).toBe(true)
    command.run(context)

    expect(useAppStore.getState().laneHistoryLane).toBe(1)
  })
})
