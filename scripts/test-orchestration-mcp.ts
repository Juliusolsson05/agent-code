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
  assert.throws(() =>
    markOrchestrationBootstrapPromptDelivered({
      state,
      parentSessionId: parent,
      sessionId: unrelated,
    }),
  )
}

{
  const prompt = buildOrchestrationBootstrapPrompt({
    task: 'Review the provider runtime contract.',
    inheritedParentContext: true,
  })

  assert.match(prompt, /orchestrated child agent/)
  assert.match(prompt, /duplicated copy of your parent agent transcript/)
  assert.match(prompt, /Do not continue acting as the parent agent/)
  assert.match(prompt, /Review the provider runtime contract/)
}

{
  const prompt = buildOrchestrationBootstrapPrompt({
    task: 'Review the provider runtime contract.',
    inheritedParentContext: false,
  })

  assert.match(prompt, /could not provide a duplicated transcript context/)
  assert.doesNotMatch(prompt, /You were started from a duplicated copy/)
}
