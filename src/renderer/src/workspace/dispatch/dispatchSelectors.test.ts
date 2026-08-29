import { describe, expect, it } from 'vitest'

import {
  dispatchSessionIdsForTab,
  resolveDispatchTerminalSplitTarget,
  resolveDispatchSpawnTarget,
} from '@renderer/workspace/dispatch/dispatchSelectors'
import { resolveDispatchAttachTarget } from '@renderer/workspace/dispatch/dispatchTarget'
import { nextTiledRowIndex } from '@renderer/workspace/dispatch/tiledDispatchSelectors'
import { resolveFocusSurfaceTarget } from '@renderer/workspace/hook/actions/focusSurfaceTarget'
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

describe('resolveDispatchTerminalSplitTarget', () => {
  it('Tiled Dispatch: uses the focused lane project for terminal cwd and grid insertion (#366)', () => {
    const state = makeState({
      scope: 'global',
      focusedSessionId: 'a1',
      tiled: {
        focusedLane: 1,
        lanes: [{ selectedSessionId: 'a1' }, { selectedSessionId: 'b1' }],
      },
    })

    expect(resolveDispatchTerminalSplitTarget(state)).toEqual({
      tabId: 'tabB',
      cwdSessionId: 'b1',
      laneIndex: 1,
      splitAnchorSessionId: 'b1',
    })
  })

  it('Tiled Dispatch: detached focused lane keeps cwd but splits a real leaf in the same tab', () => {
    const state = makeState({
      scope: 'global',
      focusedSessionId: 'a1',
      tiled: {
        focusedLane: 1,
        lanes: [{ selectedSessionId: 'a1' }, { selectedSessionId: 'b2' }],
      },
    })
    state.sessions.b2 = { cwd: '/work/project-b/subtask', kind: 'codex' }
    state.detachedSessions.b2 = {
      sessionId: 'b2',
      surface: 'dispatch',
      projectTabId: 'tabB',
      projectTabTitle: 'project-b',
      projectTabIndex: 1,
      detachedAt: 10,
    }

    expect(resolveDispatchTerminalSplitTarget(state)).toEqual({
      tabId: 'tabB',
      cwdSessionId: 'b2',
      laneIndex: 1,
      splitAnchorSessionId: 'b1',
    })
  })
})

describe('dispatchSessionIdsForTab', () => {
  it('includes pinned rows owned by the tab even though project groups strip them', () => {
    const state = makeState({ scope: 'global', focusedSessionId: 'b1' })
    state.pinnedSessionIds = ['b1']

    expect(dispatchSessionIdsForTab(state, 'tabB')).toEqual(['b1'])
  })

  it('uses visible Dispatch row order, with pinned rows before grouped rows for the same tab', () => {
    const state = makeState({ scope: 'global', focusedSessionId: 'b2' })
    state.tabs[1] = {
      ...state.tabs[1]!,
      root: {
        type: 'split',
        direction: 'vertical',
        ratio: 0.5,
        a: leaf('b1'),
        b: leaf('b2'),
      },
    }
    state.sessions.b2 = { cwd: '/work/project-b', kind: 'codex' }
    state.pinnedSessionIds = ['b2']

    expect(dispatchSessionIdsForTab(state, 'tabB')).toEqual(['b2', 'b1'])
  })
})

describe('resolveFocusSurfaceTarget', () => {
  it('returns the focused tiled lane session and its owner tab, not the stale active tab', () => {
    const state = makeState({
      scope: 'global',
      focusedSessionId: 'a1',
      tiled: {
        focusedLane: 1,
        lanes: [{ selectedSessionId: 'a1' }, { selectedSessionId: 'b1' }],
      },
    })

    expect(resolveFocusSurfaceTarget(state)).toEqual({
      tabId: 'tabB',
      sessionId: 'b1',
    })
  })

  it('returns null when the focused tiled lane has no strict command target', () => {
    const state = makeState({
      scope: 'global',
      focusedSessionId: 'b1',
      tiled: {
        focusedLane: 1,
        lanes: [{ selectedSessionId: 'a1' }, {}],
      },
    })

    expect(resolveFocusSurfaceTarget(state)).toBeNull()
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
  it('lands on the first row from no selection, whichever direction is pressed', () => {
    // An empty lane behaves as though it already sat at a1, so the first press
    // commits that position rather than moving off it. Direction must not decide
    // whether a fresh lane opens at the top or the bottom of the index (#673).
    expect(nextTiledRowIndex(-1, 1, 4)).toBe(0)
    expect(nextTiledRowIndex(-1, -1, 4)).toBe(0)
  })

  it('wraps valid row movement in both directions', () => {
    expect(nextTiledRowIndex(0, -1, 4)).toBe(3)
    expect(nextTiledRowIndex(3, 1, 4)).toBe(0)
  })

  it('advances normally on the press after an empty lane commits a1', () => {
    // The sequence is what the user actually feels, and it is the half a
    // single-call assertion cannot cover: the first press must SELECT a1 and
    // the second must MOVE. A regression that made the empty branch sticky
    // (always returning 0) would pass the case above and strand the user on a1.
    // moveTiledLaneSelection does not literally feed the result back in: it
    // writes the session id, then re-derives the index with
    // rows.findIndex(...) on the next press. That is equivalent only because
    // buildVisibleDispatchRows' order is stable between the two presses, which
    // is the assumption this sequence encodes.
    const down = nextTiledRowIndex(-1, 1, 4)
    expect(down).toBe(0)
    expect(nextTiledRowIndex(down, 1, 4)).toBe(1)

    const up = nextTiledRowIndex(-1, -1, 4)
    expect(up).toBe(0)
    expect(nextTiledRowIndex(up, -1, 4)).toBe(3)
  })
})
