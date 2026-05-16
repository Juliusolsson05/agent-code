import assert from 'node:assert/strict'

import type { Entry } from '../src/shared/types/transcript'
import type { SemanticLiveTurn } from '../src/renderer/src/workspace/workspaceState'
import { deriveFeedRenderModel } from '../src/renderer/src/features/feed/model/renderModel'

function assistantEntry(id: string, text: string): Entry {
  return {
    type: 'assistant',
    uuid: `${id}:entry`,
    parentUuid: null,
    timestamp: '2026-05-16T18:30:00.000Z',
    message: {
      id,
      role: 'assistant',
      content: [{ type: 'text', text }],
    },
  } as Entry
}

function assistantEntryWithoutMessageId(uuid: string, text: string): Entry {
  return {
    type: 'assistant',
    uuid,
    parentUuid: null,
    timestamp: '2026-05-16T18:30:00.000Z',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
    },
  } as Entry
}

function userEntry(id: string, text: string, isMeta = false): Entry {
  return {
    type: 'user',
    uuid: `${id}:entry`,
    parentUuid: null,
    timestamp: '2026-05-16T18:30:01.000Z',
    isMeta,
    message: {
      id,
      role: 'user',
      content: [{ type: 'text', text }],
    },
  } as Entry
}

function systemEntry(id: string): Entry {
  return {
    type: 'system',
    uuid: `${id}:entry`,
    timestamp: '2026-05-16T18:30:02.000Z',
  } as Entry
}

function liveTurn(turnId: string, source: string | null = 'proxy'): SemanticLiveTurn {
  return {
    turnId,
    text: 'live assistant text',
    source,
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
}

function textBlockTurn(turnId: string, text: string): SemanticLiveTurn {
  return {
    ...liveTurn(turnId),
    text: '',
    blocks: {
      0: {
        blockIndex: 0,
        kind: 'message',
        text,
        finalized: true,
        status: 'completed',
      },
    },
    blockOrder: [0],
  }
}

function toolBlockTurn(turnId: string, callId: string): SemanticLiveTurn {
  return {
    ...liveTurn(turnId),
    text: '',
    blocks: {
      0: {
        blockIndex: 0,
        kind: 'tool_use',
        toolName: 'exec_command',
        callId,
        inputJson: '{}',
      },
    },
    blockOrder: [0],
  }
}

// WHY these tests sit below the renderer instead of inside Feed.tsx:
// the failure mode we keep reintroducing is not "React cannot map an
// array." It is "two different data planes both believe they own the
// same assistant slot." A pure selector test makes that ownership
// contract executable without needing a browser, markdown rendering,
// IntersectionObserver, or scroll timing in the loop.

{
  const entries = [
    userEntry('u1', 'visible user'),
    userEntry('meta', '<task-notification>hidden</task-notification>', true),
    systemEntry('system-noise'),
    assistantEntry('a1', 'visible assistant'),
  ]

  const model = deriveFeedRenderModel({
    provider: 'claude',
    entries,
    semanticHistory: [],
    semanticTurn: null,
    streamPhase: 'idle',
    streamPhasePendingToolName: null,
    streamPhasePendingToolUseId: null,
  })

  assert.deepEqual(
    model.visibleDecisions.map(item => [item.visible, item.reason]),
    [
      [true, 'conversation'],
      [false, 'meta_filtered'],
      [false, 'not_conversation'],
      [true, 'conversation'],
    ],
    'committed visibility must hide meta/system noise without hiding real conversation rows',
  )
  assert.equal(model.visibleEntries.length, 2)
  assert.deepEqual(
    model.debugRows.map(row => row.slot),
    ['entry', 'entry'],
    'debug rows must describe only render-owned committed rows when idle',
  )
}

{
  const model = deriveFeedRenderModel({
    provider: 'claude',
    entries: [assistantEntry('claude-turn', 'already committed')],
    semanticHistory: [liveTurn('claude-turn')],
    semanticTurn: null,
    streamPhase: 'idle',
    streamPhasePendingToolName: null,
    streamPhasePendingToolUseId: null,
  })

  assert.equal(
    model.renderedSemanticHistory.length,
    0,
    'Claude committed message id must suppress the archived semantic copy of that same turn',
  )
  assert.deepEqual(
    model.debugRows.map(row => row.key),
    ['entry:claude-turn:entry'],
    'Claude suppression should leave the committed row as the sole owner',
  )
}

{
  const model = deriveFeedRenderModel({
    provider: 'claude',
    entries: [userEntry('hidden-turn', 'meta owner must not own assistant surface', true)],
    semanticHistory: [liveTurn('hidden-turn')],
    semanticTurn: null,
    streamPhase: 'idle',
    streamPhasePendingToolName: null,
    streamPhasePendingToolUseId: null,
  })

  assert.equal(
    model.renderedSemanticHistory.length,
    1,
    'hidden/non-assistant message ids must not suppress semantic history they do not visibly own',
  )
}

{
  const model = deriveFeedRenderModel({
    provider: 'codex',
    entries: [assistantEntry('committed', 'same text')],
    semanticHistory: [],
    semanticTurn: textBlockTurn('different-live-id', 'same text'),
    streamPhase: 'idle',
    streamPhasePendingToolName: null,
    streamPhasePendingToolUseId: null,
  })

  assert.equal(
    model.renderedSemanticTurn,
    null,
    'current semantic turn must disappear from the render model when all of its units are committed duplicates',
  )
  assert.deepEqual(
    model.debugRows.map(row => row.slot),
    ['entry'],
    'debug rows must not claim a semantic row exists when SemanticStreamingTurn would return null',
  )
}

{
  const committed = assistantEntry(
    'committed-rollout-copy',
    'This worktree has empty submodule directories; that explains the build/typecheck noise and the missing mitm file. I’m initializing the submodules in the worktree now, then I’ll rerun the bundle check.',
  )
  const archived = liveTurn('rollout-1778956726793', 'rollout')
  archived.text = 'This worktree has empty submodule directories; that explains the build/typecheck noise and the missing mitm file.\nI’m initializing the submodules in the worktree now, then I’ll rerun the bundle check.'
  archived.endedAt = 1778956726844

  const model = deriveFeedRenderModel({
    provider: 'codex',
    entries: [committed],
    semanticHistory: [archived],
    semanticTurn: null,
    streamPhase: 'idle',
    streamPhasePendingToolName: null,
    streamPhasePendingToolUseId: null,
  })

  assert.equal(
    model.renderedSemanticHistory.length,
    0,
    'archived text-only rollout turns must suppress once committed text owns the same rendered message',
  )
  assert.deepEqual(
    model.debugRows.map(row => row.slot),
    ['entry'],
    'stale rollout history must not remain as a bottom semantic row after committed catch-up',
  )
}

{
  const stuckReviewText =
    'The full persistent feed-debug confirms it kept happening after the snapshot: every later `block_started`/`stream_phase` has fresh `resp_*` ids, but every RENDER row still reports the old `resp_06ef...` as `semanticTurnId`. The old turn is a completed message block with `endedAt: null`, so the strict Codex mismatch guard treats every later response as a racing producer and drops it.'
  const committed = assistantEntryWithoutMessageId(
    '2026-05-16T18:44:54.285Z:message',
    stuckReviewText,
  )
  const archived = liveTurn('rollout-1778957261399', 'rollout')
  archived.text = stuckReviewText
  archived.endedAt = 1778957261750

  const model = deriveFeedRenderModel({
    provider: 'codex',
    entries: [committed],
    semanticHistory: [archived],
    semanticTurn: null,
    streamPhase: 'idle',
    streamPhasePendingToolName: null,
    streamPhasePendingToolUseId: null,
  })

  assert.equal(
    model.renderedSemanticHistory.length,
    0,
    'visible committed assistant text without message.id must still own and suppress the same rollout history text',
  )
  assert.deepEqual(
    model.debugRows.map(row => row.key),
    ['entry:2026-05-16T18:44:54.285Z:message'],
    'the 2026-05-16T18:49 stuck rollout row must leave only the committed assistant row',
  )
}

{
  const codexCommittedToolItem = {
    ...assistantEntry('codex-item', 'tool item committed first'),
    codexTurnId: 'codex-turn',
    message: {
      id: 'codex-item',
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'tool-1', name: 'exec_command', input: {} }],
    },
  } as Entry

  const model = deriveFeedRenderModel({
    provider: 'codex',
    entries: [codexCommittedToolItem],
    semanticHistory: [liveTurn('codex-turn', 'rollout')],
    semanticTurn: null,
    streamPhase: 'idle',
    streamPhasePendingToolName: null,
    streamPhasePendingToolUseId: null,
  })

  assert.equal(
    model.renderedSemanticHistory.length,
    1,
    'Codex committed rollout items must not suppress a whole semantic turn by broad codexTurnId',
  )
  assert.deepEqual(
    model.debugRows.map(row => row.slot),
    ['entry', 'semantic'],
    'Codex can legitimately render committed item rows plus still-live semantic leftovers',
  )
}

{
  const committedToolUseIndex = new Map([
    ['tool-1', { type: 'tool_use', id: 'tool-1', name: 'exec_command', input: {} }],
  ])
  const model = deriveFeedRenderModel({
    provider: 'codex',
    entries: [],
    semanticHistory: [],
    semanticTurn: toolBlockTurn('live-tool-turn', 'tool-1'),
    streamPhase: 'tool-use',
    streamPhasePendingToolName: 'exec_command',
    streamPhasePendingToolUseId: 'tool-1',
    committedToolUseIndex,
  })

  assert.equal(
    model.renderedSemanticTurn,
    null,
    'committed tool_use ownership must suppress a live semantic turn whose only unit is that committed tool',
  )
  assert.deepEqual(
    model.debugRows.map(row => row.slot),
    ['empty', 'work'],
    'work remains visible even when the duplicate live semantic tool unit is suppressed',
  )
}

{
  const model = deriveFeedRenderModel({
    provider: 'codex',
    entries: [],
    semanticHistory: [],
    semanticTurn: null,
    streamPhase: 'requesting',
    streamPhasePendingToolName: null,
    streamPhasePendingToolUseId: null,
  })

  assert.equal(model.shouldShowWorkIndicator, true)
  assert.deepEqual(
    model.debugRows.map(row => row.slot),
    ['empty', 'work'],
    'work state must render independently even before committed or semantic content exists',
  )
}
