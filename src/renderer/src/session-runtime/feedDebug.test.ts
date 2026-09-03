import { describe, expect, it } from 'vitest'

import {
  FEED_DEBUG_LOG_MAX_BYTES,
  appendFeedDebugLog,
  estimateFeedDebugLogBytes,
} from '@renderer/session-runtime/feedDebug'
import { emptyRuntime } from '@renderer/session-runtime/state'
import type { SessionRuntime } from '@renderer/session-runtime/state'

function appendMany(
  runtime: SessionRuntime,
  count: number,
  data?: () => unknown,
): SessionRuntime {
  let next = runtime
  for (let i = 0; i < count; i += 1) {
    next = appendFeedDebugLog(next, {
      layer: 'RENDER',
      kind: 'visible_rows',
      summary: `rows ${i}`,
      data: data?.(),
    })
  }
  return next
}

// The #722 shape: one record per feed item, hundreds of KB per entry.
function largeRows(bytes: number): unknown {
  return { rows: 'x'.repeat(bytes) }
}

describe('appendFeedDebugLog', () => {
  it('keeps the newest 500 entries with monotonic ids', () => {
    const runtime = appendMany(emptyRuntime(), 520)

    expect(runtime.feedDebugLog).toHaveLength(500)
    expect(runtime.feedDebugLog[0]?.id).toBe(21)
    expect(runtime.feedDebugLog.at(-1)?.id).toBe(520)
    expect(runtime.feedDebugNextId).toBe(521)
  })

  it('never lets the byte rule evict small entries', () => {
    const runtime = appendMany(emptyRuntime(), 500, () => ({ small: true }))

    // A full ring of small records must sit far under the budget, so the
    // count cap — not the byte rule — is what decides the length here.
    expect(runtime.feedDebugLog).toHaveLength(500)
    const bytes = estimateFeedDebugLogBytes(runtime.feedDebugLog)
    expect(bytes).toBeGreaterThan(500 * 40)
    expect(bytes).toBeLessThan(FEED_DEBUG_LOG_MAX_BYTES / 8)
  })

  it('evicts the oldest entries once the estimated bytes exceed the budget', () => {
    // 300 KB records, as Feed emits for a ~2k-entry transcript. 500 of them
    // would be ~150 MB; the budget must hold the ring near 4 MiB instead.
    const runtime = appendMany(emptyRuntime(), 60, () => largeRows(300 * 1024))

    const bytes = estimateFeedDebugLogBytes(runtime.feedDebugLog)
    expect(bytes).toBeLessThanOrEqual(FEED_DEBUG_LOG_MAX_BYTES)
    // Minimal eviction: one more record would not have fit, so nothing was
    // dropped that the budget could have kept.
    expect(bytes + 300 * 1024).toBeGreaterThan(FEED_DEBUG_LOG_MAX_BYTES)
    expect(runtime.feedDebugLog.length).toBeLessThan(60)
    expect(runtime.feedDebugLog.length).toBeGreaterThan(0)
    // Eviction takes the head: the retained ids are the newest, contiguous.
    const ids = runtime.feedDebugLog.map(entry => entry.id)
    expect(ids.at(-1)).toBe(60)
    expect(ids).toEqual(ids.map((_, index) => ids[0]! + index))
    // The id counter is unaffected by eviction — persistence keys off it.
    expect(runtime.feedDebugNextId).toBe(61)
  })

  it('keeps the newest entry even when it alone exceeds the budget', () => {
    const warmed = appendMany(emptyRuntime(), 5, () => ({ small: true }))
    const runtime = appendFeedDebugLog(warmed, {
      layer: 'RENDER',
      kind: 'visible_rows',
      summary: 'oversized',
      data: largeRows(FEED_DEBUG_LOG_MAX_BYTES + 1024),
    })

    expect(runtime.feedDebugLog).toHaveLength(1)
    expect(runtime.feedDebugLog[0]?.summary).toBe('oversized')

    // The oversized record is the first casualty of the next append.
    const after = appendFeedDebugLog(runtime, {
      layer: 'STATE',
      kind: 'screen_update',
      summary: 'small again',
      data: { small: true },
    })
    expect(after.feedDebugLog).toHaveLength(1)
    expect(after.feedDebugLog[0]?.summary).toBe('small again')
  })
})
