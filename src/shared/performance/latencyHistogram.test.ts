import { describe, expect, it } from 'vitest'
import { LatencyHistogram, latencyQuantile } from './latencyHistogram'

describe('latency distribution', () => {
  it('weights busy windows by samples when rolling up percentiles', () => {
    const busy = new LatencyHistogram()
    for (let i = 0; i < 100; i++) busy.observe(5)
    const quiet = new LatencyHistogram()
    quiet.observe(1500)
    expect(busy.merge(quiet.snapshot())).toBe(true)
    expect(latencyQuantile(busy.snapshot(), 0.95)).toEqual({ upperBoundMs: 8, overflow: false })
    expect(busy.snapshot()).toMatchObject({ count: 101, sumMs: 2000, maxMs: 1500 })
  })

  it('marks unbounded and empty percentiles honestly', () => {
    const histogram = new LatencyHistogram()
    expect(latencyQuantile(histogram.snapshot(), 0.99)).toBeNull()
    histogram.observe(120_000)
    expect(latencyQuantile(histogram.snapshot(), 0.99)).toEqual({ upperBoundMs: null, overflow: true })
    histogram.observe(NaN)
    histogram.observe(-1)
    histogram.observe(Infinity)
    expect(histogram.snapshot().count).toBe(1)
  })

  it('rejects corrupted rollups without changing accumulated evidence', () => {
    const histogram = new LatencyHistogram()
    histogram.observe(50)
    const before = histogram.snapshot()
    expect(histogram.merge({ ...before, count: 100 })).toBe(false)
    expect(histogram.merge({ ...before, counts: [1] })).toBe(false)
    expect(histogram.snapshot()).toEqual(before)
    before.counts[0] = 400
    expect(histogram.snapshot().counts[0]).toBe(0)
    expect(latencyQuantile(histogram.snapshot(), 0)).toBeNull()
  })

  it('rejects sparse and fabricated empty windows without losing genuine samples', () => {
    const histogram = new LatencyHistogram()
    histogram.observe(50)
    const before = histogram.snapshot()
    const sparse = new Array(before.counts.length)
    sparse[0] = 1
    expect(histogram.merge(structuredClone({ counts: sparse, count: 1, sumMs: 1, maxMs: 1 }))).toBe(false)
    expect(histogram.merge({ counts: new Array(16), count: 0, sumMs: 0, maxMs: 0 })).toBe(false)
    expect(histogram.merge({ counts: Array(16).fill(0), count: 0, sumMs: 60000, maxMs: 60000 })).toBe(false)
    expect(histogram.merge({ ...before, maxMs: 60000 })).toBe(false)
    expect(histogram.snapshot()).toEqual(before)
    histogram.observe(5)
    expect(latencyQuantile(histogram.snapshot(), 0.95)).toEqual({ upperBoundMs: 50, overflow: false })
  })
})
