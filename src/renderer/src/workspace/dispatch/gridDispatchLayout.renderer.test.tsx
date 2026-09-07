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
vi.mock('@renderer/workspace/dispatch/DispatchMiniList', () => ({
  DispatchMiniList: ({ onToggleExpandedParent }: {
    onToggleExpandedParent?: (id: string) => void
  }) => (
    <div
      data-testid="lane-strip"
      data-can-expand={onToggleExpandedParent ? 'true' : 'false'}
    />
  ),
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
    setTiledFocusedLane: vi.fn(),
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

  it('leaves each row s FIRST lane to that row s index list', () => {
    // The row's own index sits directly beside its first lane and is that
    // lane's selector — the pairing that giving every row an index exists for.
    // A strip there would be a second selector for the same lane, inches from
    // the first, eating 46px of the row's widest lane.
    const { getAllByTestId } = renderGrid({
      lanes: laneIds.map(id => ({ selectedSessionId: id })),
      rows: [{ length: 2 }, { length: 2 }],
      focusedLane: 0,
    })

    // 2 rows x 2 lanes, minus the first lane of each row.
    expect(getAllByTestId('lane-strip')).toHaveLength(2)
  })

  it('gives a strip to every lane the index does not already select', () => {
    const { getAllByTestId } = renderGrid({
      lanes: laneIds.map(id => ({ selectedSessionId: id })),
      rows: [{ length: 3 }, { length: 1 }],
      focusedLane: 0,
    })

    // Row 0 keeps strips on lanes 2 and 3; row 1's single lane has none.
    expect(getAllByTestId('lane-strip')).toHaveLength(2)
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
    // Load-bearing once each row's first lane lost its strip: with focus in
    // row 0, clicking row 1's index must target row 1's first lane (flat 2).
    // The earlier version of this test clicked row 0's index while focus was
    // already in row 0, so it could not tell `focusedLaneInRow` from `start`.
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
