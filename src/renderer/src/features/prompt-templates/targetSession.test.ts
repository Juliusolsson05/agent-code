import { describe, expect, it } from 'vitest'

import { promptTemplateTargetSessionIdForState } from '@renderer/features/prompt-templates/targetSession'
import type { WorkspaceState } from '@renderer/workspace/types'

function stateWithFocusedSession(kind: 'claude' | 'terminal'): WorkspaceState {
  return {
    tabs: [{
      id: 'tab-1',
      title: 'Project',
      root: { type: 'leaf', sessionId: 'session-1' },
      focusedSessionId: 'session-1',
    }],
    activeTabId: 'tab-1',
    dispatchMode: null,
    sessions: { 'session-1': { cwd: '/project', kind } },
    detachedSessions: {},
    buried: [],
    pinnedSessionIds: [],
  }
}

describe('promptTemplateTargetSessionIdForState', () => {
  it('offers template insertion only when the command target owns an agent composer', () => {
    expect(promptTemplateTargetSessionIdForState(stateWithFocusedSession('claude')))
      .toBe('session-1')
    expect(promptTemplateTargetSessionIdForState(stateWithFocusedSession('terminal')))
      .toBeNull()
  })

  it('rejects an empty Tiled Dispatch lane instead of falling back to hidden focus', () => {
    const state = stateWithFocusedSession('claude')
    state.dispatchMode = {
      scope: 'project',
      focusedSessionId: 'session-1',
      tiled: { focusedLane: 1, lanes: [{ selectedSessionId: 'session-1' }, {}] },
    }

    expect(promptTemplateTargetSessionIdForState(state)).toBeNull()
  })
})
