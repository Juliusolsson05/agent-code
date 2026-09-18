import { describe, expect, it } from 'vitest'

import {
  promptTemplateComposerSessionIdForState,
  promptTemplateTargetSessionIdForState,
} from '@renderer/features/prompt-templates/targetSession'
import type { WorkspaceState } from '@renderer/workspace/types'
import { oneLaneStage } from '@renderer/workspace/testing/stageFixtures'

function stateWithFocusedSession(kind: 'claude' | 'terminal' | 'extension-view'): WorkspaceState {
  return {
    tabs: [{
      id: 'tab-1',
      title: 'Project',
    }],
    activeTabId: 'tab-1',
    stage: oneLaneStage('session-1'),
    sessions: { 'session-1': { cwd: '/project', kind, projectId: 'tab-1', joinedAt: 0 } },
    pinnedSessionIds: [],
  }
}

describe('promptTemplateTargetSessionIdForState', () => {
  it('never offers delivery or composer operations to a processless extension', () => {
    const state = stateWithFocusedSession('extension-view')
    expect(promptTemplateTargetSessionIdForState(state)).toBeNull()
    expect(promptTemplateComposerSessionIdForState(state)).toBeNull()
  })

  it('accepts agent panes and terminal panes (bracket-paste insertion, #830)', () => {
    expect(promptTemplateTargetSessionIdForState(stateWithFocusedSession('claude')))
      .toBe('session-1')
    // Terminals are valid targets: deliverTextToSession routes them to a
    // bracketed paste over sendInput instead of a composer draft edit.
    expect(promptTemplateTargetSessionIdForState(stateWithFocusedSession('terminal')))
      .toBe('session-1')
  })

  it('restricts composer-draft commands to agent panes', () => {
    expect(promptTemplateComposerSessionIdForState(stateWithFocusedSession('claude')))
      .toBe('session-1')
    expect(promptTemplateComposerSessionIdForState(stateWithFocusedSession('terminal')))
      .toBeNull()
  })

  it('rejects an empty focused lane instead of falling back to another lane s agent', () => {
    const state = stateWithFocusedSession('claude')
    state.stage = { focusedLane: 1, lanes: [{ selectedSessionId: 'session-1' }, {}] }

    expect(promptTemplateTargetSessionIdForState(state)).toBeNull()
  })
})
