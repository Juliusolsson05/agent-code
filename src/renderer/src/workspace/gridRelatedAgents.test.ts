import { describe, expect, it } from 'vitest'

import {
  buildGridRelatedAgentTabs,
  selectedGridRelatedSessionId,
} from '@renderer/workspace/gridRelatedAgents'
import type { TileNode, WorkspaceState } from '@renderer/workspace/types'
import { commandTargetSessionIdForState } from '@renderer/workspace/hook/selectors/commandTargetSessionId'
import { oneLaneStage } from '@renderer/workspace/testing/stageFixtures'

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
    stage: oneLaneStage('parent'),
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

  // "routes grid command targeting to the selected detached related child"
  // lived here until #992. In the tile grid a pane could show a related child
  // in place of its owner (a mini-tab strip), and commands followed what was
  // visible. Lanes never render that strip, so a related selection is not
  // visible anywhere and must not redirect a command. The surviving case
  // below is the rule for the one layout: the lane's occupant is the target.
  // (`gridRelatedSelections` itself is re-based on pool membership, or
  // deleted, in stage 3b-ii.)
  it('never lets a related selection override the focused lane s occupant', () => {
    const state = makeState()
    state.gridRelatedSelections = { parent: 'linked' }
    state.stage = { lanes: [{ selectedSessionId: 'parent' }], rows: [{ length: 1 }], focusedLane: 0 }
    expect(commandTargetSessionIdForState(state)).toBe('parent')
  })
})
