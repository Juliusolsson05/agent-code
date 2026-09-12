import { describe, expect, it, vi } from 'vitest'

import { emptySemanticRuntime } from '@renderer/session-runtime/state'

import { foldSemanticEvent } from './foldEvent'

describe('foldSemanticEvent', () => {
  it('preserves finalized object input for OpenCode semantic tools', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-19T00:00:00.000Z'))

    let state = emptySemanticRuntime()
    state = foldSemanticEvent(state, {
      type: 'block_started',
      turnId: 'turn-oc-1',
      blockIndex: 0,
      kind: 'tool_use',
      toolName: 'read',
      toolUseId: 'oc-tool-1',
      source: 'opencode-sse',
      ts: 1,
    }, 'opencode')
    state = foldSemanticEvent(state, {
      type: 'tool_input_finalized',
      turnId: 'turn-oc-1',
      blockIndex: 0,
      toolName: 'read',
      toolUseId: 'oc-tool-1',
      input: { filePath: '/repo/src/example.ts', offset: 1, limit: 3 },
      source: 'opencode-sse',
      ts: 2,
    }, 'opencode')

    expect(state.currentTurn?.blocks[0]?.parsedInput).toEqual({
      filePath: '/repo/src/example.ts',
      offset: 1,
      limit: 3,
    })
    expect(state.currentTurn?.blocks[0]?.inputJson).toBe(
      '{"filePath":"/repo/src/example.ts","offset":1,"limit":3}',
    )

    vi.useRealTimers()
  })
})
