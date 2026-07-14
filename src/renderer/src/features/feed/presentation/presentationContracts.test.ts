import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import type { Entry, ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'

import type { FeedRenderItem } from '@renderer/features/feed/model/renderModel'
import { projectFeedPresentation } from '@renderer/features/feed/presentation/projectFeed'
import { classifyOperation } from '@renderer/features/feed/presentation/classifyOperation'
import type { OperationFamily } from '@renderer/features/feed/presentation/types'

const ORDER = {
  phase: 'content' as const,
  timeMs: 1,
  sequence: 1,
  source: 'presentation-contract-test',
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

function operationNodes(items: readonly FeedRenderItem[], tools: readonly ToolUseBlock[] = []) {
  return projectFeedPresentation({
    items,
    provider: 'claude',
    toolUseIndex: new Map(tools.map(tool => [tool.id, tool])),
    toolResultIndex: new Map(),
  }).nodes.filter(node => node.kind === 'operation')
}

describe('feed presentation lifecycle contracts', () => {
  it('classifies the shared cross-provider fixture through the production classifier', () => {
    const fixture = JSON.parse(
      readFileSync(
        resolve(process.cwd(), 'testing/fixtures/feed-presentation/operation-families.json'),
        'utf8',
      ),
    ) as {
      operations: Array<{
        provider: 'claude' | 'codex' | 'opencode'
        expectedFamily: OperationFamily
        id?: string
        callId?: string
        callID?: string
        toolUseId?: string
        name?: string
        tool?: string
        toolName?: string
        type?: string
        stage?: string
        input?: unknown
        argumentsJson?: string
        inputJsonSoFar?: string
        state?: { input?: unknown }
      }>
    }

    for (const operation of fixture.operations) {
      const id = operation.id ?? operation.callId ?? operation.callID ?? operation.toolUseId
      if (!id) throw new Error('fixture operation lacks an id')
      const input = operation.input ?? operation.state?.input
      const rawInput =
        operation.inputJsonSoFar ??
        operation.argumentsJson ??
        (typeof input === 'string' ? input : null)
      const family = classifyOperation({
        provider: operation.provider,
        toolName: operation.name ?? operation.tool ?? operation.toolName ?? '',
        rawInput,
        finalized: operation.type !== 'tool_input_delta',
      }).family
      expect(family, id).toBe(operation.expectedFamily)
    }

    // The fixture is the executable cross-provider taxonomy, so a new family
    // cannot quietly exist only in the TypeScript union while every evidence
    // audit and UI contract continues to miss it. Keep this explicit list next
    // to the test: changing the product vocabulary should be a visible review
    // event, while individual expectations remain owned by the fixture rows.
    const requiredFamilies: OperationFamily[] = [
      'preparing',
      'file-change',
      'command',
      'terminal-interaction',
      'read',
      'search',
      'web',
      'collaboration',
      'task-plan',
      'question',
      'mcp',
      'image',
      'notebook',
      'code-intelligence',
      'skill-workflow',
      'workspace',
      'generic',
    ]
    expect([...new Set(fixture.operations.map(operation => operation.expectedFamily))].sort()).toEqual(
      [...requiredFamilies].sort(),
    )
  })

  it('uses the provider correlation id across the live-to-committed hand-off', () => {
    // The transport owner changes at commit time, but the user is still
    // watching one edit. This assertion deliberately compares two independent
    // projections: identity must come from provider correlation, not object
    // reuse or an in-memory merge that a restored transcript cannot reproduce.
    const partialScript =
      'const patch = "*** Begin Patch\\n*** Update File: src/feed.ts\\n@@\\n-old\\n+new\\n'
    const live: FeedRenderItem = {
      type: 'semantic-block',
      key: 'semantic:edit-live',
      turnId: 'turn-1',
      owner: 'semantic-current',
      block: {
        blockIndex: 0,
        kind: 'function_call',
        toolName: 'exec',
        callId: 'call-edit-1',
        argumentsJson: partialScript,
        finalized: false,
      },
      toolState: null,
      order: ORDER,
    }
    const committedTool: ToolUseBlock = {
      type: 'tool_use',
      id: 'call-edit-1',
      name: 'exec',
      input: { raw: `${partialScript}"; await tools.apply_patch(patch);` },
    }
    const committed = entryItem(
      conversation('assistant-edit', 'assistant', [committedTool]),
      0,
    )

    const liveNode = projectFeedPresentation({
      items: [live],
      provider: 'codex',
      toolUseIndex: new Map(),
      toolResultIndex: new Map(),
    }).nodes[0]
    const committedNode = projectFeedPresentation({
      items: [committed],
      provider: 'codex',
      toolUseIndex: new Map([[committedTool.id, committedTool]]),
      toolResultIndex: new Map(),
    }).nodes[0]

    expect(liveNode).toMatchObject({
      id: 'operation:codex:call-edit-1',
      kind: 'operation',
      operation: { family: 'file-change' },
    })
    expect(committedNode).toMatchObject({
      id: liveNode?.id,
      kind: 'operation',
      operation: { family: 'file-change' },
    })
  })

  it('absorbs a paired tool result into its operation exactly once', () => {
    const tool: ToolUseBlock = {
      type: 'tool_use',
      id: 'command-1',
      name: 'Bash',
      input: { command: 'npm test' },
    }
    const result: ToolResultBlock = {
      type: 'tool_result',
      tool_use_id: tool.id,
      content: 'all tests passed',
    }
    const useItem = entryItem(conversation('assistant-command', 'assistant', [tool]), 0)
    const resultItem = entryItem(conversation('user-result', 'user', [result]), 1)

    const projection = projectFeedPresentation({
      items: [useItem, resultItem],
      provider: 'claude',
      toolUseIndex: new Map([[tool.id, tool]]),
      toolResultIndex: new Map([[tool.id, result]]),
    })

    expect(projection.nodes).toHaveLength(1)
    expect(projection.nodes[0]).toMatchObject({
      id: 'operation:claude:command-1',
      kind: 'operation',
      operation: { committedResult: result },
    })
    expect(projection.receipts).toEqual([
      expect.objectContaining({
        sourceKey: useItem.key,
        disposition: 'painted',
        targetIds: ['operation:claude:command-1'],
      }),
      expect.objectContaining({
        sourceKey: resultItem.key,
        disposition: 'absorbed',
        targetIds: ['operation:claude:command-1'],
      }),
    ])
  })

  it('keeps MCP, collaboration, task, and question operations visible', () => {
    // These are deliberately long-tail tools rather than the familiar command
    // and edit cards. The projector's totality contract matters most here: a
    // new structured renderer may be plain, but it may never silently drop an
    // operation just because its provider vocabulary is less common.
    const tools: ToolUseBlock[] = [
      {
        type: 'tool_use',
        id: 'mcp-1',
        name: 'mcp__docs__lookup',
        input: { query: 'feed contract' },
      },
      {
        type: 'tool_use',
        id: 'collaboration-1',
        name: 'send_message',
        input: { target: 'renderer-audit', message: 'check the fixtures' },
      },
      {
        type: 'tool_use',
        id: 'task-1',
        name: 'update_plan',
        input: { explanation: 'projection complete' },
      },
      {
        type: 'tool_use',
        id: 'question-1',
        name: 'request_user_input',
        input: {
          questions: [{ question: 'Choose a renderer', header: 'Renderer', options: [] }],
        },
      },
    ]
    const items = tools.map((tool, index) =>
      entryItem(conversation(`assistant-${tool.id}`, 'assistant', [tool]), index),
    )

    const nodes = operationNodes(items, tools)

    expect(nodes).toHaveLength(4)
    expect(nodes.map(node => [node.operation.toolName, node.operation.family])).toEqual([
      ['mcp__docs__lookup', 'mcp'],
      ['send_message', 'collaboration'],
      ['update_plan', 'task-plan'],
      ['request_user_input', 'question'],
    ])
    expect(nodes.every(node => node.sourceKeys.length > 0)).toBe(true)
  })
})
