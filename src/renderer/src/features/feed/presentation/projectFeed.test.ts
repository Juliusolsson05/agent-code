import { describe, expect, it } from 'vitest'

import {
  isConversationEntry,
  type Entry,
  type ToolResultBlock,
  type ToolUseBlock,
} from '@shared/types/transcript'
import type { FeedRenderItem } from '@renderer/features/feed/model/renderModel'
import { classifyOperation } from '@renderer/features/feed/presentation/classifyOperation'
import { projectFeedPresentation } from '@renderer/features/feed/presentation/projectFeed'
import { mapCodexRolloutToFeedEntries } from '@providers/codex/renderer/transcript/rollout'

const ORDER = {
  phase: 'content' as const,
  timeMs: 1,
  sequence: 1,
  source: 'test',
}

function entryItem(entry: Entry, ordinal: number): FeedRenderItem {
  return {
    type: 'entry',
    key: `entry:${String(entry.uuid ?? ordinal)}`,
    entry,
    entryOrdinal: ordinal,
    visibleDecision: {
      key: `entry:${String(entry.uuid ?? ordinal)}`,
      entry,
      visible: true,
      reason: 'conversation',
    },
    order: { ...ORDER, sequence: ordinal },
  }
}

function conversation(
  uuid: string,
  role: 'user' | 'assistant',
  content: unknown,
): Entry {
  return {
    type: role,
    uuid,
    parentUuid: null,
    message: { role, content },
  } as Entry
}

describe('projectFeedPresentation', () => {
  it('gives a live and committed operation the same key and family', () => {
    const prefix =
      'const patch = "*** Begin Patch\\n*** Update File: src/a.ts\\n@@\\n-old\\n+new\\n'
    const live: FeedRenderItem = {
      type: 'semantic-block',
      key: 'sem:turn-1:block-0',
      turnId: 'turn-1',
      owner: 'semantic-current',
      block: {
        blockIndex: 0,
        kind: 'function_call',
        toolName: 'exec',
        callId: 'call_1',
        argumentsJson: prefix,
        finalized: false,
      },
      toolState: null,
      order: ORDER,
    }
    const toolUse: ToolUseBlock = {
      type: 'tool_use',
      id: 'call_1',
      name: 'exec',
      input: { raw: `${prefix}"; await tools.apply_patch(patch);` },
    }
    const committed = entryItem(
      conversation('assistant-1', 'assistant', [toolUse]),
      0,
    )

    const liveProjection = projectFeedPresentation({
      items: [live],
      provider: 'codex',
      toolUseIndex: new Map(),
      toolResultIndex: new Map(),
    })
    const committedProjection = projectFeedPresentation({
      items: [committed],
      provider: 'codex',
      toolUseIndex: new Map([['call_1', toolUse]]),
      toolResultIndex: new Map(),
    })

    expect(liveProjection.nodes).toHaveLength(1)
    expect(committedProjection.nodes).toHaveLength(1)
    expect(liveProjection.nodes[0]?.id).toBe('operation:codex:call_1')
    expect(committedProjection.nodes[0]?.id).toBe(liveProjection.nodes[0]?.id)
    expect(liveProjection.nodes[0]).toMatchObject({
      kind: 'operation',
      operation: { family: 'file-change', lifecycle: 'streaming' },
    })
    expect(committedProjection.nodes[0]).toMatchObject({
      kind: 'operation',
      operation: { family: 'file-change', lifecycle: 'running' },
    })
  })

  it('absorbs a paired result into one operation instead of painting it twice', () => {
    const toolUse: ToolUseBlock = {
      type: 'tool_use',
      id: 'tool_1',
      name: 'Bash',
      input: { command: 'npm test' },
    }
    const result: ToolResultBlock = {
      type: 'tool_result',
      tool_use_id: 'tool_1',
      content: '3 tests passed',
    }
    const items = [
      entryItem(conversation('a1', 'assistant', [toolUse]), 0),
      entryItem(conversation('u1', 'user', [result]), 1),
    ]
    const projection = projectFeedPresentation({
      items,
      provider: 'claude',
      toolUseIndex: new Map([['tool_1', toolUse]]),
      toolResultIndex: new Map([['tool_1', result]]),
    })

    expect(projection.nodes).toHaveLength(1)
    expect(projection.nodes[0]).toMatchObject({
      id: 'operation:claude:tool_1',
      kind: 'operation',
      operation: {
        family: 'command',
        committedResult: result,
      },
    })
    expect(projection.receipts).toEqual([
      expect.objectContaining({ disposition: 'painted', targetIds: ['operation:claude:tool_1'] }),
      expect.objectContaining({ disposition: 'absorbed', targetIds: ['operation:claude:tool_1'] }),
    ])
  })

  it('merges a separate Responses output item into its original call', () => {
    const call: FeedRenderItem = {
      type: 'semantic-block',
      key: 'sem:call',
      turnId: 'turn-1',
      owner: 'semantic-current',
      block: {
        blockIndex: 0,
        kind: 'function_call',
        toolName: 'exec_command',
        callId: 'call_2',
        argumentsJson: '{"cmd":"pwd"}',
        finalized: true,
      },
      toolState: null,
      order: ORDER,
    }
    const output: FeedRenderItem = {
      type: 'semantic-block',
      key: 'sem:output',
      turnId: 'turn-1',
      owner: 'semantic-current',
      block: {
        blockIndex: 1,
        kind: 'function_call_output',
        callId: 'call_2',
        output: '/workspace',
        finalized: true,
      },
      toolState: null,
      order: { ...ORDER, sequence: 2 },
    }
    const projection = projectFeedPresentation({
      items: [call, output],
      provider: 'codex',
      toolUseIndex: new Map(),
      toolResultIndex: new Map(),
    })

    expect(projection.nodes).toHaveLength(1)
    expect(projection.nodes[0]).toMatchObject({
      kind: 'operation',
      operation: {
        liveOutput: '/workspace',
        lifecycle: 'complete',
        // The output item resolves this call but must not become its source
        // payload: command/file/generic renderers still need the original args.
        liveBlock: {
          kind: 'function_call',
          argumentsJson: '{"cmd":"pwd"}',
        },
      },
    })
    expect(projection.receipts[1]).toMatchObject({
      disposition: 'absorbed',
      targetIds: ['operation:codex:call_2'],
    })
  })

  it('retains duplicate committed result events in source order without downgrading an error', () => {
    const toolUse: ToolUseBlock = {
      type: 'tool_use',
      id: 'patch-call-multi-result',
      name: 'apply_patch',
      input: { raw: '*** Begin Patch\n*** Update File: src/a.ts\n-old\n+new' },
    }
    const patchResult: ToolResultBlock = {
      type: 'tool_result',
      tool_use_id: toolUse.id,
      content: 'patch failed at src/a.ts',
      is_error: true,
      codex: {
        kind: 'patch_apply_end',
        success: false,
        files: ['src/a.ts'],
      },
    }
    const wrapperResult: ToolResultBlock = {
      type: 'tool_result',
      tool_use_id: toolUse.id,
      content: 'Script completed',
      is_error: false,
      codex: { kind: 'custom_tool_call_output' },
    }
    const items = [
      entryItem(conversation('patch-use', 'assistant', [toolUse]), 0),
      entryItem(conversation('patch-result', 'user', [patchResult]), 1),
      entryItem(conversation('wrapper-result', 'user', [wrapperResult]), 2),
    ]

    const projection = projectFeedPresentation({
      items,
      provider: 'codex',
      toolUseIndex: new Map([[toolUse.id, toolUse]]),
      // The runtime's singular index points at the latest result. The projector
      // must still recover the complete ordered event list from visible items.
      toolResultIndex: new Map([[toolUse.id, wrapperResult]]),
    })
    const node = projection.nodes[0]

    expect(node).toMatchObject({
      kind: 'operation',
      operation: {
        committedResults: [patchResult, wrapperResult],
        committedResult: patchResult,
        lifecycle: 'error',
      },
    })
    expect(projection.nodes).toHaveLength(1)
    expect(projection.receipts.slice(1).every(receipt =>
      receipt.disposition === 'absorbed' &&
      receipt.targetIds[0] === `operation:codex:${toolUse.id}`
    )).toBe(true)
  })

  it('retains every separate live output event, including string arrays', () => {
    const call: FeedRenderItem = {
      type: 'semantic-block',
      key: 'sem:multi-output-call',
      turnId: 'turn-multi-output',
      owner: 'semantic-current',
      block: {
        blockIndex: 0,
        kind: 'function_call',
        toolName: 'exec_command',
        callId: 'call_multi_output',
        argumentsJson: '{"cmd":"printf output"}',
        finalized: true,
      },
      toolState: null,
      order: ORDER,
    }
    const output = (
      key: string,
      blockIndex: number,
      value: unknown,
    ): FeedRenderItem => ({
      type: 'semantic-block',
      key,
      turnId: 'turn-multi-output',
      owner: 'semantic-current',
      block: {
        blockIndex,
        kind: 'function_call_output',
        callId: 'call_multi_output',
        output: value,
        finalized: true,
      },
      toolState: null,
      order: { ...ORDER, sequence: blockIndex + 1 },
    })
    const projection = projectFeedPresentation({
      items: [
        call,
        output('sem:multi-output-1', 1, ['first', 'second']),
        output('sem:multi-output-2', 2, 'third'),
      ],
      provider: 'codex',
      toolUseIndex: new Map(),
      toolResultIndex: new Map(),
    })

    expect(projection.nodes).toHaveLength(1)
    expect(projection.nodes[0]).toMatchObject({
      kind: 'operation',
      operation: {
        liveOutputs: [['first', 'second'], 'third'],
        liveOutput: 'third',
        lifecycle: 'complete',
      },
    })
  })

  it('joins real Codex tool-search call/output mappings into one operation', () => {
    const mapped = [
      ...mapCodexRolloutToFeedEntries({
        type: 'response_item',
        timestamp: '2026-07-12T11:13:00.000Z',
        payload: {
          type: 'tool_search_call',
          call_id: 'search-projector-1',
          execution: 'client',
          arguments: { query: 'feed rendering', limit: 2 },
        },
      }),
      ...mapCodexRolloutToFeedEntries({
        type: 'response_item',
        timestamp: '2026-07-12T11:13:01.000Z',
        payload: {
          type: 'tool_search_output',
          call_id: 'search-projector-1',
          execution: 'client',
          status: 'completed',
          tools: [{ name: 'mcp__docs__search' }],
        },
      }),
    ]
    expect(mapped).toHaveLength(2)
    const callEntry = mapped[0]
    const resultEntry = mapped[1]
    if (
      !callEntry ||
      !resultEntry ||
      !isConversationEntry(callEntry) ||
      !isConversationEntry(resultEntry) ||
      !Array.isArray(callEntry.message.content) ||
      !Array.isArray(resultEntry.message.content)
    ) {
      throw new Error('expected mapped tool-search call/result blocks')
    }
    const toolUse = callEntry.message.content[0] as ToolUseBlock
    const toolResult = resultEntry.message.content[0] as ToolResultBlock
    const projection = projectFeedPresentation({
      items: mapped.map((entry, index) => entryItem(entry, index)),
      provider: 'codex',
      toolUseIndex: new Map([[toolUse.id, toolUse]]),
      toolResultIndex: new Map([[toolResult.tool_use_id, toolResult]]),
    })

    expect(projection.nodes).toHaveLength(1)
    expect(projection.nodes[0]).toMatchObject({
      id: 'operation:codex:search-projector-1',
      kind: 'operation',
      operation: {
        family: 'search',
        lifecycle: 'complete',
        committedToolUse: {
          input: { query: 'feed rendering', limit: 2 },
        },
        committedResult: toolResult,
      },
    })
  })

  it('falls back for an unknown semantic kind even though every block has a text accumulator', () => {
    const unknown: FeedRenderItem = {
      type: 'semantic-block',
      key: 'sem:future-empty-text',
      turnId: 'turn-future',
      owner: 'semantic-current',
      block: {
        blockIndex: 0,
        kind: 'future_structured_item',
        // foldEvent initializes this on every block_started skeleton. It must not
        // trick the painter into classifying an unknown structure as empty text.
        text: '',
        finalized: false,
      },
      toolState: null,
      order: ORDER,
    }

    const projection = projectFeedPresentation({
      items: [unknown],
      provider: 'codex',
      toolUseIndex: new Map(),
      toolResultIndex: new Map(),
    })

    expect(projection.nodes[0]).toMatchObject({
      kind: 'fallback',
      label: 'future_structured_item',
    })
    expect(projection.receipts[0]).toMatchObject({
      disposition: 'fallback',
      targetIds: ['fallback:sem:future-empty-text'],
    })
  })

  it('preserves a citations-only known text block as visible message evidence', () => {
    const citationsOnly: FeedRenderItem = {
      type: 'semantic-block',
      key: 'sem:citations-only',
      turnId: 'turn-citations',
      owner: 'semantic-current',
      block: {
        blockIndex: 0,
        kind: 'message',
        text: '',
        citations: [{ url: 'https://example.test/source' }],
        finalized: true,
      },
      toolState: null,
      order: ORDER,
    }

    const projection = projectFeedPresentation({
      items: [citationsOnly],
      provider: 'codex',
      toolUseIndex: new Map(),
      toolResultIndex: new Map(),
    })

    expect(projection.nodes[0]).toMatchObject({
      kind: 'message',
      text: '',
      citations: [{ url: 'https://example.test/source' }],
    })
    expect(projection.receipts[0]?.disposition).toBe('painted')
  })

  it('accounts for every source item and visibly falls back for unknown blocks', () => {
    const unknown = entryItem(
      conversation('a-unknown', 'assistant', [{ type: 'future_provider_shape', answer: 42 }]),
      0,
    )
    const work: FeedRenderItem = {
      type: 'work',
      key: 'work:1',
      phase: 'thinking',
      toolName: null,
      toolUseId: null,
      order: { ...ORDER, phase: 'work', sequence: 2 },
    }
    const projection = projectFeedPresentation({
      items: [unknown, work],
      provider: 'claude',
      toolUseIndex: new Map(),
      toolResultIndex: new Map(),
    })

    expect(projection.receipts.map(receipt => receipt.sourceKey)).toEqual([
      unknown.key,
      work.key,
    ])
    expect(projection.receipts[0]?.disposition).toBe('fallback')
    expect(projection.nodes[0]).toMatchObject({
      kind: 'fallback',
      label: 'future_provider_shape',
    })
  })

  it('adds a sibling fleet header for adjacent spawns without nesting their identities', () => {
    const first: ToolUseBlock = {
      type: 'tool_use',
      id: 'spawn-1',
      name: 'Agent',
      input: { description: 'Inspect projection' },
    }
    const second: ToolUseBlock = {
      type: 'tool_use',
      id: 'spawn-2',
      name: 'Agent',
      input: { description: 'Inspect streaming' },
    }
    const item = entryItem(
      conversation('assistant-fanout', 'assistant', [first, second]),
      0,
    )
    const projection = projectFeedPresentation({
      items: [item],
      provider: 'claude',
      toolUseIndex: new Map([[first.id, first], [second.id, second]]),
      toolResultIndex: new Map(),
    })

    expect(projection.nodes.map(node => node.kind)).toEqual([
      'operation-group',
      'operation',
      'operation',
    ])
    expect(projection.nodes[0]).toMatchObject({
      kind: 'operation-group',
      operationIds: ['operation:claude:spawn-1', 'operation:claude:spawn-2'],
      toolUseIds: ['spawn-1', 'spawn-2'],
    })
    expect(projection.receipts[0]?.targetIds).toEqual([
      'operation:claude:spawn-1',
      'operation:claude:spawn-2',
      expect.stringMatching(/^operation-group:claude:/),
    ])
  })

  it('groups live sibling spawns only within the same semantic turn', () => {
    const liveSpawn = (callId: string, turnId: string, sequence: number): FeedRenderItem => ({
      type: 'semantic-block',
      key: `semantic:${callId}`,
      turnId,
      owner: 'semantic-current',
      block: {
        blockIndex: sequence,
        kind: 'function_call',
        toolName: 'spawn_agent',
        callId,
        argumentsJson: '{"message":"inspect"}',
        finalized: true,
      },
      toolState: null,
      order: { ...ORDER, sequence },
    })
    const projection = projectFeedPresentation({
      items: [
        liveSpawn('live-spawn-1', 'turn-fanout', 1),
        liveSpawn('live-spawn-2', 'turn-fanout', 2),
        liveSpawn('live-spawn-3', 'next-turn', 3),
      ],
      provider: 'codex',
      toolUseIndex: new Map(),
      toolResultIndex: new Map(),
    })

    expect(projection.nodes.filter(node => node.kind === 'operation-group')).toHaveLength(1)
    expect(projection.nodes.map(node => node.id)).toEqual([
      expect.stringMatching(/^operation-group:codex:turn:turn-fanout:/),
      'operation:codex:live-spawn-1',
      'operation:codex:live-spawn-2',
      'operation:codex:live-spawn-3',
    ])
  })

  it('folds provider completion evidence once into the operation lifecycle', () => {
    const codexComplete: ToolUseBlock = {
      type: 'tool_use',
      id: 'codex-complete',
      name: 'local_shell',
      input: { command: 'pwd', status: 'completed' },
    }
    const opencodeSealed: ToolUseBlock = {
      type: 'tool_use',
      id: 'opencode-sealed',
      name: 'read',
      input: { filePath: 'src/app.ts' },
    }
    const project = (provider: 'codex' | 'opencode', tool: ToolUseBlock) =>
      projectFeedPresentation({
        items: [entryItem(conversation(`entry-${tool.id}`, 'assistant', [tool]), 0)],
        provider,
        toolUseIndex: new Map([[tool.id, tool]]),
        toolResultIndex: new Map(),
      }).nodes[0]

    expect(project('codex', codexComplete)).toMatchObject({
      kind: 'operation',
      operation: { lifecycle: 'complete' },
    })
    expect(project('opencode', opencodeSealed)).toMatchObject({
      kind: 'operation',
      operation: { lifecycle: 'complete' },
    })
  })

  it('keeps streamed output running until explicit completion evidence arrives', () => {
    const delta: FeedRenderItem = {
      type: 'semantic-block',
      key: 'semantic:command-output-delta',
      turnId: 'turn-command-output',
      owner: 'semantic-current',
      block: {
        blockIndex: 0,
        kind: 'tool_use',
        toolName: 'Bash',
        toolUseId: 'command-output-delta',
        inputJson: '{"command":"long-running-command"}',
        finalized: true,
        resultContent: 'first stdout chunk',
      },
      toolState: {
        toolUseId: 'command-output-delta',
        blockIndex: 0,
        kind: 'tool_use',
        toolName: 'Bash',
        status: 'in_progress',
        inputJson: '{"command":"long-running-command"}',
        resultContent: 'first stdout chunk',
      },
      order: ORDER,
    }

    const node = projectFeedPresentation({
      items: [delta],
      provider: 'claude',
      toolUseIndex: new Map(),
      toolResultIndex: new Map(),
    }).nodes[0]

    expect(node).toMatchObject({
      kind: 'operation',
      operation: { lifecycle: 'running' },
    })
  })

  it('honors normalized terminal response-item status without a separate result', () => {
    const completed: FeedRenderItem = {
      type: 'semantic-block',
      key: 'semantic:web-search-completed',
      turnId: 'turn-web-search',
      owner: 'semantic-current',
      block: {
        blockIndex: 0,
        kind: 'web_search_call',
        itemId: 'web-search-completed',
        status: 'completed',
        finalized: true,
        webSearchAction: { kind: 'search', query: 'streaming lifecycle' },
      },
      toolState: null,
      order: ORDER,
    }

    const node = projectFeedPresentation({
      items: [completed],
      provider: 'codex',
      toolUseIndex: new Map(),
      toolResultIndex: new Map(),
    }).nodes[0]

    expect(node).toMatchObject({
      kind: 'operation',
      operation: { lifecycle: 'complete' },
    })
  })

  it('honors a typed image status even when the adapter did not mirror block.status', () => {
    // This is the exact shape used by the live ImageGen integration fixture:
    // upstream completion exists only inside imageGeneration. OperationVM owns
    // the badge, so losing this evidence there overrides ImageGenCard's correct
    // local status and leaves a completed image visibly spinning forever.
    const completed: FeedRenderItem = {
      type: 'semantic-block',
      key: 'semantic:image-generation-nested-complete',
      turnId: 'turn-image-generation-nested',
      owner: 'semantic-current',
      block: {
        blockIndex: 0,
        kind: 'image_generation_call',
        itemId: 'image-generation-nested-complete',
        finalized: true,
        imageGeneration: {
          status: 'completed',
          revisedPrompt: 'A completed image without mirrored status',
          result: 'a'.repeat(64),
        },
      },
      toolState: null,
      order: ORDER,
    }

    const node = projectFeedPresentation({
      items: [completed],
      provider: 'codex',
      toolUseIndex: new Map(),
      toolResultIndex: new Map(),
    }).nodes[0]

    expect(node).toMatchObject({
      kind: 'operation',
      operation: { lifecycle: 'complete' },
    })
  })
})

describe('classifyOperation', () => {
  it('keeps a command that merely searches for the patch marker out of file-change', () => {
    const classification = classifyOperation({
      provider: 'codex',
      toolName: 'exec',
      rawInput: 'await tools.exec_command({"cmd":"rg \'*** Begin Patch\' src"})',
      finalized: false,
    })
    expect(classification.family).toBe('command')
  })

  it('classifies non-terminal tools nested in unified exec before completion', () => {
    expect(classifyOperation({
      provider: 'codex',
      toolName: 'exec',
      rawInput: 'const result = await tools.update_plan({"plan":[]});',
      finalized: false,
    })).toMatchObject({
      family: 'task-plan',
      confidence: 'structural',
      displayToolName: 'update_plan',
      structuredInput: { plan: [] },
    })
  })

  it('classifies unified web orchestration by the nested call, not the exec envelope', () => {
    expect(classifyOperation({
      provider: 'codex',
      toolName: 'exec',
      rawInput: 'const result = await tools.web__run({"search_query":[{"q":"React streaming UI"}]});',
      finalized: false,
    })).toMatchObject({
      family: 'web',
      confidence: 'structural',
      displayToolName: 'web__run',
    })
  })

  it.each([
    ['mcp__agent_code__orchestration_create_agent', 'collaboration'],
    ['update_plan', 'task-plan'],
    ['request_user_input', 'question'],
    ['NotebookEdit', 'notebook'],
    ['LSP', 'code-intelligence'],
    ['mcp__linear__get_issue', 'mcp'],
  ] as const)('classifies %s as %s', (toolName, family) => {
    expect(classifyOperation({ provider: 'claude', toolName }).family).toBe(family)
  })
})
