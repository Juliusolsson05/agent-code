import { describe, expect, it, vi } from 'vitest'

import { LatestSessionIpcCoalescer } from './latestSessionIpcCoalescer'

describe('LatestSessionIpcCoalescer', () => {
  it('sends only the latest complete snapshot for each session', () => {
    vi.useFakeTimers()
    const send = vi.fn()
    const coalescer = new LatestSessionIpcCoalescer(send, 100)

    coalescer.enqueue({ sessionId: 'a', screen: 'old' })
    coalescer.enqueue({ sessionId: 'b', screen: 'other' })
    coalescer.enqueue({ sessionId: 'a', screen: 'new' })
    vi.advanceTimersByTime(100)

    expect(send.mock.calls.map(call => call[0])).toEqual([
      { sessionId: 'a', screen: 'new' },
      { sessionId: 'b', screen: 'other' },
    ])
    vi.useRealTimers()
  })

  it('yields between bounded groups of sessions', () => {
    vi.useFakeTimers()
    const send = vi.fn()
    const coalescer = new LatestSessionIpcCoalescer(send, 100, 2)
    for (const sessionId of ['a', 'b', 'c']) {
      coalescer.enqueue({ sessionId })
    }

    vi.advanceTimersByTime(100)
    expect(send).toHaveBeenCalledTimes(2)
    vi.runOnlyPendingTimers()
    expect(send).toHaveBeenCalledTimes(3)
    vi.useRealTimers()
  })
})
