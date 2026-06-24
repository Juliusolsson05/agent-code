import { describe, expect, it } from 'vitest'

import { indexEntryIntoMaps } from '@renderer/workspace/entries/utils'
import type {
  Entry,
  ToolResultBlock,
  ToolUseBlock,
} from '@shared/types/transcript'

function assistantWithToolUse(uuid: string, toolUseId: string): Entry {
  return {
    type: 'assistant',
    uuid,
    parentUuid: null,
    message: {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: toolUseId, name: 'Bash', input: { command: 'git status' } },
      ],
    },
  } as Entry
}

function userWithToolResult(uuid: string, toolUseId: string, text: string): Entry {
  return {
    type: 'user',
    uuid,
    parentUuid: null,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text }],
    },
  } as Entry
}

describe('indexEntryIntoMaps', () => {
  it('reports a change when a new tool_use is inserted', () => {
    const useIndex = new Map<string, ToolUseBlock>()
    const resultIndex = new Map<string, ToolResultBlock>()
    expect(
      indexEntryIntoMaps(assistantWithToolUse('a', 'tu-1'), useIndex, resultIndex),
    ).toBe(true)
    expect(useIndex.has('tu-1')).toBe(true)
  })

  it('reports a change when a tool_result lands in a later entry (the cross-entry case)', () => {
    const useIndex = new Map<string, ToolUseBlock>()
    const resultIndex = new Map<string, ToolResultBlock>()
    indexEntryIntoMaps(assistantWithToolUse('a', 'tu-1'), useIndex, resultIndex)
    // A separate, later entry carries the paired result. This is exactly the
    // case that left a mounted GitCardRow stale before the version token.
    expect(
      indexEntryIntoMaps(userWithToolResult('b', 'tu-1', 'clean'), useIndex, resultIndex),
    ).toBe(true)
    expect(resultIndex.get('tu-1')?.content).toBe('clean')
  })

  it('reports NO change when the identical block reference is re-indexed', () => {
    const useIndex = new Map<string, ToolUseBlock>()
    const resultIndex = new Map<string, ToolResultBlock>()
    const entry = assistantWithToolUse('a', 'tu-1')
    expect(indexEntryIntoMaps(entry, useIndex, resultIndex)).toBe(true)
    // Re-ingesting the SAME entry object (duplicate burst replay) must not bump
    // the version — otherwise bootstrap re-delivery would invalidate context.
    expect(indexEntryIntoMaps(entry, useIndex, resultIndex)).toBe(false)
  })

  it('reports NO change for an entry with no tool blocks', () => {
    const useIndex = new Map<string, ToolUseBlock>()
    const resultIndex = new Map<string, ToolResultBlock>()
    const textOnly = {
      type: 'assistant',
      uuid: 'a',
      parentUuid: null,
      message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    } as Entry
    expect(indexEntryIntoMaps(textOnly, useIndex, resultIndex)).toBe(false)
  })

  it('reports a change when an existing key is re-pointed to a different block', () => {
    const useIndex = new Map<string, ToolUseBlock>()
    const resultIndex = new Map<string, ToolResultBlock>()
    indexEntryIntoMaps(userWithToolResult('b', 'tu-1', 'running'), useIndex, resultIndex)
    // Same tool_use_id, fresh block object with updated content → must report a
    // change so the row repaints with the final output.
    expect(
      indexEntryIntoMaps(userWithToolResult('c', 'tu-1', 'done'), useIndex, resultIndex),
    ).toBe(true)
    expect(resultIndex.get('tu-1')?.content).toBe('done')
  })
})
