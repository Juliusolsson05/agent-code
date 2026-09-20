import { describe, expect, it } from 'vitest'

import { emptyRuntime } from '@renderer/session-runtime/state'
import type { SessionRuntime } from '@renderer/session-runtime/state'
import type { WorkspaceState } from '@renderer/workspace/types'
import {
  additionalCloseImpact,
  assertManagedTarget,
  listManagedAgentDescriptors,
  managedTranscriptUnavailableReason,
  readManagedAgentOutputs,
} from '@renderer/workspace/agentManagementMcp'
import { oneLaneStage } from '@renderer/workspace/testing/stageFixtures'

function stateFixture(): WorkspaceState {
  return {
    tabs: [
      {
        id: 'project-a',
        title: 'Project A',
      },
      {
        id: 'project-b',
        title: 'Project B',
      },
    ],
    activeTabId: 'project-a',
    stage: oneLaneStage('caller'),
    sessions: {
      caller: { cwd: '/same/cwd', kind: 'claude', providerSessionId: 'provider-caller', projectId: 'project-a', joinedAt: 0 },
      'grid-agent': { cwd: '/worktree/a', kind: 'codex', title: 'Grid reviewer', projectId: 'project-a', joinedAt: 1 },
      terminal: { cwd: '/same/cwd', kind: 'terminal', projectId: 'project-a', joinedAt: 2 },
      dispatch: { cwd: '/worktree/dispatch', kind: 'opencode', projectId: 'project-a', joinedAt: 10 },
      // The ids keep their v2 names (`grid-agent`, `dispatch`, `buried`) because
      // they were chosen to cover the three OWNER STRUCTURES a session could
      // live in. All three are the same thing now — a pool row of project-a —
      // which is exactly what the listing case below asserts.
      buried: { cwd: '/worktree/buried', kind: 'claude', linkedParentId: 'grid-agent', projectId: 'project-a', joinedAt: 20 },
      foreign: { cwd: '/same/cwd', kind: 'claude', projectId: 'project-b', joinedAt: 0 },
      // Deliberately UNFILED: a row that names no project has no project scope.
      stale: { cwd: '/same/cwd', kind: 'claude' },
    },
    pinnedSessionIds: [],
  }
}

describe('Agent Management project authority', () => {
  it('lists every agent filed under the caller\'s project, in index order, and nothing else', () => {
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
      // `placement` is 'dispatch' for all of them: in this published contract
      // the value has always meant "a row in the project's agent index", which
      // every pool session is. 'grid' and 'buried' named v2 owner structures
      // that no longer exist (the enum is narrowed in stage 7 of #992).
      // The terminal is not an agent; `foreign` is another project's; `stale`
      // names no project at all.
      ['caller', 'dispatch', true],
      ['grid-agent', 'dispatch', false],
      ['dispatch', 'dispatch', false],
      ['buried', 'dispatch', false],
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

  it('fails closed for a row whose project is missing or gone', () => {
    // Re-based with #992. This was "fails closed when corrupt workspace state
    // assigns two placements": v2 searched three owner structures, so a corrupt
    // save could list one session in two of them and make project scope depend
    // on iteration order. One field cannot be ambiguous, so that corruption is
    // unrepresentable. The failure that IS still representable is a row whose
    // `projectId` points nowhere — and scope is what authorizes a cross-agent
    // read, so it must be refused rather than guessed (never "the active
    // project", never "the caller's").
    const state = stateFixture()
    state.sessions['grid-agent'] = { ...state.sessions['grid-agent']!, projectId: 'project-deleted' }
    const listed = listManagedAgentDescriptors({
      state,
      runtimes: {},
      callerSessionId: 'caller',
    })
    expect(listed.agents.map(item => item.agent.sessionId)).not.toContain('grid-agent')
    expect(listed.agents.map(item => item.agent.sessionId)).not.toContain('stale')
    // `agent_not_found`, not `agent_not_in_project`: the second code means "it
    // belongs to a DIFFERENT project", which would leak that the session exists
    // and is owned. A row with no resolvable project is, to this caller, not an
    // agent at all.
    expect(() => assertManagedTarget({ state, callerSessionId: 'caller', sessionId: 'grid-agent' }))
      .toThrow('agent_not_found')
    expect(() => assertManagedTarget({ state, callerSessionId: 'caller', sessionId: 'stale' }))
      .toThrow('agent_not_found')
  })

  it('treats a trailing unresolved user turn as waiting after restart', () => {
    const runtime = {
      ...emptyRuntime(),
      entries: [
        {
          type: 'assistant',
          timestamp: '2026-07-23T10:00:00.000Z',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Earlier answer' }] },
        },
        {
          type: 'user',
          timestamp: '2026-07-23T10:01:00.000Z',
          message: { role: 'user', content: [{ type: 'text', text: 'Please do one more thing' }] },
        },
      ],
    } as SessionRuntime
    const listed = listManagedAgentDescriptors({
      state: stateFixture(),
      runtimes: { 'grid-agent': runtime },
      callerSessionId: 'caller',
    })

    expect(listed.agents.find(item => item.agent.sessionId === 'grid-agent')?.agent)
      .toMatchObject({ activityState: 'waiting', awaitingAssistant: true })
  })

  it('marks loader errors and provisional disconnects as missing transcript evidence', () => {
    const meta = stateFixture().sessions['grid-agent']
    expect(managedTranscriptUnavailableReason({
      ...emptyRuntime(),
      transcriptStatus: 'error',
      transcriptError: 'read failed',
    }, meta)).toBe('transcript_unavailable')
    expect(managedTranscriptUnavailableReason({
      ...emptyRuntime(),
      transcriptStatus: 'disconnected',
    }, meta)).toBe('transcript_unavailable')
  })

  it('reports linked descendants that the canonical UI close would cascade', () => {
    expect(additionalCloseImpact({
      state: stateFixture(),
      callerSessionId: 'caller',
      sessionId: 'grid-agent',
    })).toEqual(['buried'])
  })

  it('reports only linked descendants, wherever the target sits in the project', () => {
    // #886 review M1. This once asserted every project sibling was affected,
    // because closing a tab's last TILE LEAF removed the tab. A close is
    // session-scoped always now (#992): no position in a project makes a
    // session's close take a sibling with it. Only the linked descendant
    // ('buried' names 'grid-agent' as its parent) is affected — the caller and
    // the unrelated 'dispatch' row must NOT be reported, because the calling
    // model acts on this list. The caller is re-ordered AFTER the target so
    // the target is the project's FIRST row, the position that used to be the
    // special one.
    const state = stateFixture()
    state.sessions.caller = { ...state.sessions.caller!, joinedAt: 5 }

    expect(additionalCloseImpact({
      state,
      callerSessionId: 'caller',
      sessionId: 'grid-agent',
    })).toEqual(['buried'])
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
