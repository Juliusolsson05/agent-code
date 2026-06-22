import { describe, expect, it } from 'vitest'

import {
  buildGridRelatedAgentTabs,
  selectedGridRelatedSessionId,
} from '@renderer/workspace/gridRelatedAgents'
import type { TileNode, WorkspaceState } from '@renderer/workspace/types'
import { commandTargetSessionIdForState } from '@renderer/workspace/hook/selectors/commandTargetSessionId'

function leaf(sessionId: string): TileNode {
  return { type: 'leaf', sessionId }
}

function makeState(): WorkspaceState {
  return {
    tabs: [
      { id: 'tabA', title: 'project-a', root: leaf('parent'), focusedSessionId: 'parent' },
    ],
    activeTabId: 'tabA',
    gridRelatedSelections: {},
    dispatchMode: null,
    sessions: {
      parent: { cwd: '/work/project-a', kind: 'claude' },
      linked: {
        cwd: '/work/project-a',
        kind: 'claude',
        title: 'manual reviewer',
        linkedParentId: 'parent',
      },
      worker: {
        cwd: '/work/project-a',
        kind: 'codex',
        orchestrationParentId: 'parent',
        orchestrationRootId: 'parent',
        orchestrationRole: 'reviewer',
      },
      unrelated: { cwd: '/work/project-a', kind: 'claude' },
    },
    detachedSessions: {
      linked: {
        sessionId: 'linked',
        surface: 'dispatch',
        projectTabId: 'tabA',
        projectTabTitle: 'project-a',
        projectTabIndex: 0,
        detachedAt: 10,
      },
      worker: {
        sessionId: 'worker',
        surface: 'dispatch',
        projectTabId: 'tabA',
        projectTabTitle: 'project-a',
        projectTabIndex: 0,
        detachedAt: 20,
      },
      unrelated: {
        sessionId: 'unrelated',
        surface: 'dispatch',
        projectTabId: 'tabA',
        projectTabTitle: 'project-a',
        projectTabIndex: 0,
        detachedAt: 30,
      },
    },
    buried: [],
    pinnedSessionIds: [],
  }
}

describe('grid related agent tabs', () => {
  it('projects linked and orchestration children onto the parent grid pane', () => {
    const tabs = buildGridRelatedAgentTabs(makeState(), 'tabA', 'parent')
    expect(tabs.map(tab => [tab.sessionId, tab.relation, tab.label])).toEqual([
      ['parent', 'parent', 'parent'],
      ['linked', 'linked', 'link'],
      ['worker', 'orchestration', 'reviewer'],
    ])
  })

  it('falls back to the physical parent when selected child state is stale', () => {
    const state = makeState()
    state.gridRelatedSelections = { parent: 'missing-child' }
    expect(selectedGridRelatedSessionId(state, 'tabA', 'parent')).toBe('parent')
  })

  it('excludes related children that already have their own grid leaf', () => {
    const state = makeState()
    state.tabs[0] = {
      ...state.tabs[0],
      root: {
        type: 'split',
        direction: 'vertical',
        ratio: 0.5,
        a: leaf('parent'),
        b: leaf('linked'),
      },
    }
    delete state.detachedSessions.linked

    const tabs = buildGridRelatedAgentTabs(state, 'tabA', 'parent')
    expect(tabs.map(tab => tab.sessionId)).toEqual(['parent', 'worker'])
  })

  it('routes grid command targeting to the selected detached related child', () => {
    const state = makeState()
    state.gridRelatedSelections = { parent: 'linked' }
    expect(commandTargetSessionIdForState(state)).toBe('linked')
  })

  it('does not let grid related selection override Dispatch command targeting', () => {
    const state = makeState()
    state.gridRelatedSelections = { parent: 'linked' }
    state.dispatchMode = { scope: 'project', focusedSessionId: 'parent' }
    expect(commandTargetSessionIdForState(state)).toBe('parent')
  })
})
