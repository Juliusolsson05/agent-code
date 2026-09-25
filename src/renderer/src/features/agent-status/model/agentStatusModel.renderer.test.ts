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

it('reports the worktree the pane badge shows, so its details are reachable by keyboard (K2-13)', async () => {
  // The badge's branch and path were a hover title on a non-focusable chip.
  // Agent Status (opened by command) now shows the SAME worktree, chosen by
  // the badge's own rule: the active worktree over the primary.
  const { identityFields } = await import('./formatAgentStatus')
  const state = {
    tabs: [{ id: 'tab', title: 'project' }],
    activeTabId: 'tab', stage: oneLaneStage('agent'),
    sessions: { agent: { cwd: '/work/repo', kind: 'claude', title: 'fixer', projectId: 'tab', joinedAt: 0 } },
    pinnedSessionIds: [],
  } as unknown as WorkspaceState
  const primary = { worktreePath: '/work/repo', branch: 'main', repoRoot: '/work/repo', confidence: 'high', source: 'session-cwd', updatedAt: 1 }
  const active = { ...primary, worktreePath: '/work/repo/.worktrees/fix', branch: 'fix/thing', source: 'worktree-enter', updatedAt: 2 }
  const runtime = {
    ...emptyRuntime(),
    workContext: primary,
    workActivity: { active, touched: {} },
  } as never
  const model = buildAgentStatusModel(state, runtime, 'agent')
  expect(model?.worktree).toEqual({ branch: 'fix/thing', path: '/work/repo/.worktrees/fix', active: true })
  expect(identityFields(model!)).toContainEqual({ label: 'Worktree', value: 'fix/thing · /work/repo/.worktrees/fix · active' })
})
