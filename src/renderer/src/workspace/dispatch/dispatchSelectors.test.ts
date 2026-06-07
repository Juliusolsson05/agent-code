import { describe, expect, it } from 'vitest'

import { resolveDispatchSpawnTarget } from '@renderer/workspace/dispatch/dispatchSelectors'
import type { DispatchModeState, TileNode, WorkspaceState } from '@renderer/workspace/types'

// Minimal two-project fixture: project A (tabA / a1) and project B (tabB / b1),
// each a single grid agent. Global scope so both tabs show in the dispatch list.
function leaf(sessionId: string): TileNode {
  return { type: 'leaf', sessionId }
}

function makeState(dispatchMode: DispatchModeState | null): WorkspaceState {
  return {
    tabs: [
      { id: 'tabA', title: 'project-a', root: leaf('a1'), focusedSessionId: 'a1' },
      { id: 'tabB', title: 'project-b', root: leaf('b1'), focusedSessionId: 'b1' },
    ],
    activeTabId: 'tabA',
    dispatchMode,
    sessions: {
      a1: { cwd: '/work/project-a', kind: 'claude' },
      b1: { cwd: '/work/project-b', kind: 'claude' },
    },
    detachedSessions: {},
    buried: [],
    pinnedSessionIds: [],
  }
}

describe('resolveDispatchSpawnTarget', () => {
  it('classic Dispatch: targets the focused session’s own project', () => {
    const state = makeState({ scope: 'global', focusedSessionId: 'b1' })
    const target = resolveDispatchSpawnTarget(state)
    expect(target).toEqual({ tabId: 'tabB', cwdSessionId: 'b1', laneIndex: null })
  })

  it('Tiled Dispatch: follows the FOCUSED LANE, not the stale active tab (issue #266)', () => {
    // The regression scenario: active tab is A and the classic focus still
    // points at A's agent, but the user is commanding lane 1 which shows
    // project B. A new agent must land in B, in lane 1 — NOT in active tab A.
    const state = makeState({
      scope: 'global',
      focusedSessionId: 'a1',
      tiled: {
        focusedLane: 1,
        lanes: [{ selectedSessionId: 'a1' }, { selectedSessionId: 'b1' }],
      },
    })
    const target = resolveDispatchSpawnTarget(state)
    expect(target).toEqual({ tabId: 'tabB', cwdSessionId: 'b1', laneIndex: 1 })
  })

  it('Tiled Dispatch: empty focused lane falls back to classic focus but keeps the lane index', () => {
    const state = makeState({
      scope: 'global',
      focusedSessionId: 'b1',
      tiled: {
        focusedLane: 1,
        lanes: [{ selectedSessionId: 'a1' }, {}],
      },
    })
    const target = resolveDispatchSpawnTarget(state)
    expect(target).toEqual({ tabId: 'tabB', cwdSessionId: 'b1', laneIndex: 1 })
  })

  it('no Dispatch mode: targets the active tab', () => {
    const target = resolveDispatchSpawnTarget(makeState(null))
    expect(target).toEqual({ tabId: 'tabA', cwdSessionId: null, laneIndex: null })
  })
})
