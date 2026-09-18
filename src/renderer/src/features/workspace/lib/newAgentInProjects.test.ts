import { describe, expect, it } from 'vitest'

import { buildNewAgentInModel } from '@renderer/features/workspace/lib/newAgentInProjects'
import type { TiledDispatchState, WorkspaceState } from '@renderer/workspace/types'

// Three projects, each with one grid agent, so labels A/B/C are all in play and
// a filtered list can prove it keeps the GLOBAL letter rather than re-lettering.
function makeState(stage: TiledDispatchState): WorkspaceState {
  return {
    tabs: [
      { id: 'tabA', title: 'project-a' },
      { id: 'tabB', title: 'project-b' },
      { id: 'tabC', title: 'project-c' },
    ],
    activeTabId: 'tabA',
    stage,
    sessions: {
      a1: { cwd: '/work/project-a', kind: 'claude', projectId: 'tabA', joinedAt: 0 },
      b1: { cwd: '/work/project-b', kind: 'codex', projectId: 'tabB', joinedAt: 0 },
      c1: { cwd: '/work/project-c', kind: 'claude', projectId: 'tabC', joinedAt: 0 },
    },
    pinnedSessionIds: [],
  }
}

/** A stage with two rows of two lanes; lane 2 (row 1) focused and empty. */
function gridWithFocusedEmptyLane(rowOneProjects?: string[]): TiledDispatchState {
  return {
    focusedLane: 2,
    lanes: [{ selectedSessionId: 'a1' }, {}, {}, {}],
    rows: [
      { length: 2 },
      rowOneProjects ? { length: 2, projectTabIds: rowOneProjects } : { length: 2 },
    ],
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
    state.sessions.b2 = { cwd: '/work/project-b/.worktrees/task', kind: 'codex', projectId: 'tabB', joinedAt: 10 }

    const projectB = buildNewAgentInModel(state).projects.find(p => p.tabId === 'tabB')

    // The grid leaf is the project's own directory; the detached worktree
    // agent is only the fallback. Same order the Dispatch header "+" uses.
    expect(projectB).toMatchObject({ enabled: true, anchorSessionId: 'b1', disabledReason: null })
  })

  it('falls back to a detached row when the grid leaf has no live session behind it', () => {
    const state = makeState(gridWithFocusedEmptyLane())
    delete state.sessions.b1
    state.sessions.b2 = { cwd: '/work/project-b', kind: 'codex', projectId: 'tabB', joinedAt: 10 }

    const projectB = buildNewAgentInModel(state).projects.find(p => p.tabId === 'tabB')

    expect(projectB).toMatchObject({ anchorSessionId: 'b2', disabledReason: null })
  })

  it('lists a project with no session to borrow a directory from as disabled, with the reason', () => {
    const state = makeState(gridWithFocusedEmptyLane())
    delete state.sessions.c1

    const projectC = buildNewAgentInModel(state).projects.find(p => p.tabId === 'tabC')

    // `enabled` is the one field consumers branch on; anchor and reason follow
    // from it, so a future second disabled reason cannot leave a project that
    // the model calls disabled but the dialog can still commit.
    expect(projectC).toMatchObject({ enabled: false, anchorSessionId: null })
    expect(projectC?.disabledReason).toMatch(/no agent/i)
  })

  it('first highlights the project plain New Agent would have used', () => {
    // Active project B + unbound empty lane => the spawn resolver picks tabB.
    // (Until #992 a classic-Dispatch focus on b1 produced the same answer by
    // a different road; the active project is the only fallback now.)
    const state = makeState(gridWithFocusedEmptyLane())
    state.activeTabId = 'tabB'

    expect(buildNewAgentInModel(state).initialTabId).toBe('tabB')
  })

  it('first highlights the first enabled project when the spawn target is not on offer', () => {
    // A row bound to C whose focused lane still shows A's agent (binding
    // filters, it never evicts), so plain New Agent would target A — which
    // this row does not offer.
    const stage = gridWithFocusedEmptyLane(['tabC'])
    stage.lanes[2] = { selectedSessionId: 'a1' }

    expect(buildNewAgentInModel(makeState(stage)).initialTabId).toBe('tabC')
  })

  it('never highlights a disabled project', () => {
    // The focused lane shows b1, so the spawn resolver targets tabB — but b1
    // has no directory, so tabB cannot be anchored. Active tab is C so the
    // expected A can only come from the "first enabled project" rule, not from
    // activeTabId.
    const stage = gridWithFocusedEmptyLane()
    stage.lanes[2] = { selectedSessionId: 'b1' }
    const state = makeState(stage)
    state.activeTabId = 'tabC'
    // Spread: the row's `projectId` is what files it under tabB (#992). A bare
    // replacement un-files it, tabB becomes EMPTY rather than un-anchorable,
    // and the case stops testing the disabled-project rule at all.
    state.sessions.b1 = { ...state.sessions.b1!, cwd: '' }

    expect(buildNewAgentInModel(state).initialTabId).toBe('tabA')
  })
})
