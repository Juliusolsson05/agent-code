import assert from 'node:assert/strict'

import { shouldQueueOptimisticCodexUserEntry } from '../src/renderer/src/workspace/hook/actions/streaming'
import { emptyRuntime } from '../src/renderer/src/workspace/workspaceState'

// The bug this guards was brutally simple: submit calls
// setStreamingBaseline() first, which changes streamPhase to
// "submitting", then calls addOptimisticCodexUserEntry() in the same
// synchronous handler. If the optimistic-row gate treats any non-idle
// streamPhase as "previous turn is live", every first prompt in an idle
// Codex session is queued instead of rendered as an optimistic user row.
// The semantic turn is the ownership signal; streamPhase is not.

{
  const runtime = emptyRuntime()
  runtime.streamPhase = 'submitting'

  assert.equal(
    shouldQueueOptimisticCodexUserEntry(runtime),
    false,
    'current submit phase alone must not queue the first optimistic Codex user row',
  )
}

{
  const runtime = emptyRuntime()
  runtime.streamPhase = 'idle'
  runtime.semantic.currentTurn = {
    turnId: 'resp_live',
    text: '',
    source: 'proxy',
    blocks: {},
    blockOrder: [],
    stopReason: null,
    usage: null,
    task: {
      todos: [],
      doneCount: 0,
      totalCount: 0,
      inProgressToolUseIds: [],
      activeToolNames: [],
    },
    lookups: {
      toolCallsById: {},
      toolUseIdsInOrder: [],
      resolvedToolUseIds: [],
      erroredToolUseIds: [],
    },
    startedAt: 1,
    endedAt: null,
  }

  assert.equal(
    shouldQueueOptimisticCodexUserEntry(runtime),
    true,
    'a follow-up prompt during a live semantic turn must stay queued below the active turn',
  )
}

{
  const runtime = emptyRuntime()
  runtime.streamPhase = 'tool_running'
  runtime.semantic.currentTurn = {
    turnId: 'resp_done',
    text: '',
    source: 'proxy',
    blocks: {},
    blockOrder: [],
    stopReason: null,
    usage: null,
    task: {
      todos: [],
      doneCount: 0,
      totalCount: 0,
      inProgressToolUseIds: [],
      activeToolNames: [],
    },
    lookups: {
      toolCallsById: {},
      toolUseIdsInOrder: [],
      resolvedToolUseIds: [],
      erroredToolUseIds: [],
    },
    startedAt: 1,
    endedAt: 2,
  }

  assert.equal(
    shouldQueueOptimisticCodexUserEntry(runtime),
    false,
    'a sealed semantic turn must not keep future Codex prompts stuck in QueueStrip',
  )
}

console.log('codex optimistic submit tests passed')
