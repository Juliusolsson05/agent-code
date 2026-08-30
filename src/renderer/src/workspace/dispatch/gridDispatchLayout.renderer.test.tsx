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
  DispatchAgentList: ({ groups, gridRow }: {
    groups: { rows: { sessionId: string }[] }[]
    gridRow?: { projectTabId?: string }
  }) => (
    <div
      data-testid="row-index"
      data-project={gridRow?.projectTabId ?? ''}
      data-sessions={groups.flatMap(g => g.rows.map(r => r.sessionId)).join(',')}
    />
  ),
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
    setTiledLaneSession: vi.fn(),
    setDispatchRowHeights: vi.fn(),
    setDispatchRowIndexFraction: vi.fn(),
    setDispatchLaneWeights: vi.fn(),
    setDispatchRowCapChildren: vi.fn(),
    toggleDispatchRowExpandedParent: vi.fn(),
  } as unknown as Workspace
  return render(
    <DispatchLayout
      workspace={workspace}
      agentViewMode="agent"
      showStatusMode={false}
      showWorktreeBadges={false}
    />,
  )
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

  it('gives every lane its own strip, including each row s first', () => {
    // The old layout gave lane 0 no strip because the sidebar WAS its selector.
    // With a per-row index that special case is meaningless, and a row whose
    // first lane had no selector would be unusable from the mouse.
    const { getAllByTestId } = renderGrid({
      lanes: laneIds.map(id => ({ selectedSessionId: id })),
      rows: [{ length: 2 }, { length: 2 }],
      focusedLane: 0,
    })

    expect(getAllByTestId('lane-strip')).toHaveLength(4)
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
      rows: [{ length: 2, projectTabId: boundTab }, { length: 2 }],
      focusedLane: 0,
    })

    const indexes = getAllByTestId('row-index')
    expect(indexes[0]!.getAttribute('data-project')).toBe(boundTab)
    // The unbound row is NOT narrowed by its neighbour's binding — rows are
    // independent in what they list, not only in how wide they are.
    expect(indexes[1]!.getAttribute('data-project')).toBe('')
  })

  it('still renders a pre-grid single-row workspace', () => {
    // The migration path, end to end: no `rows` at all means one row holding
    // every lane, and it must render rather than crash on a missing descriptor.
    const { getAllByTestId } = renderGrid(FIXTURE.state.dispatchMode!.tiled!)

    expect(getAllByTestId('row-index')).toHaveLength(1)
    expect(getAllByTestId('lane-agent')).toHaveLength(laneIds.length)
  })
})
