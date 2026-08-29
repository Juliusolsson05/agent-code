import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DispatchLayout } from '@renderer/workspace/dispatch/DispatchLayout'
import {
  clearTiledLaneSessions,
  insertLaneRightIntoTiled,
  keepTiledLaneSessions,
  withLaneSession,
} from '@renderer/workspace/dispatch/tiledDispatchSelectors'
import type { SessionId, TiledDispatchState, WorkspaceState } from '@renderer/workspace/types'
import type { Workspace } from '@renderer/workspace/workspaceStore'

// The healer is the reason "New Lane inserts an empty lane" needed more than a
// reducer change (#673).
//
// WHY this test renders the LAYOUT instead of asserting the splice: the first
// implementation of #673 made `insertLaneRightIntoTiled` return `{}` and proved
// it with a pure-function test, which passed — while the shipped feature was a
// no-op. `TiledDispatchLayout`'s auto-fill effect hands the next unclaimed agent
// to any lane that does not resolve, so the new lane was refilled on the very
// next render and the user saw exactly the duplicate they had complained about.
// A unit test on the splice cannot see that; only mounting the component can.
// Both halves of the contract are asserted here because they are in tension:
// the deliberate hole must survive, and the accidental one must still heal.

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

function stateWithLanes(tiled: TiledDispatchState): WorkspaceState {
  // Three visible agents in one project, two of them shown in lanes — so there
  // is always an unclaimed agent for the healer to reach for. If the healer
  // ever runs on the new lane, it has something to put there and the assertion
  // below fails loudly rather than passing by starvation.
  return {
    tabs: [{
      id: 'tabA',
      title: 'project-a',
      root: { type: 'leaf', sessionId: 'a1' as SessionId },
      focusedSessionId: 'a1' as SessionId,
    }],
    activeTabId: 'tabA',
    dispatchMode: { scope: 'project', tiled },
    sessions: {
      a1: { cwd: '/work/a', kind: 'claude' },
      a2: { cwd: '/work/a', kind: 'claude' },
      a3: { cwd: '/work/a', kind: 'claude' },
    },
    detachedSessions: {
      a2: {
        sessionId: 'a2' as SessionId,
        surface: 'dispatch',
        projectTabId: 'tabA',
        projectTabTitle: 'project-a',
        projectTabIndex: 0,
        detachedAt: 100,
      },
      a3: {
        sessionId: 'a3' as SessionId,
        surface: 'dispatch',
        projectTabId: 'tabA',
        projectTabTitle: 'project-a',
        projectTabIndex: 0,
        detachedAt: 200,
      },
    },
    buried: [],
    pinnedSessionIds: [],
  } as unknown as WorkspaceState
}

function workspaceFor(state: WorkspaceState, setTiledLaneSession: ReturnType<typeof vi.fn>): Workspace {
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

function renderLayout(tiled: TiledDispatchState) {
  const setTiledLaneSession = vi.fn()
  const state = stateWithLanes(tiled)
  const result = render(
    <DispatchLayout
      workspace={workspaceFor(state, setTiledLaneSession)}
      agentViewMode="agent"
      showStatusMode={false}
      showWorktreeBadges={false}
    />,
  )
  return { ...result, setTiledLaneSession }
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Tiled Dispatch lane healing vs. deliberate emptiness (#673)', () => {
  it('does not refill a lane the user emptied via New Lane', () => {
    // Exactly what the command produces: insert beside lane 0, agents a1/a2
    // already shown, a3 free and waiting for any healer that runs.
    const inserted = insertLaneRightIntoTiled(
      { lanes: [{ selectedSessionId: 'a1' as SessionId }, { selectedSessionId: 'a2' as SessionId }], focusedLane: 0 },
      0,
    )
    expect(inserted).not.toBeNull()
    expect(inserted?.lanes[1]).toEqual({ userEmptied: true })

    const { setTiledLaneSession, getAllByTestId } = renderLayout(inserted!)

    // The whole feature in one assertion: the healer ran, saw a lane it could
    // fill and an agent to fill it with, and left it alone.
    expect(setTiledLaneSession).not.toHaveBeenCalled()
    expect(getAllByTestId('lane-empty')).toHaveLength(1)
  })

  it('still refills a lane that emptied because its agent went away', () => {
    // The tension: clearTiledLaneSessions blanks a lane when its agent exits
    // and DEPENDS on the healer re-homing another agent into the hole. That
    // lane carries no `userEmptied`, so it must still be filled — otherwise
    // this fix trades one bug for a worse one.
    const { setTiledLaneSession } = renderLayout({
      lanes: [{ selectedSessionId: 'a1' as SessionId }, { selectedSessionId: undefined }],
      focusedLane: 0,
    })

    expect(setTiledLaneSession).toHaveBeenCalledWith(1, 'a2')
  })

  it('offers the keystroke hint only in the lane the keystroke would act on', () => {
    // New Lane keeps focus on the SOURCE lane, and ⌥↓ acts on
    // `tiled.focusedLane` — so advertising it inside the unfocused new lane
    // would tell the user to press a key that yanks the agent they were
    // working with and leaves this lane empty.
    const { getAllByTestId } = renderLayout({
      lanes: [
        { selectedSessionId: 'a1' as SessionId },
        { userEmptied: true },
        { userEmptied: true },
      ],
      focusedLane: 2,
    })

    const empties = getAllByTestId('lane-empty')
    expect(empties).toHaveLength(2)
    expect(empties[0].getAttribute('data-hint')).toBe('')
    expect(empties[1].getAttribute('data-hint')).toContain('⌥↓')
  })

  it('heals again once the user has filled the lane and that agent later exits', () => {
    // The other half of the flag's invariant, and the one that was broken in
    // review round 1: `userEmptied` must be dropped the moment a session is
    // written into the lane. It was only stripped in setTiledLaneSession, while
    // the ORDINARY way to fill a fresh empty lane goes through
    // applyDispatchSpawnFocus or the A2! index path — both of which spread the
    // lane and kept the flag. The lane then rendered fine, but when its agent
    // exited it became a hole the healer skipped forever, durably, because the
    // flag round-trips through workspace.json.
    //
    // Driven through the real reducers rather than a hand-built lane, so it
    // fails if any writer stops using withLaneSession.
    const filled = withLaneSession({ userEmptied: true }, 'a2' as SessionId)
    expect(filled).toEqual({ selectedSessionId: 'a2' })

    const afterExit = clearTiledLaneSessions(
      { scope: 'project', tiled: { lanes: [{ selectedSessionId: 'a1' as SessionId }, filled], focusedLane: 0 } },
      'a2' as SessionId,
    )
    const lanes = afterExit?.tiled?.lanes ?? []
    expect(lanes[1]).not.toHaveProperty('userEmptied')

    // Heals: the lane is filled from the index again. Which agent it picks is
    // the healer's existing first-unclaimed rule (a2 here, since this fixture
    // still lists it) — the contract under test is that lane 1 is filled AT
    // ALL, which it would not be if the flag had survived being filled.
    const { setTiledLaneSession } = renderLayout({ lanes, focusedLane: 0 })
    expect(setTiledLaneSession).toHaveBeenCalledWith(1, 'a2')
  })

  it('does not persist a dead slot when the autosave prune blanks a filled lane', () => {
    // keepTiledLaneSessions is the AUTOSAVE boundary, so a leak here is worse
    // than the one at clearTiledLaneSessions: the stale flag would be written
    // into workspace.json and the lane would come back a permanent hole after
    // a restart, healing never again.
    const filled = withLaneSession({ userEmptied: true }, 'a2' as SessionId)
    const pruned = keepTiledLaneSessions(
      { scope: 'project', tiled: { lanes: [{ selectedSessionId: 'a1' as SessionId }, filled], focusedLane: 0 } },
      new Set(['a1' as SessionId]),
    )
    const lanes = pruned?.tiled?.lanes ?? []
    expect(lanes[1]).not.toHaveProperty('userEmptied')

    const { setTiledLaneSession } = renderLayout({ lanes, focusedLane: 0 })
    expect(setTiledLaneSession).toHaveBeenCalledWith(1, 'a2')
  })

  it('leaves a never-filled deliberate lane alone through both blanking paths', () => {
    // The other side of withLaneCleared: neither helper touches a lane that has
    // no selectedSessionId, so a lane the user emptied and never filled keeps
    // its flag. If this ever fails, the flag is being cleared too eagerly and
    // New Lane silently goes back to auto-filling.
    const deliberate = { userEmptied: true } as const
    const tiled = { lanes: [{ selectedSessionId: 'a1' as SessionId }, deliberate], focusedLane: 0 }

    expect(clearTiledLaneSessions({ scope: 'project', tiled }, 'a1' as SessionId)
      ?.tiled?.lanes[1]).toEqual({ userEmptied: true })
    expect(keepTiledLaneSessions({ scope: 'project', tiled }, new Set<SessionId>())
      ?.tiled?.lanes[1]).toEqual({ userEmptied: true })
  })
})
