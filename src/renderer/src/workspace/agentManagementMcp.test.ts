import { describe, expect, it } from 'vitest'

import { emptyRuntime } from '@renderer/session-runtime/state'
import type { SessionRuntime } from '@renderer/session-runtime/state'
import type { WorkspaceState } from '@renderer/workspace/types'
import {
  additionalCloseImpact,
  assertManagedTarget,
  listManagedAgentDescriptors,
  readManagedAgentOutputs,
} from '@renderer/workspace/agentManagementMcp'

function stateFixture(): WorkspaceState {
  return {
    tabs: [
      {
        id: 'project-a',
        title: 'Project A',
        focusedSessionId: 'caller',
        root: {
          type: 'split',
          direction: 'vertical',
          ratio: 0.5,
          a: { type: 'leaf', sessionId: 'caller' },
          b: {
            type: 'split',
            direction: 'horizontal',
            ratio: 0.5,
            a: { type: 'leaf', sessionId: 'grid-agent' },
            b: { type: 'leaf', sessionId: 'terminal' },
          },
        },
      },
      {
        id: 'project-b',
        title: 'Project B',
        focusedSessionId: 'foreign',
        root: { type: 'leaf', sessionId: 'foreign' },
      },
    ],
    activeTabId: 'project-a',
    dispatchMode: null,
    sessions: {
      caller: { cwd: '/same/cwd', kind: 'claude', providerSessionId: 'provider-caller' },
      'grid-agent': { cwd: '/worktree/a', kind: 'codex', title: 'Grid reviewer' },
      terminal: { cwd: '/same/cwd', kind: 'terminal' },
      dispatch: { cwd: '/worktree/dispatch', kind: 'opencode' },
      buried: { cwd: '/worktree/buried', kind: 'claude', linkedParentId: 'grid-agent' },
      foreign: { cwd: '/same/cwd', kind: 'claude' },
      stale: { cwd: '/same/cwd', kind: 'claude' },
    },
    detachedSessions: {
      dispatch: {
        sessionId: 'dispatch',
        surface: 'dispatch',
        projectTabId: 'project-a',
        projectTabTitle: 'Project A',
        projectTabIndex: 0,
        detachedAt: 10,
      },
    },
    buried: [{
      id: 'buried-record',
      sessionId: 'buried',
      sessionMeta: { cwd: '/worktree/buried', kind: 'claude' },
      buriedAt: 20,
      sourceTabId: 'project-a',
      sourceTabTitle: 'Project A',
      sourceTabIndex: 0,
    }],
    pinnedSessionIds: [],
  }
}

describe('Agent Management project authority', () => {
  it('lists grid, Dispatch, and buried agents by exact tab ownership', () => {
    const listed = listManagedAgentDescriptors({
      state: stateFixture(),
      runtimes: {},
      callerSessionId: 'caller',
    })

    expect(listed.project).toMatchObject({ tabId: 'project-a', title: 'Project A' })
    expect(listed.agents.map(item => [
      item.agent.sessionId,
      item.agent.placement,
      item.agent.isCaller,
    ])).toEqual([
      ['caller', 'grid', true],
      ['grid-agent', 'grid', false],
      ['dispatch', 'dispatch', false],
      ['buried', 'buried', false],
    ])
  })

  it('rejects same-cwd agents owned by another project and self mutations', () => {
    const state = stateFixture()
    expect(() => assertManagedTarget({
      state,
      callerSessionId: 'caller',
      sessionId: 'foreign',
    })).toThrow('agent_not_in_project')
    expect(() => assertManagedTarget({
      state,
      callerSessionId: 'caller',
      sessionId: 'caller',
    })).toThrow('self_target_forbidden')
  })

  it('fails closed when corrupt workspace state assigns two placements', () => {
    const state = stateFixture()
    state.detachedSessions['grid-agent'] = {
      sessionId: 'grid-agent',
      surface: 'dispatch',
      projectTabId: 'project-a',
      projectTabTitle: 'Project A',
      projectTabIndex: 0,
      detachedAt: 30,
    }
    const listed = listManagedAgentDescriptors({
      state,
      runtimes: {},
      callerSessionId: 'caller',
    })
    expect(listed.agents.map(item => item.agent.sessionId)).not.toContain('grid-agent')
  })

  it('reports linked descendants that the canonical UI close would cascade', () => {
    expect(additionalCloseImpact({
      state: stateFixture(),
      callerSessionId: 'caller',
      sessionId: 'grid-agent',
    })).toEqual(['buried'])
  })

  it('reports all project-owned siblings when closing the last grid leaf would remove its tab', () => {
    const state = stateFixture()
    state.tabs[0]!.root = { type: 'leaf', sessionId: 'grid-agent' }
    state.tabs[0]!.focusedSessionId = 'grid-agent'
    state.detachedSessions.caller = {
      sessionId: 'caller',
      surface: 'dispatch',
      projectTabId: 'project-a',
      projectTabTitle: 'Project A',
      projectTabIndex: 0,
      detachedAt: 5,
    }

    expect(additionalCloseImpact({
      state,
      callerSessionId: 'caller',
      sessionId: 'grid-agent',
    })).toEqual(expect.arrayContaining(['caller', 'dispatch', 'buried']))
  })
})

describe('Agent Management bounded bulk reads', () => {
  it('omits the caller by default and returns normalized visible messages', () => {
    const state = stateFixture()
    const runtime = {
      ...emptyRuntime(),
      entries: [
        {
          type: 'user',
          timestamp: '2026-07-23T10:00:00.000Z',
          message: { role: 'user', content: [{ type: 'text', text: 'Review this branch' }] },
        },
        {
          type: 'assistant',
          timestamp: '2026-07-23T10:01:00.000Z',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Review complete' }] },
        },
      ],
    } as SessionRuntime
    const result = readManagedAgentOutputs({
      state,
      runtimes: { 'grid-agent': runtime },
      callerSessionId: 'caller',
      sessionIds: ['grid-agent'],
      maxTotalChars: 2_000,
    })

    expect(result.outputs).toHaveLength(1)
    expect(result.outputs[0]?.output.messages.map(message => message.text)).toEqual([
      'Review this branch',
      'Review complete',
    ])
    expect(result.agents.find(item => item.agent.isCaller)).toBeDefined()
  })

  it('shares a strict total budget so later agents retain newest evidence', () => {
    const state = stateFixture()
    const runtime = (label: string) => ({
      ...emptyRuntime(),
      entries: [{
        type: 'assistant',
        timestamp: '2026-07-23T10:01:00.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: `${label}:${'x'.repeat(2_000)}` }],
        },
      }],
    } as SessionRuntime)
    const result = readManagedAgentOutputs({
      state,
      runtimes: {
        'grid-agent': runtime('grid'),
        dispatch: runtime('dispatch'),
        buried: runtime('buried'),
      },
      callerSessionId: 'caller',
      maxCharsPerAgent: 500,
      maxTotalChars: 1_000,
    })

    expect(result.outputs).toHaveLength(3)
    expect(result.outputs.every(output => output.output.messages.length === 1)).toBe(true)
    expect(result.outputs.at(-1)?.output.messages[0]?.text).toContain('buried')
    expect(result.totalChars).toBeLessThanOrEqual(1_000)
    expect(result.truncated).toBe(true)
  })
})
