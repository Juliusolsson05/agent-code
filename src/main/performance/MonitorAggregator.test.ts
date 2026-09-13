import { describe, expect, it } from 'vitest'
import { MonitorAggregator } from './MonitorAggregator.js'

describe('worker evidence bounds', () => {
  it('keeps recent queries bounded and aggregates sessions into a finite operation vocabulary', () => {
    const aggregator = new MonitorAggregator()
    for (let i = 0; i < 10000; i++) {
      aggregator.accept([
        { kind: 'main', sample: { at: i * 1000, rss: 1000, heapUsed: 100, heapLimit: 1000, cpuPercent: 1, loopMeanMs: 20, loopMaxMs: 22, loopP99Ms: 22, sleepGap: false } },
        { kind: 'operation', at: i * 1000, windowId: null, sample: { kind: 'operation', name: 'session.spawn', outcome: 'success', durationMs: i, sessionId: `session-${i}` } },
      ])
    }
    const snapshot = aggregator.snapshot(10000 * 1000, 100)
    expect(snapshot.recent).toHaveLength(120)
    expect(snapshot.operations).toHaveLength(1)
    expect(snapshot.operations[0].histogram.count).toBe(10000)
    expect(JSON.stringify(snapshot)).not.toContain('session-')
    expect(aggregator.snapshot(11000 * 1000, 100).recent).toEqual([])
  })
})
