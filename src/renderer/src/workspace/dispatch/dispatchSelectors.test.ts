import { describe, expect, it } from 'vitest'

import { resolveDispatchSpawnTarget } from '@renderer/workspace/dispatch/dispatchSelectors'
import { resolveDispatchAttachTarget } from '@renderer/workspace/dispatch/dispatchTarget'
import { nextTiledRowIndex } from '@renderer/workspace/dispatch/tiledDispatchSelectors'
import { commandTargetSessionIdForState } from '@renderer/workspace/hook/selectors/commandTargetSessionId'
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

describe('strict Dispatch command target', () => {
  it('Tiled Dispatch: follows the focused lane row', () => {
    const state = makeState({
      scope: 'global',
      focusedSessionId: 'a1',
      tiled: {
        focusedLane: 1,
        lanes: [{ selectedSessionId: 'a1' }, { selectedSessionId: 'b1' }],
      },
    })

    expect(commandTargetSessionIdForState(state)).toBe('b1')
  })

  it('Tiled Dispatch: empty focused lane does not fall back to classic focus', () => {
    const state = makeState({
      scope: 'global',
      focusedSessionId: 'b1',
      tiled: {
        focusedLane: 1,
        lanes: [{ selectedSessionId: 'a1' }, {}],
      },
    })

    expect(commandTargetSessionIdForState(state)).toBeNull()
  })

  it('Tiled Dispatch: stale focused lane does not fall back to the first visible row', () => {
    const state = makeState({
      scope: 'global',
      focusedSessionId: 'b1',
      tiled: {
        focusedLane: 1,
        lanes: [{ selectedSessionId: 'a1' }, { selectedSessionId: 'missing' }],
      },
    })

    expect(commandTargetSessionIdForState(state)).toBeNull()
  })

  it('classic Dispatch keeps row fallback behavior for stale focus', () => {
    const state = makeState({ scope: 'global', focusedSessionId: 'missing' })

    expect(commandTargetSessionIdForState(state)).toBe('a1')
  })
})

describe('resolveDispatchAttachTarget', () => {
  it('captures the visible row tab instead of stale activeTabId', () => {
    const state = makeState({
      scope: 'global',
      focusedSessionId: 'a1',
      tiled: {
        focusedLane: 1,
        lanes: [{ selectedSessionId: 'a1' }, { selectedSessionId: 'b2' }],
      },
    })
    state.sessions.b2 = { cwd: '/work/project-b', kind: 'claude' }
    state.detachedSessions = {
      b2: {
        sessionId: 'b2',
        surface: 'dispatch',
        projectTabId: 'tabB',
        projectTabTitle: 'project-b',
        projectTabIndex: 1,
        detachedAt: 10,
      },
    }

    expect(resolveDispatchAttachTarget(state)).toEqual({
      sessionId: 'b2',
      targetTabId: 'tabB',
    })
  })

  it('returns null for an unresolved focused tiled lane', () => {
    const state = makeState({
      scope: 'global',
      focusedSessionId: 'a1',
      tiled: {
        focusedLane: 1,
        lanes: [{ selectedSessionId: 'a1' }, {}],
      },
    })

    expect(resolveDispatchAttachTarget(state)).toBeNull()
  })
})

describe('nextTiledRowIndex', () => {
  it('moves down from no selection to the first row', () => {
    expect(nextTiledRowIndex(-1, 1, 4)).toBe(0)
  })

  it('moves up from no selection to the last row', () => {
    expect(nextTiledRowIndex(-1, -1, 4)).toBe(3)
  })

  it('wraps valid row movement in both directions', () => {
    expect(nextTiledRowIndex(0, -1, 4)).toBe(3)
    expect(nextTiledRowIndex(3, 1, 4)).toBe(0)
  })
})
