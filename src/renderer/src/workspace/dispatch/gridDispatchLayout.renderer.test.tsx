import { cleanup, render } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DispatchLayout } from '@renderer/workspace/dispatch/DispatchLayout'
import type { SessionId, TiledDispatchState, WorkspaceState } from '@renderer/workspace/types'
import type { Workspace } from '@renderer/workspace/workspaceStore'

// The grid actually rendering as a grid.
//
// gridShape's unit tests prove the shape ALGEBRA; this proves the layout
// consumes it — that rows are independent on screen, that a bound row's index
// really is filtered, and that every lane gets its own strip. Those are exactly
// the claims a pure-function test cannot make, and the #673 post-mortem is the
// reason the distinction is taken seriously here: a splice proven correct by a
// unit test shipped as a no-op because the component undid it on render.

const appState = vi.hoisted(() => ({
  workspaceRuntimes: {},
  dispatchListRatio: 0.25,
  openNewAgentForProject: vi.fn(),
  setDispatchListRatio: vi.fn(),
  openDispatchRowProjectPicker: vi.fn(),
}))

vi.mock('@renderer/app-state/hooks', () => ({
  useAppStore: (selector: (state: typeof appState) => unknown) => selector(appState),
}))
vi.mock('@renderer/features/shared/SplitHandle', () => ({
  SplitHandle: ({ orientation }: { orientation?: string }) => (
    <div data-testid="split-handle" data-orientation={orientation ?? 'vertical'} />
  ),
}))
vi.mock('@renderer/features/shared/useResizableSplitter', () => ({
  useResizableSplitter: () => ({ dragging: false, onMouseDown: vi.fn(), cursorLock: null }),
}))
// The real index list is mocked down to the one fact each row must get right:
// which agents it was asked to list, and which grid row it belongs to.
vi.mock('@renderer/workspace/dispatch/DispatchAgentList', () => ({
  DispatchAgentList: ({ groups, gridRow, focusSessionInTab }: {
    groups: { rows: { sessionId: string; tabId: string }[] }[]
    gridRow?: { projectTabIds?: string[] }
    focusSessionInTab: (tabId: string, sessionId: string) => void
  }) => {
    const rows = groups.flatMap(g => g.rows)
    return (
      <div
        data-testid="row-index"
        data-project={(gridRow?.projectTabIds ?? []).join(',')}
        data-sessions={rows.map(r => r.sessionId).join(',')}
        // Stands in for clicking a row in the real index.
        onClick={() => {
          const row = rows[1] ?? rows[0]
          if (row) focusSessionInTab(row.tabId, row.sessionId)
        }}
      />
    )
  },
  DispatchEmpty: ({ message }: { message: string }) => (
    <div data-testid="lane-empty">{message}</div>
  ),
}))
// The strip is mocked down to what the LAYOUT owns about it: which lane's
// selection it was handed (the only way to tell one lane's strip from
// another's, since the fixture's lanes hold distinct agents), whether its
// expand control is wired, and where the layout's own `onSelect` closure sends
// a pick. Chip rendering is DispatchColorFlags.renderer.test.tsx's job.
vi.mock('@renderer/workspace/dispatch/DispatchMiniList', () => ({
  DispatchMiniList: ({ rows, selectedSessionId, onSelect, onToggleExpandedParent }: {
    rows: { sessionId: string }[]
    selectedSessionId?: string
    onSelect: (row: { sessionId: string }) => void
    onToggleExpandedParent?: (id: string) => void
  }) => {
    // Stands in for clicking a chip. It picks an agent OTHER than the lane's
    // current one, so the click is a real swap and a layout that ignored it
    // could not pass by leaving the lane as it was.
    const pick = rows.find(row => row.sessionId !== selectedSessionId)
    return (
      <div
        data-testid="lane-strip"
        data-selected={selectedSessionId ?? ''}
        data-pick={pick?.sessionId ?? ''}
        data-can-expand={onToggleExpandedParent ? 'true' : 'false'}
        onClick={() => {
          if (pick) onSelect(pick)
        }}
      />
    )
  },
}))
vi.mock('@providers/registry.renderer', () => ({
  getRendererProvider: () => ({
    TileLeaf: ({ sessionId }: { sessionId: string }) => (
      <div data-testid="lane-agent" data-session-id={sessionId} />
    ),
  }),
}))

const FIXTURE = JSON.parse(
  readFileSync('testing/fixtures/worktree-context/dispatch-global-d23.json', 'utf8'),
) as { state: WorkspaceState }

function renderGrid(tiled: TiledDispatchState) {
  const selectTiledLaneSession = vi.fn().mockResolvedValue(undefined)
  const setTiledFocusedLane = vi.fn()
  const state: WorkspaceState = {
    ...FIXTURE.state,
    dispatchMode: { ...FIXTURE.state.dispatchMode!, scope: 'global', tiled },
  }
  const workspace = {
    state,
    activeTab: state.tabs.find(tab => tab.id === state.activeTabId) ?? null,
    runtimes: {},
    getRuntime: (id: string) => ({ projectDir: state.sessions[id]?.cwd ?? null }),
    focusDispatchSession: vi.fn(),
    focusSessionInTab: vi.fn(),
    selectGridRelatedSession: vi.fn(),
    setTiledFocusedLane,
    selectTiledLaneSession,
    setDispatchRowHeights: vi.fn(),
    setDispatchRowIndexFraction: vi.fn(),
    setDispatchLaneWeights: vi.fn(),
    setDispatchRowCapChildren: vi.fn(),
    toggleDispatchRowExpandedParent: vi.fn(),
  } as unknown as Workspace
  return {
    ...render(
      <DispatchLayout
        workspace={workspace}
        agentViewMode="agent"
        showStatusMode={false}
        showWorktreeBadges={false}
      />,
    ),
    selectTiledLaneSession,
    setTiledFocusedLane,
  }
}

const laneIds = FIXTURE.state.dispatchMode!.tiled!.lanes.map(
  lane => lane.selectedSessionId,
) as SessionId[]

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Grid Dispatch layout', () => {
  it('gives every row its own index list', () => {
    // The structural claim the whole design rests on. One shared full-height
    // sidebar could not answer "whose agents am I listing?" once two rows are
    // bound to different projects.
    const { getAllByTestId } = renderGrid({
      lanes: laneIds.map(id => ({ selectedSessionId: id })),
      rows: [{ length: 2 }, { length: 2 }],
      focusedLane: 0,
    })

    expect(getAllByTestId('row-index')).toHaveLength(2)
  })

  it('gives every lane its own strip, the first lane of each row included', () => {
    // #850. A row's index fills whichever lane of the row is FOCUSED, so it is
    // no single lane's selector. Any lane without a strip, which used to be
    // each row's first lane, could only be changed in two gestures: click into
    // it, then pick from the index. A single-lane row is included on purpose.
    // If it had no strip, adding a second lane would slide a strip into the
    // existing lane and shift its content by 46px.
    const cases: { rows: TiledDispatchState['rows']; strips: number }[] = [
      { rows: [{ length: 2 }, { length: 2 }], strips: 4 },
      { rows: [{ length: 3 }, { length: 1 }], strips: 4 },
    ]
    for (const { rows, strips } of cases) {
      const { getAllByTestId } = renderGrid({
        lanes: laneIds.map(id => ({ selectedSessionId: id })),
        rows,
        focusedLane: 0,
      })

      expect(getAllByTestId('lane-strip')).toHaveLength(strips)
      cleanup()
    }
  })

  it('swaps the first lane from its own strip while another lane has focus', () => {
    // The navigation #850 restores. With focus in lane 1, the row's index would
    // fill lane 1, so lane 0's strip is the only one-click way to change lane 0.
    // It has to write lane 0 (not the focused lane) through the waking path,
    // and move focus there, because picking an agent for a lane means working
    // in it next. Selecting by its current agent is what identifies lane 0's
    // strip: the fixture's lanes hold distinct agents.
    const { getAllByTestId, selectTiledLaneSession, setTiledFocusedLane } = renderGrid({
      lanes: laneIds.map(id => ({ selectedSessionId: id })),
      rows: [{ length: 2 }, { length: 2 }],
      focusedLane: 1,
    })

    const firstLaneStrip = getAllByTestId('lane-strip')
      .find(strip => strip.getAttribute('data-selected') === laneIds[0])
    expect(firstLaneStrip).toBeDefined()
    const picked = firstLaneStrip!.getAttribute('data-pick')
    expect(picked).toBeTruthy()
    firstLaneStrip!.click()

    expect(selectTiledLaneSession).toHaveBeenCalledTimes(1)
    expect(selectTiledLaneSession).toHaveBeenCalledWith(0, picked)
    expect(setTiledFocusedLane).toHaveBeenCalledTimes(1)
    expect(setTiledFocusedLane).toHaveBeenCalledWith(0)
  })

  it('wires the strip s expand control instead of shipping a dead button', () => {
    // The strip renders "+N more" as a real button and optional-calls this
    // handler. Omitting it shipped an affordance that promises an action and
    // silently does nothing — in the exact case the cap exists for.
    const { getAllByTestId } = renderGrid({
      lanes: laneIds.map(id => ({ selectedSessionId: id })),
      rows: [{ length: 2 }, { length: 2 }],
      focusedLane: 0,
    })

    for (const strip of getAllByTestId('lane-strip')) {
      expect(strip.getAttribute('data-can-expand')).toBe('true')
    }
  })

  it('renders uneven rows without evening them out', () => {
    // P3 on screen: 3 lanes above 1 stays 3 above 1.
    const { getAllByTestId } = renderGrid({
      lanes: laneIds.map(id => ({ selectedSessionId: id })),
      rows: [{ length: 3 }, { length: 1 }],
      focusedLane: 0,
    })

    // Four agents across two rows, and a horizontal divider between them.
    expect(getAllByTestId('lane-agent')).toHaveLength(4)
    const horizontal = getAllByTestId('split-handle')
      .filter(node => node.getAttribute('data-orientation') === 'horizontal')
    expect(horizontal).toHaveLength(1)
  })

  it('passes each row s own project binding to its index', () => {
    const boundTab = FIXTURE.state.activeTabId
    const { getAllByTestId } = renderGrid({
      lanes: laneIds.map(id => ({ selectedSessionId: id })),
      rows: [{ length: 2, projectTabIds: [boundTab] }, { length: 2 }],
      focusedLane: 0,
    })

    const indexes = getAllByTestId('row-index')
    expect(indexes[0]!.getAttribute('data-project')).toBe(boundTab)
    // The unbound row is NOT narrowed by its neighbour's binding — rows are
    // independent in what they list, not only in how wide they are.
    expect(indexes[1]!.getAttribute('data-project')).toBe('')
  })

  it('selects through the waking path, never the raw lane writer', () => {
    // #690: rehydrate deliberately does not respawn detached sessions, so a
    // hibernated agent placed straight into a lane renders fine and then
    // rejects the first prompt as "not a live agent session". Every selection
    // gesture has to go through the action that wakes first.
    const { getAllByTestId, selectTiledLaneSession } = renderGrid({
      lanes: laneIds.map(id => ({ selectedSessionId: id })),
      rows: [{ length: 2 }, { length: 2 }],
      focusedLane: 0,
    })

    const index = getAllByTestId('row-index')[0]!
    const offered = index.getAttribute('data-sessions')!.split(',')
    index.click()

    expect(selectTiledLaneSession).toHaveBeenCalledTimes(1)
    const [laneIndex, sessionId] = selectTiledLaneSession.mock.calls[0]!
    // Into this row's first lane, with an agent the row actually offers.
    expect(laneIndex).toBe(0)
    expect(offered).toContain(sessionId)
  })

  it('sends a row s index click into THAT row, not the focused one', () => {
    // With focus in row 0, clicking row 1's index must target row 1's first
    // lane (flat 2). Clicking a row's index means "I am working in this row
    // now", so it must never reach across into the row that happens to have
    // focus. The earlier version of this test clicked row 0's index while focus
    // was already in row 0, so it could not tell `focusedLaneInRow` from `start`.
    const { getAllByTestId, selectTiledLaneSession } = renderGrid({
      lanes: laneIds.map(id => ({ selectedSessionId: id })),
      rows: [{ length: 2 }, { length: 2 }],
      focusedLane: 0,
    })

    getAllByTestId('row-index')[1]!.click()

    expect(selectTiledLaneSession).toHaveBeenCalledTimes(1)
    expect(selectTiledLaneSession.mock.calls[0]![0]).toBe(2)
  })

  it('gives a row bound to two projects both their index sections', () => {
    // The feature in one assertion, and the reason it is cheap:
    // buildDispatchGroups already groups by tab, so a two-project row renders
    // two labelled sections with no new rendering code.
    const tabs = [...new Set(
      FIXTURE.state.tabs.map(tab => tab.id),
    )].slice(0, 2)
    expect(tabs).toHaveLength(2)

    const { getAllByTestId } = renderGrid({
      lanes: laneIds.map(id => ({ selectedSessionId: id })),
      rows: [{ length: 2, projectTabIds: tabs }, { length: 2 }],
      focusedLane: 0,
    })

    const bound = getAllByTestId('row-index')[0]!
    expect(bound.getAttribute('data-project')).toBe(tabs.join(','))
    // And the unbound row is not narrowed by its neighbour's binding.
    expect(getAllByTestId('row-index')[1]!.getAttribute('data-project')).toBe('')
  })

  it('still renders a pre-grid single-row workspace', () => {
    // The migration path, end to end: no `rows` at all means one row holding
    // every lane, and it must render rather than crash on a missing descriptor.
    const { getAllByTestId } = renderGrid(FIXTURE.state.dispatchMode!.tiled!)

    expect(getAllByTestId('row-index')).toHaveLength(1)
    expect(getAllByTestId('lane-agent')).toHaveLength(laneIds.length)
  })
})
