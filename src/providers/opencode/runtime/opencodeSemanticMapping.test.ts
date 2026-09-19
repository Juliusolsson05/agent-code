import { describe, expect, it } from 'vitest'

import type { SemanticEvent } from 'opencode-headless'
import { mapOpenCodeSemanticEvent, OpenCodeBlockIndexTracker } from './semanticMapping'

// The contract this file pins: the adapter's translation produces EXACTLY
// the fields the shared renderer fold reads — numeric blockIndex (the fold
// drops events whose index is null), textSoFar/thinkingSoFar (the fold's
// preferred cumulative fields), partialJson/inputJsonSoFar (streaming tool
// input), inputJson+parsed (finalized tool input), and toolUseId aligned
// with the package's tool_result pairing key (blockId === part/call id).
//
// WHY this test does not import the fold itself: providers are compiled by
// tsconfig.node.json and the fold lives in the renderer project — composite
// tsc forbids the cross-import, and the fold's consumption of these exact
// field names is already pinned by the renderer's own fold tests. The drift
// risk this file guards is the MAPPING, not the fold.

// Optional tracker: most tests want a fresh one per event (field-shape
// assertions don't care about ordering); the ordering test passes a shared
// one to assert continuity.
const map = (
  ev: SemanticEvent,
  tracker: OpenCodeBlockIndexTracker = new OpenCodeBlockIndexTracker(),
): Record<string, unknown> => mapOpenCodeSemanticEvent(ev, tracker) as Record<string, unknown>

const TURN = { turnId: 'trn_1', source: 'opencode-sse' as const }

describe('opencode semantic mapping onto the fold vocabulary', () => {
  it('stamps stable block indexes in first-seen order', () => {
    const turn = new OpenCodeBlockIndexTracker()
    expect(map({ ...TURN, type: 'block_started', blockId: 'a', kind: 'text', ts: 1 } as never, turn)).toMatchObject({ blockIndex: 0 })
    expect(map({ ...TURN, type: 'block_started', blockId: 'b', kind: 'tool_use', ts: 2 } as never, turn)).toMatchObject({ blockIndex: 1 })
    // Same block keeps its index across the whole turn.
    expect(map({ ...TURN, type: 'text_delta', blockId: 'a', textDelta: 'x', fullText: 'x', ts: 3 } as never, turn)).toMatchObject({ blockIndex: 0 })
  })

  it('aligns tool_use fields with what the fold reads', () => {
    expect(map({ ...TURN, type: 'tool_input_delta', blockId: 'b', inputDelta: '{"x"', fullInput: '{"x"', name: 'Bash', ts: 1 } as never)).toMatchObject({
      blockIndex: 0,
      partialJson: '{"x"',
      inputJsonSoFar: '{"x"',
      toolName: 'Bash',
      toolUseId: 'b',
    })
    expect(map({ ...TURN, type: 'tool_input_finalized', blockId: 'b', input: { x: 1 }, name: 'Bash', ts: 2 } as never)).toMatchObject({
      inputJson: '{"x":1}',
      parsed: { x: 1 },
    })
    // A string input stays byte-identical JSON text.
    expect(map({ ...TURN, type: 'tool_input_finalized', blockId: 'c', input: '{"raw":true}', name: 'Bash', ts: 3 } as never)).toMatchObject({
      inputJson: '{"raw":true}',
    })
  })

  it('maps text and thinking deltas onto the cumulative fields the fold reads', () => {
    expect(map({ ...TURN, type: 'text_delta', blockId: 't', textDelta: 'Hel', fullText: 'Hello', ts: 1 } as never)).toMatchObject({
      blockIndex: 0,
      textDelta: 'Hel',
      textSoFar: 'Hello',
    })
    expect(map({ ...TURN, type: 'thinking_delta', blockId: 't', textDelta: 'thin', fullText: 'thinking', ts: 2 } as never)).toMatchObject({
      blockIndex: 0,
      thinkingDelta: 'thin',
      thinkingSoFar: 'thinking',
    })
  })

  it('carries toolUseId on block events so tool_results pair with their blocks', () => {
    // The fold's tool_result branch matches block.toolUseId ===
    // ev.toolUseId; the package keys both by the same part/call id.
    const started = map({ ...TURN, type: 'block_started', blockId: 'p_tool', kind: 'tool_use', name: 'Read', ts: 1 } as never)
    expect(started).toMatchObject({ toolUseId: 'p_tool', toolName: 'Read', blockIndex: 0 })
    const completed = map({ ...TURN, type: 'block_completed', blockId: 'p_tool', kind: 'tool_use', name: 'Read', ts: 2 } as never)
    expect(completed).toMatchObject({ toolUseId: 'p_tool', blockIndex: 0 })
  })

  it('passes non-block events through by reference (identity stability)', () => {
    const usage = { type: 'usage_updated', turnId: 'trn_1', usage: {}, source: 'opencode-sse', ts: 1 } as never
    expect(mapOpenCodeSemanticEvent(usage as SemanticEvent, new OpenCodeBlockIndexTracker())).toBe(usage)
  })

  it('bounds tracked turns', () => {
    const tracker = new OpenCodeBlockIndexTracker()
    for (let turn = 0; turn < 12; turn++) {
      tracker.indexFor(`turn-${turn}`, 'block')
    }
    // Old turns evicted; recent ones keep their assignments.
    expect((tracker as unknown as { turns: Map<string, unknown> }).turns.size).toBeLessThanOrEqual(8)
  })
})
