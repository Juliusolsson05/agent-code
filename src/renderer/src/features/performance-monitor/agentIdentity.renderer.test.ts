import { describe, expect, it } from 'vitest'
import { resolveAgentPaneLabel } from '@renderer/workspace/tile-tree/paneLabels'
import type { WorkspaceState } from '@renderer/workspace/types'
import { oneLaneStage } from '@renderer/workspace/testing/stageFixtures'
import { buildAgentIdentityIndex } from './agentIdentity'

// The v3 stage shape (#992): projects are tabs, a session belongs to a
// project through its own projectId row, and the stage is always present.
// This mirrors paneLabels.test.ts's fixture on purpose. The monitor's contract
// is "the label shown IS the label that navigates", so both suites must
// describe the same workspace.
function makeState(): WorkspaceState {
  return {
    tabs: [
      { id: 'tab-a', title: 'alpha' },
      { id: 'tab-b', title: 'beta' },
    ],
    activeTabId: 'tab-a',
    stage: oneLaneStage('agent-a'),
    sessions: {
      terminal: { cwd: '/work/alpha', kind: 'terminal', projectId: 'tab-a', joinedAt: 0 },
      'agent-a': { cwd: '/work/alpha', kind: 'codex', title: 'Leaky agent', projectId: 'tab-a', joinedAt: 1 },
      'agent-b': { cwd: '/work/beta', kind: 'claude', projectId: 'tab-b', joinedAt: 0 },
      pooled: { cwd: '/work/alpha/background', kind: 'opencode', projectId: 'tab-a', joinedAt: 10 },
      // A row whose project no longer exists: nothing places it in this window.
      orphan: { cwd: '/work/elsewhere', kind: 'claude', projectId: 'gone', joinedAt: 0 },
    },
    pinnedSessionIds: [],
  }
}

describe('monitor agent identities', () => {
  it('labels every placed session exactly as the workspace resolves that label', () => {
    const state = makeState()
    const index = buildAgentIdentityIndex(state)
    expect(index.get('agent-a')).toMatchObject({ sessionId: 'agent-a', title: 'Leaky agent', tabTitle: 'alpha' })
    for (const id of ['terminal', 'agent-a', 'agent-b', 'pooled']) expect(index.get(id)?.label).toBeTruthy()
    // The monitor must never show a label that navigates somewhere else.
    for (const identity of index.values()) {
      if (identity.label) expect(resolveAgentPaneLabel(state, identity.label)?.sessionId).toBe(identity.sessionId)
    }
  })

  it('names a session this window does not place without inventing a label', () => {
    expect(buildAgentIdentityIndex(makeState()).get('orphan')).toEqual({ sessionId: 'orphan', label: null, title: 'elsewhere', tabTitle: null })
  })
})
