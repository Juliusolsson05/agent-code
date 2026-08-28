import { describe, expect, it } from 'vitest'

import {
  buildVisibleDispatchRows,
  dispatchSessionIdsForTab,
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

describe('Dispatch terminal placement (#671)', () => {
  // The bug: Dispatch terminals used to be inserted into the owning tab's GRID
  // tree while Dispatch agents became detached rows, and buildDispatchGroups
  // emits every project group as [...grid, ...detached]. That made a terminal
  // sort above every agent no matter when it was created — the "terminal is
  // pinned to the top of the list" symptom. These tests pin the ordering
  // contract itself, because target resolution being right is not what the
  // user was complaining about.
  //
  // The fixture mirrors what the merged splitFocused branch writes: a terminal
  // filed as a detached dispatch row with the newest detachedAt.
  function withDispatchSessions(): WorkspaceState {
    const state = makeState({ scope: 'project', focusedSessionId: 'a1' })
    state.activeTabId = 'tabA'
    state.sessions.a2 = { cwd: '/work/project-a', kind: 'claude' }
    state.sessions.a3 = { cwd: '/work/project-a', kind: 'codex' }
    state.detachedSessions.a2 = {
      sessionId: 'a2',
      surface: 'dispatch',
      projectTabId: 'tabA',
      projectTabTitle: 'project-a',
      projectTabIndex: 0,
      detachedAt: 100,
    }
    state.detachedSessions.a3 = {
      sessionId: 'a3',
      surface: 'dispatch',
      projectTabId: 'tabA',
      projectTabTitle: 'project-a',
      projectTabIndex: 0,
      detachedAt: 200,
    }
    return state
  }

  it('a Dispatch-created terminal sorts after the agents, in creation order', () => {
    const state = withDispatchSessions()
    state.sessions.aTerm = { cwd: '/work/project-a', kind: 'terminal' }
    state.detachedSessions.aTerm = {
      sessionId: 'aTerm',
      surface: 'dispatch',
      projectTabId: 'tabA',
      projectTabTitle: 'project-a',
      projectTabIndex: 0,
      // Newest: created after both agents.
      detachedAt: 300,
    }

    expect(buildVisibleDispatchRows(state).map(row => row.sessionId)).toEqual([
      'a1',
      'a2',
      'a3',
      'aTerm',
    ])
  })

  it('regression: a terminal inserted as a grid leaf pins itself above every agent', () => {
    // The pre-fix shape, kept as an executable statement of WHY the flow was
    // merged. If someone reintroduces a grid insert for Dispatch terminals,
    // the test above fails and this one explains what they reintroduced.
    const state = withDispatchSessions()
    state.sessions.aTerm = { cwd: '/work/project-a', kind: 'terminal' }
    state.tabs[0] = {
      ...state.tabs[0]!,
      root: {
        type: 'split',
        direction: 'vertical',
        ratio: 0.5,
        a: leaf('aTerm'),
        b: leaf('a1'),
      },
    }

    expect(buildVisibleDispatchRows(state).map(row => row.sessionId)).toEqual([
      'aTerm',
      'a1',
      'a2',
      'a3',
    ])
  })

  it('resolves a terminal target from the focused lane, not the stale active tab (#366)', () => {
    // resolveDispatchTerminalSplitTarget used to own this invariant with its
    // own grid-anchor resolution. Terminals now share resolveDispatchSpawnTarget
    // with agents, so the #366 guarantee has to be proven on that path: the
    // detached record must be filed under the FOCUSED LANE's project even when
    // activeTabId and the classic focus both still point at project A.
    const state = makeState({
      scope: 'global',
      focusedSessionId: 'a1',
      tiled: {
        focusedLane: 1,
        lanes: [{ selectedSessionId: 'a1' }, { selectedSessionId: 'b1' }],
      },
    })

    expect(resolveDispatchSpawnTarget(state)).toEqual({
      tabId: 'tabB',
      cwdSessionId: 'b1',
      laneIndex: 1,
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
