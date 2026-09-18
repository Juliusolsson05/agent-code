import { beforeEach, describe, expect, it } from 'vitest'

import { foldSemanticEvent } from '@renderer/session-runtime/semantic/foldEvent'
import { emptySemanticRuntime } from '@renderer/session-runtime/state'
import type { SemanticRuntimeState } from '@renderer/session-runtime/state'
import type { SemanticEvent } from 'opencode-headless'
import { mapOpenCodeSemanticEvent, OpenCodeBlockIndexTracker } from './semanticMapping'

// The contract this file pins: a structured-OpenCode turn's LIVE blocks —
// tool calls with streaming input, thinking, text — fold into the shared
// renderer fold, and tool results pair with their originating blocks.
// Before the mapping, every one of these events was silently DROPPED by
// the fold's `semanticToIndex(ev.blockIndex)` null check; the fixtures
// below mirror the exact shapes the package publishes (channels/types.ts).

// Fresh tracker per test: index assignment is turn-scoped first-seen
// order, so a shared module-level tracker would leak indexes across tests.
let tracker = new OpenCodeBlockIndexTracker()
const map = (ev: SemanticEvent): Record<string, unknown> =>
  mapOpenCodeSemanticEvent(ev, tracker) as Record<string, unknown>

beforeEach(() => {
  tracker = new OpenCodeBlockIndexTracker()
})

function foldAll(events: Array<Record<string, unknown>>): SemanticRuntimeState {
  let state = emptySemanticRuntime()
  for (const ev of events) state = foldSemanticEvent(state, ev as never, () => 0)
  return state
}

const TURN = 'trn_1'
const blockEvents: Array<Record<string, unknown>> = [
  { type: 'turn_started', turnId: TURN, source: 'opencode-sse', ts: 1 },
  map({ type: 'block_started', turnId: TURN, blockId: 'p_text', kind: 'text', source: 'opencode-sse', ts: 2 } as never),
  map({ type: 'text_delta', turnId: TURN, blockId: 'p_text', textDelta: 'Hel', fullText: 'Hel', source: 'opencode-sse', ts: 3 } as never),
  map({ type: 'text_delta', turnId: TURN, blockId: 'p_text', textDelta: 'lo', fullText: 'Hello', source: 'opencode-sse', ts: 4 } as never),
  map({ type: 'block_started', turnId: TURN, blockId: 'p_tool', kind: 'tool_use', name: 'Read', source: 'opencode-sse', ts: 5 } as never),
  map({ type: 'tool_input_delta', turnId: TURN, blockId: 'p_tool', inputDelta: '{"pa', fullInput: '{"pa', name: 'Read', source: 'opencode-sse', ts: 6 } as never),
  map({ type: 'tool_input_delta', turnId: TURN, blockId: 'p_tool', inputDelta: 'th":1}', fullInput: '{"path":1}', name: 'Read', source: 'opencode-sse', ts: 7 } as never),
  map({ type: 'tool_input_finalized', turnId: TURN, blockId: 'p_tool', input: { path: 1 }, name: 'Read', source: 'opencode-sse', ts: 8 } as never),
  map({ type: 'block_completed', turnId: TURN, blockId: 'p_tool', kind: 'tool_use', name: 'Read', source: 'opencode-sse', ts: 9 } as never),
  { type: 'tool_result', turnId: TURN, toolUseId: 'p_tool', name: 'Read', content: 'file body', isError: false, source: 'opencode-sse', ts: 10 },
]

describe('opencode semantic mapping onto the fold vocabulary', () => {
  it('stamps stable block indexes in first-seen order', () => {
    expect(map({ type: 'block_started', turnId: 't', blockId: 'a', kind: 'text', source: 'opencode-sse', ts: 1 } as never)).toMatchObject({ blockIndex: 0 })
    expect(map({ type: 'block_started', turnId: 't', blockId: 'b', kind: 'tool_use', source: 'opencode-sse', ts: 2 } as never)).toMatchObject({ blockIndex: 1 })
    // Same block keeps its index across the whole turn.
    expect(map({ type: 'text_delta', turnId: 't', blockId: 'a', textDelta: 'x', fullText: 'x', source: 'opencode-sse', ts: 3 } as never)).toMatchObject({ blockIndex: 0 })
  })

  it('aligns tool_use fields with what the fold reads', () => {
    expect(map({ type: 'tool_input_delta', turnId: 't', blockId: 'b', inputDelta: '{"x"', fullInput: '{"x"', name: 'Bash', source: 'opencode-sse', ts: 1 } as never)).toMatchObject({
      blockIndex: 0,
      partialJson: '{"x"',
      inputJsonSoFar: '{"x"',
      toolName: 'Bash',
      toolUseId: 'b',
    })
    expect(map({ type: 'tool_input_finalized', turnId: 't', blockId: 'b', input: { x: 1 }, name: 'Bash', source: 'opencode-sse', ts: 2 } as never)).toMatchObject({
      inputJson: '{"x":1}',
      parsed: { x: 1 },
    })
  })

  it('lets a full structured turn fold: text, live tool input, paired result', () => {
    const state = foldAll(blockEvents)
    const turn = state.currentTurn
    expect(turn).not.toBeNull()
    const blocks = Object.values(turn!.blocks)
    const text = blocks.find(b => b.text === 'Hello')
    expect(text).toBeTruthy()
    const tool = blocks.find(b => b.toolName === 'Read')
    expect(tool).toMatchObject({
      inputJson: '{"path":1}',
      parsedInput: { path: 1 },
      // The pairing the fold's tool_result match performs — previously
      // impossible because blocks never carried a toolUseId.
      resultContent: 'file body',
      resultIsError: false,
    })
  })

  it('passes non-block events through by reference (identity stability)', () => {
    const usage = { type: 'usage_updated', turnId: TURN, usage: {}, source: 'opencode-sse', ts: 1 } as never
    expect(mapOpenCodeSemanticEvent(usage as SemanticEvent, tracker)).toBe(usage)
  })
})
