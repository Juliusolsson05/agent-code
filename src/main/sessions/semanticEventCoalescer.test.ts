import { describe, expect, it, vi } from 'vitest'

import { SemanticEventIpcCoalescer } from './semanticEventCoalescer'

describe('SemanticEventIpcCoalescer', () => {
  it('crosses IPC once for a dense cumulative tool-input burst', () => {
    vi.useFakeTimers()
    const send = vi.fn()
    const coalescer = new SemanticEventIpcCoalescer(send, 100)

    for (let index = 1; index <= 1_000; index += 1) {
      coalescer.enqueue({
        sessionId: 'session-1',
        event: {
          type: 'tool_input_delta',
          turnId: 'turn-1',
          blockIndex: 0,
          toolUseId: 'tool-1',
          partialJson: 'x',
          inputJsonSoFar: 'x'.repeat(index),
        },
      })
    }

    expect(send).not.toHaveBeenCalled()
    vi.advanceTimersByTime(100)
    expect(send).toHaveBeenCalledOnce()
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      rawEventCount: 1_000,
      event: expect.objectContaining({ inputJsonSoFar: 'x'.repeat(1_000) }),
    }))
    vi.useRealTimers()
  })

  it('drains cumulative state before a structural ordering barrier', () => {
    const send = vi.fn()
    const coalescer = new SemanticEventIpcCoalescer(send, 100)
    coalescer.enqueue({
      sessionId: 'session-1',
      event: { type: 'text_delta', turnId: 'turn-1', blockIndex: 0, textSoFar: 'ready' },
    })
    coalescer.enqueue({
      sessionId: 'session-1',
      event: { type: 'turn_completed', turnId: 'turn-1' },
    })

    expect(send.mock.calls.map(call => (call[0].event as { type: string }).type)).toEqual([
      'text_delta',
      'turn_completed',
    ])
  })

  it('does not flush unrelated sessions at another session ordering barrier', () => {
    const send = vi.fn()
    const coalescer = new SemanticEventIpcCoalescer(send, 100)
    coalescer.enqueue({
      sessionId: 'session-a',
      event: { type: 'text_delta', turnId: 'turn-a', textSoFar: 'a' },
    })
    coalescer.enqueue({
      sessionId: 'session-b',
      event: { type: 'text_delta', turnId: 'turn-b', textSoFar: 'b' },
    })
    coalescer.enqueue({
      sessionId: 'session-a',
      event: { type: 'turn_completed', turnId: 'turn-a' },
    })

    expect(send.mock.calls.map(call => call[0].sessionId)).toEqual([
      'session-a',
      'session-a',
    ])
    coalescer.flush('session-b')
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({
      sessionId: 'session-b',
    }))
  })
})
