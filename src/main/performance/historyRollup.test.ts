import { describe, expect, it } from 'vitest'
import type { MonitorHistoryPoint } from '@shared/performance/monitorHistory.js'
import { TierRollup } from './historyRollup.js'

const point = (at: number, loopMaxMs = 20): MonitorHistoryPoint => ({
  schemaVersion: 1, at, resolution: '1s',
  main: { cpuPercent: 1, rss: 1, heapUsed: 1, heapLimit: 2, loopP99Ms: loopMaxMs, loopMaxMs, sleepGap: false },
  processes: null,
  windows: { count: 0, visible: 0, maxLagMs: 0, longTaskMs: 0, maxInputMs: 0 },
  workerRss: 1, droppedRecords: 0, restarts: 0,
})

describe('tier rollups', () => {
  it('merges a wall-clock rollback into the open bucket instead of reopening a closed one', () => {
    const rollup = new TierRollup('10s')
    const emitted = [point(10_000), point(25_000), point(12_000, 700), point(31_000)]
      .map(sample => rollup.add(sample))
      .filter((row): row is MonitorHistoryPoint => row !== null)
    // Bucket 1 is written once; the rolled-back sample's 700 ms peak survives
    // inside the bucket that was open when it arrived.
    expect(emitted.map(row => row.at)).toEqual([10_000, 25_000])
    expect(emitted[1]!.main!.loopMaxMs).toBe(700)
  })

  it('starts a new bucket after a large backward clock step instead of hiding new samples', () => {
    const rollup = new TierRollup('10s')
    expect(rollup.add(point(3_600_000))).toBeNull()
    // An hour back: the open bucket is emitted and the new sample stays visible.
    expect(rollup.add(point(10_000))!.at).toBe(3_600_000)
    expect(rollup.peek()!.at).toBe(10_000)
  })
})
