import { describe, expect, it } from 'vitest'

import { SemanticEventBackpressureQueue } from './semanticEventBackpressure'

describe('SemanticEventBackpressureQueue', () => {
  it('collapses a cumulative tool-input burst to its latest complete snapshot', () => {
    const queue = new SemanticEventBackpressureQueue()

    for (let index = 1; index <= 1_000; index += 1) {
      expect(queue.tryPush({
        sessionId: 's1',
        event: {
          type: 'tool_input_delta',
          turnId: 'turn-1',
          blockIndex: 2,
          toolUseId: 'tool-1',
          partialJson: 'x',
          inputJsonSoFar: 'x'.repeat(index),
          ts: index,
        },
      })).toBe(true)
    }

    const drained = queue.drain()
    expect(drained).toHaveLength(1)
    expect(drained[0]?.rawEventCount).toBe(1_000)
    expect(drained[0]?.message.event).toMatchObject({
      inputJsonSoFar: 'x'.repeat(1_000),
      ts: 1_000,
    })
  })

  it('losslessly joins fragment-only tool output until a structural boundary', () => {
    const queue = new SemanticEventBackpressureQueue()

    queue.tryPush({
      sessionId: 's1',
      event: { type: 'tool_output_delta', callId: 'call-1', textDelta: 'hel' },
    })
    queue.tryPush({
      sessionId: 's1',
      event: { type: 'tool_output_delta', callId: 'call-1', textDelta: 'lo' },
    })

    expect(queue.drain()).toEqual([
      {
        message: {
          sessionId: 's1',
          event: { type: 'tool_output_delta', callId: 'call-1', textDelta: 'hello' },
        },
        rawEventCount: 2,
      },
    ])
  })

  it('canonicalizes OpenCode cumulative field names for the shared renderer fold', () => {
    const queue = new SemanticEventBackpressureQueue()

    queue.tryPush({
      sessionId: 'open-1',
      event: {
        type: 'thinking_delta',
        turnId: 'turn-1',
        blockId: 'reasoning-1',
        textDelta: 'a',
        fullText: 'a',
      },
    })
    queue.tryPush({
      sessionId: 'open-1',
      event: {
        type: 'thinking_delta',
        turnId: 'turn-1',
        blockId: 'reasoning-1',
        textDelta: 'b',
        fullText: 'ab',
      },
    })

    expect(queue.drain()[0]?.message.event).toMatchObject({
      textDelta: 'b',
      fullText: 'ab',
      thinkingSoFar: 'ab',
    })
  })

  it('never admits structural events and keeps independent semantic owners separate', () => {
    const queue = new SemanticEventBackpressureQueue()

    expect(queue.tryPush({
      sessionId: 's1',
      event: { type: 'turn_completed', turnId: 'turn-1' },
    })).toBe(false)
    queue.tryPush({
      sessionId: 's1',
      event: { type: 'text_delta', turnId: 'turn-1', blockIndex: 0, textSoFar: 'a' },
    })
    queue.tryPush({
      sessionId: 's1',
      event: { type: 'text_delta', turnId: 'turn-1', blockIndex: 1, textSoFar: 'b' },
    })
    queue.tryPush({
      sessionId: 's2',
      event: { type: 'text_delta', turnId: 'turn-1', blockIndex: 0, textSoFar: 'c' },
    })

    expect(queue.drain().map(item => item.message)).toEqual([
      {
        sessionId: 's1',
        event: { type: 'text_delta', turnId: 'turn-1', blockIndex: 0, textSoFar: 'a' },
      },
      {
        sessionId: 's1',
        event: { type: 'text_delta', turnId: 'turn-1', blockIndex: 1, textSoFar: 'b' },
      },
      {
        sessionId: 's2',
        event: { type: 'text_delta', turnId: 'turn-1', blockIndex: 0, textSoFar: 'c' },
      },
    ])
    expect(queue.size).toBe(0)
  })
})
