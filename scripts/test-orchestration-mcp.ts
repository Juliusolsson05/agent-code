import assert from 'node:assert/strict'

import {
  closeOrchestrationRun,
  listOrchestrationAgents,
  markOrchestrationBootstrapPromptDelivered,
  readOrchestrationAgent,
  readOrchestrationRunOutputs,
} from '../src/renderer/src/workspace/orchestrationMcp'
import { buildOrchestrationBootstrapPrompt } from '../src/mcp/shared/orchestrationPrompt'
import { emptyRuntime } from '../src/renderer/src/workspace/workspaceState'
import type { SessionMeta, WorkspaceState } from '../src/renderer/src/workspace/types'

const parent = 'parent-session'
const child = 'child-session'
const grandchild = 'grandchild-session'
const unrelated = 'unrelated-session'

const meta = (cwd: string, extra: Partial<SessionMeta>): SessionMeta => ({
  cwd,
  kind: 'codex',
  ...extra,
})

const state: WorkspaceState = {
  tabs: [],
  activeTabId: '',
  dispatchMode: null,
  detachedSessions: {},
  buried: [],
  pinnedSessionIds: [],
  sessions: {
    [child]: meta('/child', {
      orchestrationParentId: parent,
      orchestrationRootId: parent,
      orchestrationRunId: 'run-a',
      orchestrationRole: 'worker',
      inheritedParentContext: true,
      inheritedParentProviderSessionId: 'parent-provider-session',
      inheritedProviderSessionId: 'child-provider-session',
      orchestrationBootstrapPromptDelivered: true,
    }),
    [grandchild]: meta('/grandchild', {
      orchestrationParentId: child,
      orchestrationRootId: parent,
      orchestrationRunId: 'run-a',
    }),
    [unrelated]: meta('/unrelated', {
      orchestrationParentId: 'someone-else',
      orchestrationRootId: 'someone-else',
      orchestrationRunId: 'run-a',
    }),
  },
}

const runtime = {
  ...emptyRuntime(),
  inputReady: true,
  processStatus: 'started' as const,
  entries: [
    {
      type: 'user',
      uuid: 'u1',
      parentUuid: null,
      timestamp: '2026-05-17T10:00:00.000Z',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'Please review this PR.' }],
      },
    },
    {
      type: 'assistant',
      uuid: 'a1',
      parentUuid: 'u1',
      timestamp: '2026-05-17T10:01:00.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'No findings.' }],
      },
    },
  ],
}

const inheritedRuntime = {
  ...emptyRuntime(),
  inputReady: true,
  processStatus: 'started' as const,
  entries: [
    {
      type: 'user',
      uuid: 'parent-u1',
      parentUuid: null,
      timestamp: '2026-05-17T09:00:00.000Z',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'Parent task.' }],
      },
    },
    {
      type: 'assistant',
      uuid: 'parent-a1',
      parentUuid: 'parent-u1',
      timestamp: '2026-05-17T09:01:00.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Inherited parent answer.' }],
      },
    },
    {
      type: 'user',
      uuid: 'child-u1',
      parentUuid: 'parent-a1',
      timestamp: '2026-05-17T10:00:00.000Z',
      message: {
        role: 'user',
        content: [
          {
            type: 'text',
            text: [
              '<orchestration-handoff>',
              'You are now an orchestrated child agent in Agent Code.',
              '</orchestration-handoff>',
              '',
              '<task>',
              'Review the provider runtime contract.',
              '</task>',
            ].join('\n'),
          },
        ],
      },
    },
    {
      type: 'assistant',
      uuid: 'child-a1',
      parentUuid: 'child-u1',
      timestamp: '2026-05-17T10:01:00.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Child review result.' }],
      },
    },
  ],
}

const nestedInheritedRuntime = {
  ...emptyRuntime(),
  inputReady: true,
  processStatus: 'started' as const,
  entries: [
    {
      type: 'user',
      uuid: 'ancestor-child-u1',
      parentUuid: null,
      timestamp: '2026-05-17T08:00:00.000Z',
      message: {
        role: 'user',
        content: [{
          type: 'text',
          text: [
            '<orchestration-handoff>',
            'Older inherited handoff from the parent agent launch.',
            '</orchestration-handoff>',
          ].join('\n'),
        }],
      },
    },
    {
      type: 'assistant',
      uuid: 'ancestor-child-a1',
      parentUuid: 'ancestor-child-u1',
      timestamp: '2026-05-17T08:01:00.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Older inherited child result.' }],
      },
    },
    {
      type: 'user',
      uuid: 'current-child-u1',
      parentUuid: 'ancestor-child-a1',
      timestamp: '2026-05-17T10:00:00.000Z',
      message: {
        role: 'user',
        content: [{
          type: 'text',
          text: [
            '<orchestration-handoff>',
            'Current child handoff.',
            '</orchestration-handoff>',
            '',
            '<task>',
            'Review nested orchestration output.',
            '</task>',
          ].join('\n'),
        }],
      },
    },
    {
      type: 'assistant',
      uuid: 'current-child-a1',
      parentUuid: 'current-child-u1',
      timestamp: '2026-05-17T10:01:00.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Current child result.' }],
      },
    },
  ],
}

const inheritedRuntimeWithStructuredUserEntry = {
  ...emptyRuntime(),
  inputReady: true,
  processStatus: 'started' as const,
  entries: [
    {
      type: 'user',
      uuid: 'parent-u1',
      parentUuid: null,
      timestamp: '2026-05-17T09:00:00.000Z',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'Parent task.' }],
      },
    },
    {
      type: 'user',
      uuid: 'child-u1',
      parentUuid: 'parent-u1',
      timestamp: '2026-05-17T10:00:00.000Z',
      message: {
        role: 'user',
        content: [
          {
            type: 'text',
            text: [
              '<orchestration-handoff>',
              'Current child handoff.',
              '</orchestration-handoff>',
            ].join('\n'),
          },
        ],
      },
    },
    {
      type: 'user',
      uuid: 'child-tool-result',
      parentUuid: 'child-u1',
      timestamp: '2026-05-17T10:00:30.000Z',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu-read',
          content: 'tool output',
        }],
      },
    },
    {
      type: 'assistant',
      uuid: 'child-a1',
      parentUuid: 'child-tool-result',
      timestamp: '2026-05-17T10:01:00.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Structured user entry handled.' }],
      },
    },
  ],
}

{
  const agents = listOrchestrationAgents({
    state,
    runtimes: {
      [child]: runtime,
      [grandchild]: { ...emptyRuntime(), processActive: true, sessionStatus: 'running' },
      [unrelated]: runtime,
    },
    parentSessionId: parent,
    runId: 'run-a',
  })

  // WHY this assertion matters:
  // orchestration tools are scoped child-control tools, not global workspace
  // introspection. Descendants in the same root are visible to the root parent
  // so a run coordinator can read its tree, but a sibling parent cannot leak in.
  assert.deepEqual(agents.map(agent => agent.sessionId).sort(), [child, grandchild])
  assert.equal(agents.find(agent => agent.sessionId === child)?.lifecycleState, 'completed')
  assert.equal(agents.find(agent => agent.sessionId === child)?.inheritedParentContext, true)
  assert.equal(
    agents.find(agent => agent.sessionId === child)?.inheritedProviderSessionId,
    'child-provider-session',
  )
  assert.equal(
    agents.find(agent => agent.sessionId === child)?.orchestrationBootstrapPromptDelivered,
    true,
  )
  assert.equal(agents.find(agent => agent.sessionId === grandchild)?.lifecycleState, 'running')
}

{
  const output = readOrchestrationAgent({
    state,
    runtimes: { [child]: runtime },
    parentSessionId: parent,
    sessionId: child,
  })

  assert.equal(output.latestAssistantText, 'No findings.')
  assert.deepEqual(output.messages.map(message => message.role), ['user', 'assistant'])
}

{
  const output = readOrchestrationAgent({
    state,
    runtimes: { [child]: inheritedRuntime },
    parentSessionId: parent,
    sessionId: child,
  })

  // WHY inherited output is scoped to the bootstrap prompt:
  // the provider transcript must retain parent history as model context, but
  // orchestration parents need the child's work product. A raw latest-message
  // scan over the full resumed transcript regressed real review agents by
  // reporting stale parent commentary as the child's final result.
  assert.equal(output.latestAssistantText, 'Child review result.')
  assert.equal(output.agent.latestAssistantText, 'Child review result.')
  assert.deepEqual(output.messages.map(message => message.text), [
    [
      '<orchestration-handoff>',
      'You are now an orchestrated child agent in Agent Code.',
      '</orchestration-handoff>',
      '',
      '<task>',
      'Review the provider runtime contract.',
      '</task>',
    ].join('\n'),
    'Child review result.',
  ])
}

{
  const output = readOrchestrationAgent({
    state,
    runtimes: { [child]: nestedInheritedRuntime },
    parentSessionId: parent,
    sessionId: child,
  })

  // WHY this covers chained orchestration:
  // a child can be spawned from a parent that was itself orchestrated. In that
  // case the inherited transcript already contains an older handoff marker.
  // The output cut must use the newest marker written for the current child,
  // otherwise grandchild reads can leak the parent's child-task answer.
  assert.equal(output.latestAssistantText, 'Current child result.')
  assert.deepEqual(output.messages.map(message => message.text), [
    [
      '<orchestration-handoff>',
      'Current child handoff.',
      '</orchestration-handoff>',
      '',
      '<task>',
      'Review nested orchestration output.',
      '</task>',
    ].join('\n'),
    'Current child result.',
  ])
}

{
  const output = readOrchestrationAgent({
    state,
    runtimes: { [child]: inheritedRuntimeWithStructuredUserEntry },
    parentSessionId: parent,
    sessionId: child,
  })

  // WHY this fixture puts a non-text user entry after the handoff:
  // Claude/Codex transcripts can encode tool-result payloads as user-role
  // conversation entries. The handoff scan walks from newest to oldest, so the
  // read path must skip structured user entries instead of assuming text and
  // crashing before it reaches the real bootstrap marker.
  assert.equal(output.latestAssistantText, 'Structured user entry handled.')
  assert.deepEqual(output.messages.map(message => message.text), [
    [
      '<orchestration-handoff>',
      'Current child handoff.',
      '</orchestration-handoff>',
    ].join('\n'),
    'Structured user entry handled.',
  ])
}

{
  assert.throws(() =>
    readOrchestrationAgent({
      state,
      runtimes: { [unrelated]: runtime },
      parentSessionId: parent,
      sessionId: unrelated,
    }),
  )
}

{
  const outputs = readOrchestrationRunOutputs({
    state,
    runtimes: { [child]: runtime, [grandchild]: emptyRuntime(), [unrelated]: runtime },
    parentSessionId: parent,
    runId: 'run-a',
    maxMessagesPerAgent: 1,
  })

  assert.deepEqual(outputs.map(output => output.agent.sessionId).sort(), [child, grandchild])
  assert.equal(outputs.find(output => output.agent.sessionId === child)?.messages.length, 1)
}

{
  const closed = await closeOrchestrationRun({
    state,
    parentSessionId: parent,
    runId: 'run-a',
    closeSession: async () => {},
  })

  assert.deepEqual(closed.closedSessionIds.sort(), [child, grandchild])
  assert.equal(closed.skippedSessionIds, undefined)
}

{
  const unmarked: WorkspaceState = {
    ...state,
    sessions: {
      ...state.sessions,
      [child]: {
        ...state.sessions[child]!,
        orchestrationBootstrapPromptDelivered: false,
      },
    },
  }
  const marked = markOrchestrationBootstrapPromptDelivered({
    state: unmarked,
    parentSessionId: parent,
    sessionId: child,
  })
  assert.equal(
    marked.sessions[child]?.orchestrationBootstrapPromptDelivered,
    true,
  )
  const unchanged = markOrchestrationBootstrapPromptDelivered({
      state,
      parentSessionId: parent,
      sessionId: unrelated,
    })
  assert.equal(unchanged, state)
}

{
  const prompt = buildOrchestrationBootstrapPrompt({
    task: 'Review the provider runtime contract.',
  })

  assert.match(prompt, /orchestrated child agent/)
  assert.match(prompt, /clean conversation/)
  assert.match(prompt, /inherited parent transcript context is temporarily disabled/)
  assert.match(prompt, /Review the provider runtime contract/)
}
