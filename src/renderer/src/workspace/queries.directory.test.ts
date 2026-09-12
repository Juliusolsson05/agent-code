import { describe, expect, it } from 'vitest'

import { findTabsHoldingDirectory } from '@renderer/workspace/queries'
import type { WorkspaceState } from '@renderer/workspace/types'

// The rule ⌘T and the operator's projects.open now share (#913).
const state: WorkspaceState = {
  tabs: [
    { id: 'tab-a', title: 'agent-code', focusedSessionId: 'a', root: { type: 'leaf', sessionId: 'a' } },
    { id: 'tab-b', title: 'startup', focusedSessionId: 'b', root: { type: 'leaf', sessionId: 'b' } },
    { id: 'tab-c', title: 'agent-code', focusedSessionId: 'c', root: { type: 'leaf', sessionId: 'c' } },
  ],
  activeTabId: 'tab-a',
  dispatchMode: null,
  sessions: {
    a: { cwd: '/dev/agent-code', kind: 'claude' },
    b: { cwd: '/dev/startup', kind: 'codex' },
    c: { cwd: '/dev/agent-code/.worktrees/grok', kind: 'claude' },
    parked: { cwd: '/dev/agent-code', kind: 'codex' },
  },
  detachedSessions: {
    parked: { sessionId: 'parked', surface: 'dispatch', projectTabId: 'tab-c', projectTabTitle: 'agent-code', projectTabIndex: 2, detachedAt: 1 },
  },
  buried: [],
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
