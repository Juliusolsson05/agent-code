import assert from 'node:assert/strict'

import { buildAgentStatusModel } from '@renderer/features/agent-status/model/agentStatusModel'
import {
  formatPlacement,
  formatProviderSession,
  mcpFields,
  relationshipFields,
  runtimeFields,
} from '@renderer/features/agent-status/model/formatAgentStatus'
import type { WorkspaceState } from '@renderer/workspace/types'
import { emptyRuntime } from '@renderer/workspace/workspaceState'

const baseState: WorkspaceState = {
  activeTabId: 'tab-a',
  dispatchMode: null,
  tabs: [
    {
      id: 'tab-a',
      title: 'Project A',
      focusedSessionId: 'agent-grid',
      root: {
        type: 'split',
        direction: 'vertical',
        ratio: 0.5,
        a: { type: 'leaf', sessionId: 'agent-grid' },
        b: { type: 'leaf', sessionId: 'agent-child' },
      },
    },
  ],
  sessions: {
    'agent-grid': {
      cwd: '/repo/agent-grid',
      kind: 'claude',
      providerSessionId: 'provider-agent-grid-1234567890',
      builtInMcpDomains: ['orchestration', 'ai_workspace'],
    },
    'agent-child': {
      cwd: '/repo/agent-child',
      kind: 'codex',
      linkedParentId: 'agent-grid',
      orchestrationParentId: 'agent-grid',
      orchestrationRootId: 'agent-grid',
      orchestrationRunId: 'run-209',
      orchestrationRole: 'worker',
    },
    'agent-detached': {
      cwd: '/repo/agent-detached',
      kind: 'codex',
      providerSessionId: 'provider-agent-detached',
    },
    'agent-pinned': {
      cwd: '/repo/agent-pinned',
      kind: 'claude',
      providerSessionId: 'provider-agent-pinned',
    },
    terminal: {
      cwd: '/repo/terminal',
      kind: 'terminal',
    },
  },
  detachedSessions: {
    'agent-detached': {
      sessionId: 'agent-detached',
      surface: 'dispatch',
      projectTabId: 'tab-a',
      projectTabTitle: 'Project A',
      projectTabIndex: 0,
      detachedAt: 1,
    },
    'agent-pinned': {
      sessionId: 'agent-pinned',
      surface: 'dispatch',
      projectTabId: 'tab-a',
      projectTabTitle: 'Project A',
      projectTabIndex: 0,
      detachedAt: 2,
    },
  },
  buried: [],
  pinnedSessionIds: ['agent-pinned'],
}

const runningRuntime = {
  ...emptyRuntime(),
  sessionStatus: 'running' as const,
  sessionStatusSource: 'semantic' as const,
  processStatus: 'started' as const,
  transcriptStatus: 'ready' as const,
  activityStatus: 'Calling tool',
  streamPhase: 'tool-use' as const,
}

const grid = buildAgentStatusModel(baseState, runningRuntime, 'agent-grid')
assert.ok(grid)
assert.equal(grid.kind, 'claude')
assert.equal(grid.providerSessionState, 'present')
assert.equal(formatProviderSession(grid), 'present · provider-age')
assert.equal(grid.placement.bucket, 'grid')
assert.equal(grid.placement.physical, 'grid')
assert.equal(grid.placement.activeTab, true)
assert.equal(grid.placement.focused, true)
assert.equal(mcpFields(grid)[0]?.value, 'orchestration, ai_workspace')
assert.deepEqual(
  runtimeFields(grid).map(field => [field.label, field.value]),
  [
    ['Session', 'running · semantic'],
    ['Process', 'started'],
    ['Transcript', 'ready'],
    ['Activity', 'Calling tool'],
  ],
)

const dispatchState: WorkspaceState = {
  ...baseState,
  dispatchMode: { scope: 'project', focusedSessionId: 'agent-detached' },
}
const detached = buildAgentStatusModel(dispatchState, emptyRuntime(), 'agent-detached')
assert.ok(detached)
assert.equal(detached.placement.bucket, 'detached-dispatch')
assert.equal(detached.placement.physical, 'detached')
assert.equal(detached.placement.focused, true)
assert.equal(detached.placement.dispatchLabel, 'A3')
assert.equal(formatPlacement(detached), 'Detached Dispatch · A3')

const pinnedState: WorkspaceState = {
  ...baseState,
  dispatchMode: { scope: 'project', focusedSessionId: 'agent-pinned' },
}
const pinned = buildAgentStatusModel(pinnedState, emptyRuntime(), 'agent-pinned')
assert.ok(pinned)
assert.equal(pinned.placement.bucket, 'pinned-dispatch')
assert.equal(pinned.placement.physical, 'detached')
assert.equal(pinned.placement.dispatchLabel, '★1')
assert.equal(formatPlacement(pinned), 'Pinned Dispatch · detached · ★1')

const child = buildAgentStatusModel(baseState, emptyRuntime(), 'agent-child')
assert.ok(child)
assert.equal(child.providerSessionState, 'none')
assert.equal(formatProviderSession(child), 'missing')
assert.deepEqual(
  relationshipFields(child).map(field => [field.label, field.value]),
  [
    ['Linked parent', 'agent-grid'],
    ['Orch parent', 'agent-grid'],
    ['Orch root', 'agent-grid'],
    ['Orch run', 'run-209'],
    ['Orch role', 'worker'],
  ],
)

assert.equal(buildAgentStatusModel(baseState, emptyRuntime(), 'terminal'), null)
assert.equal(buildAgentStatusModel(baseState, emptyRuntime(), 'missing'), null)

console.log('agent status model tests passed')
