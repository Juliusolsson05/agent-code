import { cleanup, render } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DispatchLayout } from '@renderer/workspace/dispatch/DispatchLayout'
import { buildVisibleDispatchRows } from '@renderer/workspace/dispatch/dispatchSelectors'
import { clearTiledLaneSessions } from '@renderer/workspace/dispatch/tiledDispatchSelectors'
import type { SessionId, TiledDispatchState, WorkspaceState } from '@renderer/workspace/types'
import type { Workspace } from '@renderer/workspace/workspaceStore'

// What a lane does when it CANNOT resolve.
//
// This file replaces tiledLaneHealing.renderer.test.tsx, which asserted the
// opposite contract: that an unresolved lane is handed the next available
// agent. That healer is gone. Killing the agent in column 2 of 6 used to
// refill column 2 with whatever was next in the index — the user closed one
// thing and an unrelated thing appeared in the position they were watching.
//
// Resolution itself is unchanged and still needs its assertions: a lane whose
// id is dead or out of scope must not paint that session. Only the REACTION to
// a null resolution changed, from "refill it" to "render empty".
//
// WHY this renders the layout rather than asserting on the reducer: the first
// #673 attempt proved an empty-lane splice with a pure-function test that
// passed while the shipped feature was a no-op, because the effect refilled the
// lane on the next render. A unit test cannot see that; only mounting can.

const appState = vi.hoisted(() => ({
  dispatchListRatio: 0.25,
  openNewAgentForProject: vi.fn(),
  setDispatchListRatio: vi.fn(),
}))

vi.mock('@renderer/app-state/hooks', () => ({
  useAppStore: (selector: (state: typeof appState) => unknown) => selector(appState),
}))
vi.mock('@renderer/features/shared/SplitHandle', () => ({ SplitHandle: () => null }))
vi.mock('@renderer/features/shared/useResizableSplitter', () => ({
  useResizableSplitter: () => ({ dragging: false, onMouseDown: vi.fn(), cursorLock: null }),
}))
vi.mock('@renderer/workspace/dispatch/DispatchAgentList', () => ({
  DispatchAgentList: () => null,
  DispatchEmpty: ({ message, hint }: { message: string; hint?: string }) => (
    <div data-testid="lane-empty" data-hint={hint ?? ''}>{message}</div>
  ),
}))
vi.mock('@renderer/workspace/dispatch/DispatchMiniList', () => ({
  DispatchMiniList: () => null,
}))
vi.mock('@providers/registry.renderer', () => ({
  getRendererProvider: () => ({
    TileLeaf: ({ sessionId }: { sessionId: string }) => (
      <div data-testid="lane-agent" data-session-id={sessionId} />
    ),
  }),
}))

// A REAL persisted Agent Code workspace: 4 tabs, 24 sessions, 12 detached, 3
// orchestration parents, and a tiled block with 4 live lanes. Using the
// recording rather than a hand-built state matters most for the kill case
// below — the lane ids, the detached/grid split, and the scope filtering are
// all shapes the product actually produced, not ones this test imagined.
const FIXTURE = JSON.parse(
  readFileSync('testing/fixtures/worktree-context/dispatch-global-d23.json', 'utf8'),
) as { state: WorkspaceState }

function recordedState(tiled: TiledDispatchState): WorkspaceState {
  return {
    ...FIXTURE.state,
    dispatchMode: { ...FIXTURE.state.dispatchMode!, tiled },
  }
}

function workspaceFor(
  state: WorkspaceState,
  setTiledLaneSession: ReturnType<typeof vi.fn>,
): Workspace {
  return {
    state,
    activeTab: state.tabs.find(tab => tab.id === state.activeTabId) ?? null,
    runtimes: {},
    getRuntime: (sessionId: string) => ({ projectDir: state.sessions[sessionId]?.cwd ?? null }),
    focusDispatchSession: vi.fn(),
    focusSessionInTab: vi.fn(),
    selectGridRelatedSession: vi.fn(),
    setTiledFocusedLane: vi.fn(),
    setTiledLaneSession,
    setTiledRatios: vi.fn(),
  } as unknown as Workspace
}

function renderLanes(tiled: TiledDispatchState, state = recordedState(tiled)) {
  const setTiledLaneSession = vi.fn()
  const result = render(
    <DispatchLayout
      workspace={workspaceFor(state, setTiledLaneSession)}
      agentViewMode="agent"
      showStatusMode={false}
      showWorktreeBadges={false}
    />,
  )
  const painted = () =>
    result.queryAllByTestId('lane-agent').map(node => node.getAttribute('data-session-id'))
  return { ...result, setTiledLaneSession, painted }
}

// The lanes this workspace was actually saved with.
const RECORDED_LANES = FIXTURE.state.dispatchMode!.tiled!.lanes.map(
  lane => lane.selectedSessionId,
) as SessionId[]

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('unresolved tiled lanes', () => {
  it('paints exactly the agents the recorded workspace selected', () => {
    // The baseline the cases below are diffed against. If this drifts, every
    // assertion after it is measuring the wrong thing.
    const { painted } = renderLanes(FIXTURE.state.dispatchMode!.tiled!)

    expect(RECORDED_LANES.length).toBeGreaterThanOrEqual(4)
    expect(painted()).toEqual(RECORDED_LANES)
  })

  it('leaves a killed agent s slot empty instead of refilling it', () => {
    // THE reported confusion, pinned. Kill the agent in a middle lane and that
    // lane must go empty — not acquire an unrelated agent, and not shuffle the
    // lanes around it.
    //
    // The removal goes through the real production helper rather than a
    // hand-edited lane array, so this exercises the same path close/kill/bury
    // actually take.
    const killed = RECORDED_LANES[1]!
    const afterKill = clearTiledLaneSessions(
      FIXTURE.state.dispatchMode!,
      killed,
    )
    const survivors = { ...FIXTURE.state.sessions }
    delete survivors[killed]

    const { painted, setTiledLaneSession } = renderLanes(
      afterKill!.tiled!,
      { ...recordedState(afterKill!.tiled!), sessions: survivors },
    )

    // Nothing was handed to the empty lane...
    expect(setTiledLaneSession).not.toHaveBeenCalled()
    // ...and every other lane still shows exactly what it showed before.
    expect(painted()).toEqual(RECORDED_LANES.filter(id => id !== killed))
  })

  it('does not paint a lane whose session no longer exists', () => {
    // Resolution's remaining job. A stale id must not reach renderWorkspaceLeaf
    // even for one render, or a dead session mounts.
    const tiled: TiledDispatchState = {
      lanes: [
        { selectedSessionId: RECORDED_LANES[0]! },
        { selectedSessionId: 'session-does-not-exist' as SessionId },
      ],
      focusedLane: 0,
    }

    const { painted } = renderLanes(tiled)

    expect(painted()).toEqual([RECORDED_LANES[0]])
  })

  it('renders an out-of-scope lane empty while keeping its selection', () => {
    // Project scope builds rows from activeTabId alone, so a lane holding
    // another project's agent cannot resolve. It must render empty WITHOUT the
    // selection being destroyed: flipping scope back has to bring the agent
    // back. The old healer replaced the selection irreversibly, which is why
    // this is asserted on the state as well as the paint.
    // Picked through the real row builder rather than by guessing at the
    // fixture's internals: all four RECORDED_LANES happen to live in the active
    // tab, so a foreign lane has to be sourced from the global row stream.
    const foreign = buildVisibleDispatchRows({
      ...FIXTURE.state,
      dispatchMode: { ...FIXTURE.state.dispatchMode!, scope: 'global' },
    }).find(row => row.tabId !== FIXTURE.state.activeTabId)?.sessionId
    expect(foreign).toBeDefined()

    const tiled: TiledDispatchState = {
      lanes: [{ selectedSessionId: foreign! }],
      focusedLane: 0,
    }
    const projectScoped: WorkspaceState = {
      ...FIXTURE.state,
      dispatchMode: { ...FIXTURE.state.dispatchMode!, scope: 'project', tiled },
    }

    const { painted, setTiledLaneSession, getAllByTestId } = renderLanes(tiled, projectScoped)

    expect(painted()).toEqual([])
    expect(getAllByTestId('lane-empty')).toHaveLength(1)
    // The selection survives — nothing rewrote the lane.
    expect(setTiledLaneSession).not.toHaveBeenCalled()
    expect(tiled.lanes[0]?.selectedSessionId).toBe(foreign)
  })

  it('offers the keystroke hint only in the lane the keystroke would act on', () => {
    // ⌥↓ acts on tiled.focusedLane, so advertising it inside an unfocused empty
    // lane would tell the user to press a key that yanks the agent they were
    // working with and leaves this lane untouched.
    const { getAllByTestId } = renderLanes({
      lanes: [{ selectedSessionId: RECORDED_LANES[0]! }, {}, {}],
      focusedLane: 2,
    })

    const empties = getAllByTestId('lane-empty')
    expect(empties).toHaveLength(2)
    expect(empties[0]!.getAttribute('data-hint')).toBe('')
    expect(empties[1]!.getAttribute('data-hint')).toContain('⌥↓')
  })
})
