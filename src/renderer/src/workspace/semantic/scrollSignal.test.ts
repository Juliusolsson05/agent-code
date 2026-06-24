import { describe, expect, it } from 'vitest'

import { semanticTurnScrollSignal } from '@renderer/workspace/semantic/helpers'
import type {
  SemanticLiveBlock,
  SemanticLiveTurn,
} from '@renderer/workspace/workspaceState'

function block(partial: Partial<SemanticLiveBlock> & { blockIndex: number }): SemanticLiveBlock {
  return { kind: 'text', ...partial }
}

function turn(blocks: SemanticLiveBlock[], text = ''): SemanticLiveTurn {
  return {
    turnId: 't1',
    text,
    source: null,
    blocks: Object.fromEntries(blocks.map(b => [b.blockIndex, b])),
    blockOrder: blocks.map(b => b.blockIndex),
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
    startedAt: 0,
    endedAt: null,
  }
}

describe('semanticTurnScrollSignal', () => {
  it('changes when block text grows even though block count is unchanged', () => {
    const before = turn([block({ blockIndex: 0, text: 'hello' })])
    const after = turn([block({ blockIndex: 0, text: 'hello world' })])
    expect(semanticTurnScrollSignal(before)).not.toBe(semanticTurnScrollSignal(after))
  })

  it('changes when tool output (resultContent) grows', () => {
    const before = turn([block({ blockIndex: 0, kind: 'tool_use', resultContent: 'line1' })])
    const after = turn([block({ blockIndex: 0, kind: 'tool_use', resultContent: 'line1\nline2' })])
    expect(semanticTurnScrollSignal(before)).not.toBe(semanticTurnScrollSignal(after))
  })

  it('changes when streamed Codex output string grows', () => {
    const before = turn([block({ blockIndex: 0, kind: 'function_call_output', output: 'a' })])
    const after = turn([block({ blockIndex: 0, kind: 'function_call_output', output: 'ab' })])
    expect(semanticTurnScrollSignal(before)).not.toBe(semanticTurnScrollSignal(after))
  })

  it('changes when reasoning text grows', () => {
    const before = turn([block({ blockIndex: 0, kind: 'reasoning', reasoningText: 'x' })])
    const after = turn([block({ blockIndex: 0, kind: 'reasoning', reasoningText: 'xy' })])
    expect(semanticTurnScrollSignal(before)).not.toBe(semanticTurnScrollSignal(after))
  })

  it('changes when a block status transitions', () => {
    const before = turn([block({ blockIndex: 0, kind: 'function_call', status: 'in_progress' })])
    const after = turn([block({ blockIndex: 0, kind: 'function_call', status: 'completed' })])
    expect(semanticTurnScrollSignal(before)).not.toBe(semanticTurnScrollSignal(after))
  })

  it('is stable when nothing visible changed', () => {
    const a = turn([block({ blockIndex: 0, text: 'same' })])
    const b = turn([block({ blockIndex: 0, text: 'same' })])
    expect(semanticTurnScrollSignal(a)).toBe(semanticTurnScrollSignal(b))
  })
})
