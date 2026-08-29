import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DispatchLayout } from '@renderer/workspace/dispatch/DispatchLayout'
import { insertLaneRightIntoTiled } from '@renderer/workspace/dispatch/tiledDispatchSelectors'
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
})
