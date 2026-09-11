import { expect, it } from 'vitest'

import { emptyRuntime } from '@renderer/session-runtime/state'
import type { WorkspaceState } from '@renderer/workspace/types'
import { buildAgentStatusModel } from './agentStatusModel'

it('describes a terminal with the session facts that apply to it (#865)', () => {
  const state = {
    tabs: [{ id: 'tab', title: 'project', root: { type: 'leaf', sessionId: 'shell' }, focusedSessionId: 'shell' }],
    activeTabId: 'tab', dispatchMode: null, gridRelatedSelections: {},
    sessions: { shell: { cwd: '/work/api', kind: 'terminal', title: 'dev server' } },
    detachedSessions: {}, buried: [], pinnedSessionIds: ['shell'],
  } as unknown as WorkspaceState
  const runtime = { ...emptyRuntime(), sessionStatus: 'running' as const, activityStatus: 'npm' }
  expect(buildAgentStatusModel(state, runtime, 'shell')).toMatchObject({
    kind: 'terminal',
    title: 'dev server',
    providerSessionState: 'none',
    runtime: { sessionStatus: 'running', activityStatus: 'npm', pendingCompaction: null },
    placement: { pinned: true },
    mcp: { builtInDomains: [] },
  })
})
