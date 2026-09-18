import { expect, it } from 'vitest'

import { emptyRuntime } from '@renderer/session-runtime/state'
import type { WorkspaceState } from '@renderer/workspace/types'
import { buildAgentStatusModel } from './agentStatusModel'
import { oneLaneStage } from '@renderer/workspace/testing/stageFixtures'

it('describes a terminal with the session facts that apply to it (#865)', () => {
  const state = {
    tabs: [{ id: 'tab', title: 'project' }],
    activeTabId: 'tab', stage: oneLaneStage('shell'), 
    sessions: { shell: { cwd: '/work/api', kind: 'terminal', title: 'dev server', projectId: 'tab', joinedAt: 0 } },
      pinnedSessionIds: ['shell'],
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
