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

  // #1352 review a: every legal (operation, outcome) pair must fit. The
  // aggregator, the snapshot parser and the history store each capped at a
  // literal 100, and 26 operations x 4 outcomes = 104 silently lost the last
  // four pairs.
  it('keeps a histogram for every legal operation and outcome, and the snapshot parses', async () => {
    const { MONITOR_OPERATIONS, MONITOR_OUTCOMES } = await import('@shared/performance/monitorPolicy.js')
    const { parseMonitorSnapshot } = await import('@shared/performance/parseMonitorSnapshot.js')
    const aggregator = new MonitorAggregator()
    for (const name of MONITOR_OPERATIONS) {
      for (const outcome of MONITOR_OUTCOMES) {
        aggregator.accept([{ kind: 'operation', at: 1000, windowId: null, sample: { kind: 'operation', name, outcome, durationMs: 5 } }])
      }
    }
    const snapshot = aggregator.snapshot(2000, 100)
    expect(snapshot.operations).toHaveLength(MONITOR_OPERATIONS.length * MONITOR_OUTCOMES.length)
    expect(snapshot.operations.map(entry => `${entry.name}:${entry.outcome}`)).toContain('heap.snapshot:timeout')
    expect(parseMonitorSnapshot(JSON.parse(JSON.stringify(snapshot)))).not.toBeNull()
  })
})

