import { describe, expect, it } from 'vitest'
import { resolveAgentPaneLabel } from '@renderer/workspace/tile-tree/paneLabels'
import type { TileNode, WorkspaceState } from '@renderer/workspace/types'
import { buildAgentIdentityIndex } from './agentIdentity'

const leaf = (sessionId: string): TileNode => ({ type: 'leaf', sessionId })

function makeState(): WorkspaceState {
  return {
    tabs: [
      { id: 'tab-a', title: 'alpha', root: { type: 'split', direction: 'vertical', ratio: 0.5, a: leaf('a1'), b: leaf('a2') }, focusedSessionId: 'a1' },
      { id: 'tab-b', title: 'beta', root: leaf('b1'), focusedSessionId: 'b1' },
    ],
    activeTabId: 'tab-a',
    gridRelatedSelections: {},
    dispatchMode: null,
    sessions: {
      a1: { cwd: '/work/alpha/one', kind: 'claude', title: 'Leaky agent' },
      a2: { cwd: '/work/alpha/two', kind: 'codex' },
      a3: { cwd: '/work/alpha/three', kind: 'claude' },
      b1: { cwd: '/work/beta/one', kind: 'codex' },
      orphan: { cwd: '/work/elsewhere', kind: 'claude' },
    },
    detachedSessions: {
      a3: { sessionId: 'a3', surface: 'dispatch', projectTabId: 'tab-a', projectTabTitle: 'alpha', projectTabIndex: 0, detachedAt: 10 },
    },
    buried: [],
    pinnedSessionIds: [],
  }
}

describe('monitor agent identities', () => {
  it('labels every placed session exactly as the workspace resolves that label', () => {
    const state = makeState()
    const index = buildAgentIdentityIndex(state, null)
    expect(index.get('a1')).toEqual({ sessionId: 'a1', label: 'A1', title: 'Leaky agent', tabTitle: 'alpha' })
    // Detached agents keep a coordinate after the grid leaves of their tab.
    expect(index.get('a3')?.label).toBe('A3')
    expect(index.get('b1')?.label).toBe('B1')
    // The monitor must never show a label that navigates somewhere else.
    for (const identity of index.values()) {
      if (identity.label) expect(resolveAgentPaneLabel(state, identity.label)?.sessionId).toBe(identity.sessionId)
    }
  })

  it('names a session this window does not place without inventing a label', () => {
    expect(buildAgentIdentityIndex(makeState(), null).get('orphan')).toEqual({ sessionId: 'orphan', label: null, title: 'elsewhere', tabTitle: null })
  })
})
