// TEMPORARY RENDERING REGRESSION SCRIPT.
//
// WHY this file is allowed to exist even though it is not the testing
// shape we want long-term:
// these focused scripts were added during the 2026-05 rendering rewrite
// because we needed executable guards immediately while the feed ownership
// bugs were still active. They are intentionally small and useful, but
// they are also messy compared with the proper unit/integration suite we
// want: no standard runner, no shared fixtures, and too much local test
// scaffolding per file. Keep them until #182 establishes the app-wide
// testing suite and #183 migrates/expands the rendering regression coverage
// into that structure.

import assert from 'node:assert/strict'

import {
  codexPromptsMatchForOwnership,
  shouldQueueOptimisticCodexUserEntry,
} from '../src/renderer/src/workspace/hook/actions/streaming'
import { shouldClearIdleCodexQueuedMessages } from '../src/renderer/src/workspace/queueInvariants'
import { emptyRuntime, type SemanticLiveTurn } from '../src/renderer/src/workspace/workspaceState'

function semanticTurn(
  turnId: string,
  endedAt: number | null,
  text = '',
): SemanticLiveTurn {
  return {
    turnId,
    text,
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
    endedAt,
  }
}

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
  runtime.semantic.currentTurn = semanticTurn('resp_live', null)

  assert.equal(
    shouldQueueOptimisticCodexUserEntry(runtime),
    true,
    'a follow-up prompt during a live semantic turn must stay queued below the active turn',
  )
}

{
  const runtime = emptyRuntime()
  runtime.streamPhase = 'tool_running'
  runtime.semantic.currentTurn = semanticTurn('resp_done', 2)

  assert.equal(
    shouldQueueOptimisticCodexUserEntry(runtime),
    false,
    'a sealed semantic turn must not keep future Codex prompts stuck in QueueStrip',
  )
}

{
  const runtime = emptyRuntime()
  runtime.streamPhase = 'submitting'
  runtime.semantic.history = [
    semanticTurn('resp_history_bridge', 2, 'previous turn still visible until JSONL catches up'),
  ]

  assert.equal(
    shouldQueueOptimisticCodexUserEntry(runtime),
    true,
    'a Codex prompt must queue while rendered semantic history still owns the feed tail',
  )
}

{
  const runtime = emptyRuntime()
  runtime.streamPhase = 'submitting'
  runtime.entries = [
    {
      type: 'assistant',
      uuid: 'committed:entry',
      parentUuid: null,
      timestamp: '2026-05-20T12:00:00.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'already committed' }],
      },
    },
  ]
  runtime.semantic.history = [
    semanticTurn('resp_history_committed', 2, 'already committed'),
  ]

  assert.equal(
    shouldQueueOptimisticCodexUserEntry(runtime),
    false,
    'committed-owned semantic history must not keep later Codex prompts stuck in QueueStrip',
  )
}

{
  assert.equal(
    codexPromptsMatchForOwnership('Fix this\r\nnow  ', 'Fix this\nnow'),
    true,
    'queued Codex prompt reconciliation must tolerate rollout whitespace and CRLF normalization',
  )
  assert.equal(
    codexPromptsMatchForOwnership('Fix this now', 'Fix something else now'),
    false,
    'prompt ownership normalization must not collapse unrelated queued prompts',
  )
}

{
  assert.equal(
    shouldClearIdleCodexQueuedMessages({
      awaitingAssistant: false,
      processActive: false,
      provider: 'codex',
      queuedMessagesLength: 1,
      streamPhase: 'idle',
    }),
    true,
    'idle Codex panes must not retain local queued prompts after all live signals clear',
  )
  assert.equal(
    shouldClearIdleCodexQueuedMessages({
      awaitingAssistant: false,
      processActive: true,
      provider: 'codex',
      queuedMessagesLength: 1,
      streamPhase: 'idle',
    }),
    false,
    'active Codex process state can still legitimately own queued prompts',
  )
  assert.equal(
    shouldClearIdleCodexQueuedMessages({
      awaitingAssistant: false,
      processActive: false,
      provider: 'claude',
      queuedMessagesLength: 1,
      streamPhase: 'idle',
    }),
    false,
    'Claude queue rows are backed by provider queue-operation records and must not use the Codex fallback',
  )
}

console.log('codex optimistic submit tests passed')
