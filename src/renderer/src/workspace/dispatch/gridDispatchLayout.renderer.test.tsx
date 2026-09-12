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
  // The hint is exposed as data, not asserted as copy: the layout decides
  // WHETHER an empty lane may advertise a pick, and that decision is the
  // behavior worth pinning. The wording is a design choice.
  DispatchEmpty: ({ message, hint }: { message: string; hint?: string }) => (
    <div data-testid="lane-empty" data-hint={hint ?? ''}>{message}</div>
  ),
}))
// The strip is mocked down to what the LAYOUT owns about it:
// - which lane's selection it was handed (the only way to tell one lane's
//   strip from another's, since the fixture's lanes hold distinct agents);
// - which grid row's binding it was handed;
// - where the layout's own `onSelect` and `onToggleExpandedParent` closures
//   send a pick or an expand.
// Chip rendering is DispatchColorFlags.renderer.test.tsx's job, and the row
// filtering the real strip applies is rowScopedRows.test.ts's.
vi.mock('@renderer/workspace/dispatch/DispatchMiniList', () => ({
  DispatchMiniList: ({ rows, gridRow, selectedSessionId, onSelect, onToggleExpandedParent }: {
    rows: { sessionId: string }[]
    gridRow?: { projectTabIds?: string[] }
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
        data-project={(gridRow?.projectTabIds ?? []).join(',')}
        onClick={() => {
          if (pick) onSelect(pick)
        }}
      >
        {/* Stands in for the strip's "+N more" control. It stops propagation
            so that expanding never doubles as a chip pick. */}
        <button
          type="button"
          data-testid="lane-strip-expand"
          onClick={event => {
            event.stopPropagation()
            onToggleExpandedParent?.('parent-under-cap')
          }}
        />
      </div>
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
  const toggleDispatchRowExpandedParent = vi.fn()
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
    toggleDispatchRowExpandedParent,
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
    toggleDispatchRowExpandedParent,
  }
}

/** The strip handed `sessionId` as its lane's selection. Fails loudly unless
 *  exactly one strip matches: identifying a lane by its agent relies on the
 *  fixture's lanes holding distinct agents, and a silent first match would let
 *  a changed fixture click the wrong lane's strip and still pass. */
function stripSelecting(strips: HTMLElement[], sessionId: string): HTMLElement {
  const matches = strips.filter(strip => strip.getAttribute('data-selected') === sessionId)
  expect(matches).toHaveLength(1)
  return matches[0]!
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

  it('writes each strip s own lane and focuses it, wherever focus is', () => {
    // The navigation #850 restores: a strip is the selector addressed to ONE
    // lane, so a pick must land in that lane (through the waking path) and move
    // focus there, never into whichever lane happens to be focused. The first
    // case is the #850 gesture itself. With focus in lane 1, the row's index
    // would fill lane 1, so lane 0's strip is the only one-click way to change
    // lane 0.
    //
    // Why three cases: in flat lane 0, `laneIndex`, `column` and `start` are
    // all 0, so a strip wired to the wrong one would pass there. Lane 2 (row 1,
    // column 0, focus in the other row) catches `column`. Lane 3 (row 1,
    // column 1, focus in the same row) catches `start` and `grid.focusedLane`.
    const cases = [
      { lane: 0, focusedLane: 1 },
      { lane: 2, focusedLane: 1 },
      { lane: 3, focusedLane: 2 },
    ]
    for (const { lane, focusedLane } of cases) {
      const { getAllByTestId, selectTiledLaneSession, setTiledFocusedLane } = renderGrid({
        lanes: laneIds.map(id => ({ selectedSessionId: id })),
        rows: [{ length: 2 }, { length: 2 }],
        focusedLane,
      })

      const strip = stripSelecting(getAllByTestId('lane-strip'), laneIds[lane]!)
      const picked = strip.getAttribute('data-pick')
      expect(picked).toBeTruthy()
      strip.click()

      expect(selectTiledLaneSession.mock.calls).toEqual([[lane, picked]])
      expect(setTiledFocusedLane.mock.calls).toEqual([[lane]])
      cleanup()
    }
  })

  it('expands a capped parent in the strip s own row', () => {
    // The strip's "+N more" expands a parent in ITS row only (expandedParents
    // is per-row state). Before, this test checked only that a handler was
    // present, so a no-op handler, or one hardcoded to row 0, still passed and
    // shipped a button that expands the wrong row or nothing at all. DOM order
    // is row-major: two strips in row 0, then two in row 1.
    const { getAllByTestId, toggleDispatchRowExpandedParent } = renderGrid({
      lanes: laneIds.map(id => ({ selectedSessionId: id })),
      rows: [{ length: 2 }, { length: 2 }],
      focusedLane: 0,
    })

    for (const expand of getAllByTestId('lane-strip-expand')) expand.click()

    expect(toggleDispatchRowExpandedParent.mock.calls).toEqual([
      [0, 'parent-under-cap'],
      [0, 'parent-under-cap'],
      [1, 'parent-under-cap'],
      [1, 'parent-under-cap'],
    ])
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

  it('passes each strip its own row s project binding', () => {
    // A strip lists what its ROW offers (rowScopedRows filters by the row's
    // binding). If a strip were handed another row's descriptor, or none, it
    // would offer agents its row's index excludes, and a pick from it would
    // place a project-A agent in a row bound to project B. Row-major DOM order:
    // row 0's two strips first.
    const boundTab = FIXTURE.state.activeTabId
    const { getAllByTestId } = renderGrid({
      lanes: laneIds.map(id => ({ selectedSessionId: id })),
      rows: [{ length: 2, projectTabIds: [boundTab] }, { length: 2 }],
      focusedLane: 0,
    })

    expect(getAllByTestId('lane-strip').map(strip => strip.getAttribute('data-project')))
      .toEqual([boundTab, boundTab, '', ''])
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
    // focus. This case cannot tell `focusedLaneInRow ?? start` from a bare
    // `start` (focus is outside the clicked row, so both give 2); the next test
    // is the one that pins follow-focus.
    const { getAllByTestId, selectTiledLaneSession } = renderGrid({
      lanes: laneIds.map(id => ({ selectedSessionId: id })),
      rows: [{ length: 2 }, { length: 2 }],
      focusedLane: 0,
    })

    getAllByTestId('row-index')[1]!.click()

    expect(selectTiledLaneSession).toHaveBeenCalledTimes(1)
    expect(selectTiledLaneSession.mock.calls[0]![0]).toBe(2)
  })

  it('fills the focused lane from a row s index when focus is already in that row', () => {
    // The premise of #850. The index follows focus within its row, so it is no
    // single lane's selector, and every lane needs its own strip for that
    // reason. If the index ever goes back to always filling the row's first
    // lane, this fails. At that point the first lane's strip is a duplicate
    // selector and #850's reasoning should be revisited, not silently kept.
    const { getAllByTestId, selectTiledLaneSession, setTiledFocusedLane } = renderGrid({
      lanes: laneIds.map(id => ({ selectedSessionId: id })),
      rows: [{ length: 2 }, { length: 2 }],
      focusedLane: 1,
    })

    getAllByTestId('row-index')[0]!.click()

    expect(selectTiledLaneSession).toHaveBeenCalledTimes(1)
    expect(selectTiledLaneSession.mock.calls[0]![0]).toBe(1)
    expect(setTiledFocusedLane.mock.calls).toEqual([[1]])
  })

  it('withholds the empty-lane hint when the row offers no agents', () => {
    // The hint advertises two gestures: pick from the strip, or press ⌥↓. Both
    // act on the ROW's offered set (rowScopedRows; ⌥↓ via tiledRowScopedRows).
    // In a row whose projects currently have no agents, the strip is empty and
    // ⌥↓ returns without doing anything, so the hint would promise a pick that
    // cannot happen. The contrasting unbound row pins the other half, so the fix
    // cannot be "never show a hint". The tab id is deliberately one no session
    // belongs to.
    const cases = [
      { rows: [{ length: 2 }], hinted: true },
      { rows: [{ length: 2, projectTabIds: ['tab-with-no-agents'] }], hinted: false },
    ]
    for (const { rows, hinted } of cases) {
      const { getByTestId } = renderGrid({
        // Lane 1 empty AND focused: the only lane the hint may appear in.
        lanes: [{ selectedSessionId: laneIds[0] }, {}],
        rows,
        focusedLane: 1,
      })

      expect(getByTestId('lane-empty').getAttribute('data-hint') !== '').toBe(hinted)
      cleanup()
    }
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
