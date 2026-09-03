import { describe, expect, it } from 'vitest'

import { countPendingFeedDebug, decideFeedDebugFlush } from './feedDebugFlushPolicy'

// #748: appends must be paced by time, not by runtimes replacements.

describe('decideFeedDebugFlush', () => {
  const base = { intervalMs: 1_000, maxPending: 10, inFlight: false }

  it('flushes the first batch immediately and again once the interval has elapsed', () => {
    expect(decideFeedDebugFlush({ ...base, pendingCount: 1, lastAttemptAt: null, now: 5_000 })).toEqual({ kind: 'now' })
    expect(decideFeedDebugFlush({ ...base, pendingCount: 1, lastAttemptAt: 4_000, now: 5_000 })).toEqual({ kind: 'now' })
  })

  it('waits out the remainder of the interval for entries that follow a flush', () => {
    expect(decideFeedDebugFlush({ ...base, pendingCount: 3, lastAttemptAt: 4_700, now: 5_000 })).toEqual({
      kind: 'wait',
      delayMs: 700,
    })
  })

  it('forces a flush at the pending ceiling even inside the interval', () => {
    expect(decideFeedDebugFlush({ ...base, pendingCount: 10, lastAttemptAt: 4_900, now: 5_000 })).toEqual({ kind: 'now' })
  })

  it('does nothing while an append is unresolved or when nothing is pending', () => {
    expect(decideFeedDebugFlush({ ...base, pendingCount: 50, lastAttemptAt: null, now: 5_000, inFlight: true })).toEqual({
      kind: 'none',
    })
    expect(decideFeedDebugFlush({ ...base, pendingCount: 0, lastAttemptAt: null, now: 5_000 })).toEqual({ kind: 'none' })
  })
})

describe('countPendingFeedDebug', () => {
  it('counts only the tail newer than the persisted cursor', () => {
    const log = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }]
    expect(countPendingFeedDebug(log, 0)).toBe(4)
    expect(countPendingFeedDebug(log, 2)).toBe(2)
    expect(countPendingFeedDebug(log, 4)).toBe(0)
    expect(countPendingFeedDebug([], 0)).toBe(0)
  })
})
