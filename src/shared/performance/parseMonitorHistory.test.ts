import { describe, expect, it } from 'vitest'
import { parseMonitorHistoryPoint, parseMonitorWorkerQueryResult } from './parseMonitorHistory.js'

const status = {
  state: 'healthy' as const, bytes: 128, oldestAt: 1, newestAt: 2,
  points: 2, incidents: 0, exporting: false, shortened: false,
}

describe('performance history trust boundary', () => {
  it('accepts the shutdown flush acknowledgement and rejects extra data', () => {
    expect(parseMonitorWorkerQueryResult({ kind: 'history-flush', value: true }))
      .toEqual({ kind: 'history-flush', value: true })
    expect(parseMonitorWorkerQueryResult({ kind: 'history-flush', value: true, path: '/private' }))
      .toBeNull()
  })

  it('rejects arbitrary fields in persisted metric points and paged results', () => {
    const point = {
      schemaVersion: 1 as const, at: 1, resolution: '1s' as const, main: null,
      processes: null, windows: { count: 0, visible: 0, maxLagMs: 0, longTaskMs: 0, maxInputMs: 0 },
      workerRss: 1, droppedRecords: 0, restarts: 0,
    }
    expect(parseMonitorHistoryPoint(point)).toEqual(point)
    expect(parseMonitorHistoryPoint({ ...point, prompt: 'private' })).toBeNull()
    expect(parseMonitorWorkerQueryResult({
      kind: 'history', value: {
        resolution: '1s', from: 1, to: 2, points: [{ ...point, path: '/private' }],
        incidents: [], nextCursor: null, complete: true, status,
      },
    })).toBeNull()
  })

  it('rejects a structurally bounded page that exceeds the transport byte ceiling', () => {
    const maximum = Number.MAX_SAFE_INTEGER
    const point = {
      schemaVersion: 1 as const, at: maximum, resolution: '1m' as const,
      main: { cpuPercent: maximum, rss: maximum, heapUsed: maximum, heapLimit: maximum,
        loopP99Ms: maximum, loopMaxMs: maximum, sleepGap: false },
      processes: { cpuPercent: maximum, memoryBytes: maximum, count: maximum,
        sessionCount: maximum, quality: 'warming-up' },
      windows: { count: maximum, visible: maximum, maxLagMs: maximum,
        longTaskMs: maximum, maxInputMs: maximum },
      workerRss: maximum, droppedRecords: maximum, restarts: maximum,
    }
    expect(parseMonitorWorkerQueryResult({ kind: 'history', value: {
      resolution: '1m', from: 0, to: maximum, points: Array.from({ length: 420 }, () => point),
      incidents: [], nextCursor: null, complete: true, status,
    } })).toBeNull()
  })
})
