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

import type { Entry, ToolResultBlock, ToolUseBlock } from '../src/shared/types/transcript'
import type { SemanticLiveTurn } from '../src/renderer/src/workspace/workspaceState'
import { deriveFeedRenderModel } from '../src/renderer/src/features/feed/model/renderModel'

function assistantEntry(id: string, text: string, timestamp = '2026-05-16T18:30:00.000Z'): Entry {
  return {
    type: 'assistant',
    uuid: `${id}:entry`,
    parentUuid: null,
    timestamp,
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

function userEntry(
  id: string,
  text: string,
  isMeta = false,
  timestamp = '2026-05-16T18:30:01.000Z',
): Entry {
  return {
    type: 'user',
    uuid: `${id}:entry`,
    parentUuid: null,
    timestamp,
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

function toolOutputTurn(turnId: string, callId: string): SemanticLiveTurn {
  return {
    ...liveTurn(turnId),
    text: '',
    blocks: {
      0: {
        blockIndex: 0,
        kind: 'function_call_output',
        callId,
        output: 'live stdout still streaming',
        finalized: true,
        status: 'completed',
      },
    },
    blockOrder: [0],
  }
}

function writeStdinTurn(turnId: string, chars: string): SemanticLiveTurn {
  return {
    ...liveTurn(turnId),
    text: '',
    blocks: {
      0: {
        blockIndex: 0,
        kind: 'function_call',
        toolName: 'write_stdin',
        callId: 'stdin-call',
        inputJson: JSON.stringify({ chars }),
        parsedInput: { chars },
        finalized: true,
        status: 'completed',
      },
    },
    blockOrder: [0],
  }
}

function webSearchHistoryTurn(turnId: string, itemId: string, answerText: string): SemanticLiveTurn {
  return {
    ...liveTurn(turnId),
    text: answerText,
    endedAt: 2,
    blocks: {
      0: {
        blockIndex: 0,
        kind: 'reasoning',
        itemId: `rs_${itemId}`,
        finalized: true,
        text: '',
        thinking: '',
        reasoningSummary: '',
        reasoningText: '',
      },
      1: {
        blockIndex: 1,
        kind: 'web_search_call',
        itemId,
        status: 'completed',
        finalized: true,
        webSearchAction: {
          kind: 'search',
          query: 'Electron window.prompt is not supported',
          queries: ['Electron window.prompt is not supported'],
        },
      },
      2: {
        blockIndex: 2,
        kind: 'message',
        itemId: `msg_${itemId}`,
        status: 'completed',
        finalized: true,
        text: answerText,
      },
    },
    blockOrder: [0, 1, 2],
  }
}

// WHY these tests sit below the renderer instead of inside Feed.tsx:
// the failure mode we keep reintroducing is not "React cannot map an
// array." It is "two different data planes both believe they own the
// same assistant slot." A pure selector test makes that ownership
// contract executable without needing a browser, markdown rendering,
// IntersectionObserver, or scroll timing in the loop.

function itemTypes(model: ReturnType<typeof deriveFeedRenderModel>): string[] {
  return model.items.map(item => item.type)
}

function itemCount(model: ReturnType<typeof deriveFeedRenderModel>, type: string): number {
  return model.items.filter(item => item.type === type).length
}

function hasItem(model: ReturnType<typeof deriveFeedRenderModel>, type: string): boolean {
  return model.items.some(item => item.type === type)
}

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
  assert.equal(itemCount(model, 'entry'), 2)
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
    itemCount(model, 'semantic-history'),
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
    itemCount(model, 'semantic-history'),
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
    hasItem(model, 'semantic-current'),
    false,
    'current semantic turn must disappear from the render model when all of its units are committed duplicates',
  )
  assert.deepEqual(
    model.debugRows.map(row => row.slot),
    ['entry'],
    'debug rows must not claim a semantic row exists when SemanticStreamingTurn would return null',
  )
}

{
  const archived = liveTurn('resp_history_bridge')
  archived.endedAt = Date.parse('2026-05-16T18:29:59.000Z')
  const model = deriveFeedRenderModel({
    provider: 'codex',
    entries: [userEntry('optimistic-codex-user:1', 'new submitted prompt')],
    semanticHistory: [archived],
    semanticTurn: null,
    streamPhase: 'submitting',
    streamPhasePendingToolName: null,
    streamPhasePendingToolUseId: null,
  })

  assert.deepEqual(
    model.items.map(item => item.type),
    ['semantic-history', 'entry', 'work'],
    'Feed must chronologically place archived semantic history before a newer optimistic prompt instead of appending history under the prompt',
  )
  assert.deepEqual(
    model.debugRows.map(row => row.itemType),
    ['semantic-history', 'entry', 'work'],
    'debug rows must report the same unified item order that Feed renders',
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
    itemCount(model, 'semantic-history'),
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
    itemCount(model, 'semantic-history'),
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
    itemCount(model, 'semantic-history'),
    1,
    'Codex committed rollout items must not suppress a whole semantic turn by broad codexTurnId',
  )
  assert.deepEqual(
    model.debugRows.map(row => row.slot),
    ['semantic', 'entry'],
    'Codex can legitimately render committed item rows plus still-live semantic leftovers in the unified chronological order',
  )
}

{
  const committedToolUseIndex = new Map<string, ToolUseBlock>([
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
    hasItem(model, 'semantic-current'),
    false,
    'committed tool_use ownership must suppress a live semantic turn whose only unit is that committed tool',
  )
  assert.deepEqual(
    model.debugRows.map(row => row.slot),
    ['empty', 'work'],
    'work remains visible even when the duplicate live semantic tool unit is suppressed',
  )
}

{
  const committedToolUseIndex = new Map<string, ToolUseBlock>([
    ['tool-1', { type: 'tool_use', id: 'tool-1', name: 'exec_command', input: {} }],
  ])
  const model = deriveFeedRenderModel({
    provider: 'codex',
    entries: [],
    semanticHistory: [],
    semanticTurn: toolOutputTurn('live-output-turn', 'tool-1'),
    streamPhase: 'tool-use',
    streamPhasePendingToolName: 'exec_command',
    streamPhasePendingToolUseId: 'tool-1',
    committedToolUseIndex,
    committedToolResultIndex: new Map(),
  })

  assert.equal(
    hasItem(model, 'semantic-current'),
    true,
    'committed tool_use alone must not hide live tool output before the committed tool_result lands',
  )
  assert.deepEqual(
    model.debugRows.map(row => row.slot),
    ['semantic', 'work'],
    'live output remains the render owner during tool_result JSONL lag',
  )
}

{
  const committedToolUseIndex = new Map<string, ToolUseBlock>([
    ['tool-1', { type: 'tool_use', id: 'tool-1', name: 'exec_command', input: {} }],
  ])
  const committedToolResultIndex = new Map<string, ToolResultBlock>([
    ['tool-1', { type: 'tool_result', tool_use_id: 'tool-1', content: 'committed stdout' }],
  ])
  const model = deriveFeedRenderModel({
    provider: 'codex',
    entries: [],
    semanticHistory: [],
    semanticTurn: toolOutputTurn('live-output-turn', 'tool-1'),
    streamPhase: 'tool-use',
    streamPhasePendingToolName: 'exec_command',
    streamPhasePendingToolUseId: 'tool-1',
    committedToolUseIndex,
    committedToolResultIndex,
  })

  assert.equal(
    hasItem(model, 'semantic-current'),
    false,
    'committed tool_result ownership must suppress the duplicate live output block',
  )
  assert.deepEqual(
    model.debugRows.map(row => row.slot),
    ['empty', 'work'],
    'after committed result catch-up, only the independent work state remains',
  )
}

{
  const model = deriveFeedRenderModel({
    provider: 'codex',
    entries: [],
    semanticHistory: [],
    semanticTurn: writeStdinTurn('empty-stdin-turn', ''),
    streamPhase: 'tool-use',
    streamPhasePendingToolName: 'write_stdin',
    streamPhasePendingToolUseId: 'stdin-call',
  })

  assert.equal(
    hasItem(model, 'semantic-current'),
    false,
    'empty write_stdin must not count as renderable semantic content when the row renderer paints null',
  )
  assert.deepEqual(
    model.debugRows.map(row => row.slot),
    ['empty', 'work'],
    'debug rows must not claim an invisible write_stdin block owns the feed',
  )
}

{
  const model = deriveFeedRenderModel({
    provider: 'codex',
    entries: [],
    semanticHistory: [],
    semanticTurn: writeStdinTurn('stdin-turn', 'y\n'),
    streamPhase: 'tool-use',
    streamPhasePendingToolName: 'write_stdin',
    streamPhasePendingToolUseId: 'stdin-call',
  })

  assert.equal(
    hasItem(model, 'semantic-current'),
    true,
    'non-empty write_stdin must still render as live semantic tool content',
  )
}

{
  const duplicated = liveTurn('same-turn-id', 'proxy')
  const model = deriveFeedRenderModel({
    provider: 'codex',
    entries: [],
    semanticHistory: [duplicated],
    semanticTurn: duplicated,
    streamPhase: 'thinking',
    streamPhasePendingToolName: null,
    streamPhasePendingToolUseId: null,
  })

  assert.equal(
    itemCount(model, 'semantic-history'),
    0,
    'semantic history must defensively drop the current turn id so history/current cannot double-own one turn',
  )
  assert.equal(hasItem(model, 'semantic-current'), true)
}

{
  const current = liveTurn('current-after-prompt', 'rollout')
  current.startedAt = Date.parse('2026-05-16T18:30:02.000Z')
  const model = deriveFeedRenderModel({
    provider: 'codex',
    entries: [userEntry('u-current', 'prompt before current turn')],
    semanticHistory: [],
    semanticTurn: current,
    streamPhase: 'thinking',
    streamPhasePendingToolName: null,
    streamPhasePendingToolUseId: null,
  })

  assert.deepEqual(
    model.items.map(item => item.type),
    ['entry', 'semantic-current', 'work'],
    'current semantic output that starts after the user prompt must stay below that prompt in the unified feed order',
  )
}

{
  const archived = liveTurn('late-history-race', 'rollout')
  archived.endedAt = Date.parse('2026-05-16T18:29:59.000Z')

  const beforeHistory = deriveFeedRenderModel({
    provider: 'codex',
    entries: [userEntry('race-user', 'prompt visible before semantic history arrives')],
    semanticHistory: [],
    semanticTurn: null,
    streamPhase: 'submitting',
    streamPhasePendingToolName: null,
    streamPhasePendingToolUseId: null,
  })

  const afterHistory = deriveFeedRenderModel({
    provider: 'codex',
    entries: [userEntry('race-user', 'prompt visible before semantic history arrives')],
    semanticHistory: [archived],
    semanticTurn: null,
    streamPhase: 'submitting',
    streamPhasePendingToolName: null,
    streamPhasePendingToolUseId: null,
  })

  assert.deepEqual(
    beforeHistory.items.map(item => item.type),
    ['entry', 'work'],
    'optimistic prompt must render while submit is still waiting for semantic catch-up',
  )
  assert.deepEqual(
    afterHistory.items.map(item => item.type),
    ['semantic-history', 'entry', 'work'],
    'late-arriving history must insert above the already-rendered newer prompt, not below it',
  )
}

{
  const answerText =
    'Yes. Electron does not support window.prompt, so the AI Workspace dialog needs a real app UI.'
  const webSearchItemId = 'ws_06c0839c0d254157016a09ae03afd48191b67160fc3df8c70a'
  const committedSearch = {
    ...assistantEntry('committed-search', ''),
    uuid: '2026-05-17T12:01:20.152Z:web_search_call',
    codexTurnId: '019e35ce-0fd1-7ee0-8782-e8eb1761b4d0',
    message: {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: webSearchItemId,
          name: 'web_search',
          input: {
            description: 'Search: Electron window.prompt is not supported',
          },
        },
      ],
    },
  } as Entry
  const committedAnswer = {
    ...assistantEntry('committed-answer', answerText),
    uuid: '2026-05-17T12:01:59.784Z:message',
    codexTurnId: '019e35ce-0fd1-7ee0-8782-e8eb1761b4d0',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: answerText }],
    },
  } as Entry
  const committedToolUseIndex = new Map<string, ToolUseBlock>([
    [
      webSearchItemId,
      {
        type: 'tool_use',
        id: webSearchItemId,
        name: 'web_search',
        input: { description: 'Search: Electron window.prompt is not supported' },
      },
    ],
  ])

  const model = deriveFeedRenderModel({
    provider: 'codex',
    entries: [committedSearch, committedAnswer],
    semanticHistory: [
      webSearchHistoryTurn(
        'resp_06c0839c0d254157016a09adf8a8a88191a829817928dfd789',
        webSearchItemId,
        answerText,
      ),
    ],
    semanticTurn: null,
    streamPhase: 'idle',
    streamPhasePendingToolName: null,
    streamPhasePendingToolUseId: null,
    committedToolUseIndex,
  })

  assert.equal(
    itemCount(model, 'semantic-history'),
    0,
    'committed web_search tool_use plus committed answer text must suppress the archived proxy web-search turn',
  )
  assert.deepEqual(
    model.debugRows.map(row => row.slot),
    ['entry', 'entry'],
    'stale web-search semantic history must not remain pinned at the bottom after rollout catch-up',
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

  assert.equal(hasItem(model, 'work'), true)
  assert.deepEqual(
    model.debugRows.map(row => row.slot),
    ['empty', 'work'],
    'work state must render independently even before committed or semantic content exists',
  )
}
