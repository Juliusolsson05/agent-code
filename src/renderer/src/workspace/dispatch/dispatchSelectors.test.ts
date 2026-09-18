import { describe, expect, it } from 'vitest'

import {
  buildPinnedDispatchRows,
  dispatchSessionIdsForTab,
  focusedLaneBoundProjectTabIds,
  resolveDispatchSpawnTarget,
} from '@renderer/workspace/dispatch/dispatchSelectors'
import { nextTiledRowIndex } from '@renderer/workspace/dispatch/tiledDispatchSelectors'
import { resolveFocusSurfaceTarget } from '@renderer/workspace/hook/actions/focusSurfaceTarget'
import { commandTargetSessionIdForState } from '@renderer/workspace/hook/selectors/commandTargetSessionId'
import type { TileNode, TiledDispatchState, WorkspaceState } from '@renderer/workspace/types'

// Minimal two-project fixture: project A (tabA / a1) and project B (tabB / b1),
// each a single grid agent. Both projects show in every index: the layout-wide
// project/global scope these fixtures used to set died with #992.
function leaf(sessionId: string): TileNode {
  return { type: 'leaf', sessionId }
}

/** One row of one lane showing `sessionId` — the stage equivalent of "the user
 *  is commanding this agent", which a classic-Dispatch focus used to express. */
function oneLane(sessionId?: string): TiledDispatchState {
  return { lanes: [sessionId ? { selectedSessionId: sessionId } : {}], rows: [{ length: 1 }], focusedLane: 0 }
}

function makeState(stage: TiledDispatchState): WorkspaceState {
  return {
    tabs: [
      { id: 'tabA', title: 'project-a', root: leaf('a1'), focusedSessionId: 'a1' },
      { id: 'tabB', title: 'project-b', root: leaf('b1'), focusedSessionId: 'b1' },
    ],
    activeTabId: 'tabA',
    stage,
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
  it('a one-lane stage targets the project of the agent it shows', () => {
    // Was "classic Dispatch: targets the focused session's own project", with
    // `laneIndex: null` because classic Dispatch had no lanes. The same user
    // intent on the stage is one lane showing b1 — and there is always a lane
    // to place into, so the index is 0, never null.
    const state = makeState(oneLane('b1'))
    const target = resolveDispatchSpawnTarget(state)
    expect(target).toEqual({ tabId: 'tabB', cwdSessionId: 'b1', laneIndex: 0 })
  })

  it('follows the FOCUSED LANE, not the stale active tab (issue #266)', () => {
    // The regression scenario: the active tab is still A, but the user is
    // commanding lane 1 which shows
    // project B. A new agent must land in B, in lane 1 — NOT in active tab A.
    const state = makeState({
      focusedLane: 1,
      lanes: [{ selectedSessionId: 'a1' }, { selectedSessionId: 'b1' }],
    })
    const target = resolveDispatchSpawnTarget(state)
    expect(target).toEqual({ tabId: 'tabB', cwdSessionId: 'b1', laneIndex: 1 })
  })

  it('an empty focused lane falls back to the ACTIVE project but keeps the lane index', () => {
    // Until #992 the fallback was a classic-Dispatch focus (b1 => tabB), a
    // second focus truth beside the focused lane. With one focus truth the
    // honest fallback for "no agent here to take a project from" is the
    // active project — and the new agent still lands in the lane the user is
    // looking at.
    const state = makeState({
      focusedLane: 1,
      lanes: [{ selectedSessionId: 'a1' }, {}],
    })
    state.activeTabId = 'tabB'
    const target = resolveDispatchSpawnTarget(state)
    expect(target).toEqual({ tabId: 'tabB', cwdSessionId: null, laneIndex: 1 })
  })

  // "no Dispatch mode: targets the active tab" (laneIndex: null) lived here
  // until #992. A workspace without lanes can no longer be constructed.
})

describe('resolveDispatchSpawnTarget with a detached focused lane', () => {
  // WHY this case is called out separately from the tiled tests above: the
  // focused Dispatch lane normally holds a DETACHED agent, not a grid leaf, and
  // since #671 that resolver is what terminals use too. Its cwd is the one a
  // new terminal inherits, so a resolver that quietly preferred grid leaves
  // would spawn the shell in the parent repo while the user is looking at a
  // worktree agent — a wrong-directory bug with no visible symptom.
  //
  // This replaces the equivalent coverage that lived on
  // `resolveDispatchTerminalSplitTarget` before the creation flows merged.
  it('keeps the detached lane session as the cwd source, not a grid leaf in the same tab', () => {
    const state = makeState({
      focusedLane: 1,
      lanes: [{ selectedSessionId: 'a1' }, { selectedSessionId: 'b2' }],
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

    expect(resolveDispatchSpawnTarget(state)).toEqual({
      tabId: 'tabB',
      cwdSessionId: 'b2',
      laneIndex: 1,
    })
  })

// Grid Dispatch row bindings (#681). Two consumers must agree on "which
// projects may this lane hold": the spawn resolver (where plain New Agent…
// lands) and New Agent In…'s project list (#852). Both read the SAME selector,
// pinned here. The resolver's bound-row RULES (binding over the active tab,
// active tab preferred among several bound projects, first bound otherwise)
// are covered on the real persisted fixture in rowScopedRows.test.ts, which
// guarded the selector extraction — they are deliberately not restated here.
describe('focusedLaneBoundProjectTabIds', () => {
  it('returns the binding of the row that owns the focused lane', () => {
    const state = makeState({
      focusedLane: 1,
      lanes: [{ selectedSessionId: 'a1' }, {}],
      rows: [{ length: 1 }, { length: 1, projectTabIds: ['tabB'] }],
    })
    expect(focusedLaneBoundProjectTabIds(state)).toEqual(['tabB'])
  })

  it('returns nothing for an unbound row', () => {
    const unbound = makeState({
      focusedLane: 0,
      lanes: [{ selectedSessionId: 'a1' }, {}],
      rows: [{ length: 1 }, { length: 1, projectTabIds: ['tabB'] }],
    })
    expect(focusedLaneBoundProjectTabIds(unbound)).toEqual([])
    // A stage with no `rows` at all (written before the row grid) is one
    // unbound row. (Classic Dispatch and "no Dispatch" were asserted here too
    // until #992; neither can be built any more.)
    expect(focusedLaneBoundProjectTabIds(makeState({ focusedLane: 0, lanes: [{ selectedSessionId: 'a1' }] }))).toEqual([])
  })
})

describe('dispatchSessionIdsForTab', () => {
  it('includes pinned rows owned by the tab even though project groups strip them', () => {
    const state = makeState(oneLane('b1'))
    state.pinnedSessionIds = ['b1']

    expect(dispatchSessionIdsForTab(state, 'tabB')).toEqual(['b1'])
  })

  it('uses visible Dispatch row order, with pinned rows before grouped rows for the same tab', () => {
    const state = makeState(oneLane('b2'))
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
      focusedLane: 1,
      lanes: [{ selectedSessionId: 'a1' }, { selectedSessionId: 'b1' }],
    })

    expect(resolveFocusSurfaceTarget(state)).toEqual({
      tabId: 'tabB',
      sessionId: 'b1',
    })
  })

  it('returns null when the focused tiled lane has no strict command target', () => {
    const state = makeState({
      focusedLane: 1,
      lanes: [{ selectedSessionId: 'a1' }, {}],
    })

    expect(resolveFocusSurfaceTarget(state)).toBeNull()
  })
})

describe('strict Dispatch command target', () => {
  it('follows the focused lane row', () => {
    const state = makeState({
      focusedLane: 1,
      lanes: [{ selectedSessionId: 'a1' }, { selectedSessionId: 'b1' }],
    })

    expect(commandTargetSessionIdForState(state)).toBe('b1')
  })

  it('an empty focused lane has no command target, whatever the other lanes show', () => {
    const state = makeState({
      focusedLane: 1,
      lanes: [{ selectedSessionId: 'a1' }, {}],
    })

    expect(commandTargetSessionIdForState(state)).toBeNull()
  })

  it('a stale focused lane does not fall back to the first visible row', () => {
    const state = makeState({
      focusedLane: 1,
      lanes: [{ selectedSessionId: 'a1' }, { selectedSessionId: 'missing' }],
    })

    expect(commandTargetSessionIdForState(state)).toBeNull()
  })

  // "classic Dispatch keeps row fallback behavior for stale focus" lived here
  // until #992: a stale classic focus fell back to the first visible row. The
  // stage is strict everywhere — see the case above and
  // resolveFocusedCloseTarget in pane.ts for why a destructive target must
  // never be guessed.
  it('a one-lane stage naming a missing session has no command target', () => {
    expect(commandTargetSessionIdForState(makeState(oneLane('missing')))).toBeNull()
  })
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

describe('buildPinnedDispatchRows', () => {
  it('pins a terminal like any other session (#865)', () => {
    // Pins were agent-only since before terminals were Dispatch rows (#152
    // deferred them "for v1"). Since #671 a shell is a full row, and a pinned
    // dev-server shell is exactly the one-keystroke-away session pins exist for.
    const state = makeState(oneLane('a1'))
    state.sessions.shell = { cwd: '/work/project-a', kind: 'terminal' }
    state.tabs[0] = { ...state.tabs[0], root: { type: 'split', direction: 'vertical', ratio: 0.5, a: leaf('a1'), b: leaf('shell') } }
    state.pinnedSessionIds = ['shell']
    expect(buildPinnedDispatchRows(state).map(row => [row.sessionId, row.kind])).toEqual([['shell', 'terminal']])
  })
})
