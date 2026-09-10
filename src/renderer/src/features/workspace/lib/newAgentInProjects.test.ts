import { describe, expect, it } from 'vitest'

import { buildNewAgentInModel } from '@renderer/features/workspace/lib/newAgentInProjects'
import type { DispatchModeState, TileNode, WorkspaceState } from '@renderer/workspace/types'

// Three projects, each with one grid agent, so labels A/B/C are all in play and
// a filtered list can prove it keeps the GLOBAL letter rather than re-lettering.
function leaf(sessionId: string): TileNode {
  return { type: 'leaf', sessionId }
}

function makeState(dispatchMode: DispatchModeState | null): WorkspaceState {
  return {
    tabs: [
      { id: 'tabA', title: 'project-a', root: leaf('a1'), focusedSessionId: 'a1' },
      { id: 'tabB', title: 'project-b', root: leaf('b1'), focusedSessionId: 'b1' },
      { id: 'tabC', title: 'project-c', root: leaf('c1'), focusedSessionId: 'c1' },
    ],
    activeTabId: 'tabA',
    dispatchMode,
    sessions: {
      a1: { cwd: '/work/project-a', kind: 'claude' },
      b1: { cwd: '/work/project-b', kind: 'codex' },
      c1: { cwd: '/work/project-c', kind: 'claude' },
    },
    detachedSessions: {},
    buried: [],
    pinnedSessionIds: [],
  }
}

/** Grid Dispatch with two rows of two lanes; lane 2 (row 1) focused and empty. */
function gridWithFocusedEmptyLane(rowOneProjects?: string[]): DispatchModeState {
  return {
    scope: 'global',
    focusedSessionId: 'a1',
    tiled: {
      focusedLane: 2,
      lanes: [{ selectedSessionId: 'a1' }, {}, {}, {}],
      rows: [
        { length: 2 },
        rowOneProjects ? { length: 2, projectTabIds: rowOneProjects } : { length: 2 },
      ],
    },
  }
}

describe('buildNewAgentInModel', () => {
  it('offers every project in tab order with the Dispatch letter labels when the row is unbound', () => {
    const model = buildNewAgentInModel(makeState(gridWithFocusedEmptyLane()))

    expect(model.projects.map(p => [p.tabId, p.label, p.title])).toEqual([
      ['tabA', 'A', 'project-a'],
      ['tabB', 'B', 'project-b'],
      ['tabC', 'C', 'project-c'],
    ])
  })

  it('offers only the focused row s bound projects, keeping their global letters', () => {
    // Bound to C then B: the list still follows TAB order and still says "C",
    // because the letter is the name Dispatch uses for that project everywhere.
    const model = buildNewAgentInModel(makeState(gridWithFocusedEmptyLane(['tabC', 'tabB'])))

    expect(model.projects.map(p => [p.tabId, p.label])).toEqual([
      ['tabB', 'B'],
      ['tabC', 'C'],
    ])
  })

  it('anchors a project on its first session with a directory, grid leaf before detached rows', () => {
    const state = makeState(gridWithFocusedEmptyLane())
    state.sessions.b2 = { cwd: '/work/project-b/.worktrees/task', kind: 'codex' }
    state.detachedSessions.b2 = {
      sessionId: 'b2',
      surface: 'dispatch',
      projectTabId: 'tabB',
      projectTabTitle: 'project-b',
      projectTabIndex: 1,
      detachedAt: 10,
    }

    const projectB = buildNewAgentInModel(state).projects.find(p => p.tabId === 'tabB')

    // The grid leaf is the project's own directory; the detached worktree
    // agent is only the fallback. Same order the Dispatch header "+" uses.
    expect(projectB).toMatchObject({ anchorSessionId: 'b1', disabledReason: null })
  })

  it('falls back to a detached row when the grid leaf has no live session behind it', () => {
    const state = makeState(gridWithFocusedEmptyLane())
    delete state.sessions.b1
    state.sessions.b2 = { cwd: '/work/project-b', kind: 'codex' }
    state.detachedSessions.b2 = {
      sessionId: 'b2',
      surface: 'dispatch',
      projectTabId: 'tabB',
      projectTabTitle: 'project-b',
      projectTabIndex: 1,
      detachedAt: 10,
    }

    const projectB = buildNewAgentInModel(state).projects.find(p => p.tabId === 'tabB')

    expect(projectB).toMatchObject({ anchorSessionId: 'b2', disabledReason: null })
  })

  it('lists a project with no session to borrow a directory from as disabled, with the reason', () => {
    const state = makeState(gridWithFocusedEmptyLane())
    delete state.sessions.c1

    const projectC = buildNewAgentInModel(state).projects.find(p => p.tabId === 'tabC')

    expect(projectC?.anchorSessionId).toBeNull()
    expect(projectC?.disabledReason).toMatch(/no agent/i)
  })

  it('first highlights the project plain New Agent would have used', () => {
    // Classic focus b1 + unbound empty lane => the spawn resolver picks tabB.
    const dispatchMode = gridWithFocusedEmptyLane()
    dispatchMode.focusedSessionId = 'b1'

    expect(buildNewAgentInModel(makeState(dispatchMode)).initialTabId).toBe('tabB')
  })

  it('first highlights the first enabled project when the spawn target is not on offer', () => {
    // A row bound to C whose focused lane still shows A's agent (binding
    // filters, it never evicts), so plain New Agent would target A — which
    // this row does not offer.
    const dispatchMode = gridWithFocusedEmptyLane(['tabC'])
    dispatchMode.tiled!.lanes[2] = { selectedSessionId: 'a1' }

    expect(buildNewAgentInModel(makeState(dispatchMode)).initialTabId).toBe('tabC')
  })

  it('never highlights a disabled project', () => {
    // b1 still exists (so the spawn resolver still targets tabB) but has no
    // directory, so tabB cannot be anchored. Active tab is C so the expected A
    // can only come from the "first enabled project" rule, not from activeTabId.
    const dispatchMode = gridWithFocusedEmptyLane()
    dispatchMode.focusedSessionId = 'b1'
    const state = makeState(dispatchMode)
    state.activeTabId = 'tabC'
    state.sessions.b1 = { cwd: '', kind: 'codex' }

    expect(buildNewAgentInModel(state).initialTabId).toBe('tabA')
  })
})
