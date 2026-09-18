import { describe, expect, it } from 'vitest'

import { findTabsHoldingDirectory } from '@renderer/workspace/queries'
import type { WorkspaceState } from '@renderer/workspace/types'
import { oneLaneStage } from '@renderer/workspace/testing/stageFixtures'

// The rule ⌘T and the operator's projects.open now share (#913).
const state: WorkspaceState = {
  tabs: [
    { id: 'tab-a', title: 'agent-code' },
    { id: 'tab-b', title: 'startup' },
    { id: 'tab-c', title: 'agent-code' },
  ],
  activeTabId: 'tab-a',
  stage: oneLaneStage('a'),
  sessions: {
    a: { cwd: '/dev/agent-code', kind: 'claude', projectId: 'tab-a', joinedAt: 0 },
    b: { cwd: '/dev/startup', kind: 'codex', projectId: 'tab-b', joinedAt: 0 },
    c: { cwd: '/dev/agent-code/.worktrees/grok', kind: 'claude', projectId: 'tab-c', joinedAt: 0 },
    parked: { cwd: '/dev/agent-code', kind: 'codex', projectId: 'tab-c', joinedAt: 1 },
  },
  pinnedSessionIds: [],
}

describe('findTabsHoldingDirectory', () => {
  it('matches the exact directory through grid and detached sessions, in tab order', () => {
    expect(findTabsHoldingDirectory(state, '/dev/agent-code').map(tab => tab.id)).toEqual(['tab-a', 'tab-c'])
    expect(findTabsHoldingDirectory(state, '/dev/startup').map(tab => tab.id)).toEqual(['tab-b'])
  })

  it('treats a worktree as a different directory', () => {
    expect(findTabsHoldingDirectory(state, '/dev/agent-code/.worktrees/grok').map(tab => tab.id)).toEqual(['tab-c'])
    expect(findTabsHoldingDirectory(state, '/dev/agent-code/.worktrees/other')).toEqual([])
  })
})
