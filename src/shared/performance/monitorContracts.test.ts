import { describe, expect, it } from 'vitest'
import { MONITOR_POLICY } from './monitorPolicy'
import { MONITOR_RECORD_BYTES, parseMonitorRendererBatch, parseMonitorRendererRecord } from './monitorContracts'
import type { MonitorHeartbeat, MonitorOperation } from './monitorContracts'

const operation: MonitorOperation = { kind: 'operation', name: 'transcript.fold', durationMs: 12, outcome: 'success', sessionId: 'session-1' }
const heartbeat: MonitorHeartbeat = {
  kind: 'heartbeat', monotonicMs: 1, timeOriginMs: 1000, lagMs: 0, visibility: 'visible',
  longTaskCount: 0, longTaskTotalMs: 0, longTaskMaxMs: 0, heapUsedBytes: null,
  heapLimitBytes: null, inputCount: 0, inputMaxMs: 0,
}

describe('content-minimized renderer ingress', () => {
  it('admits supported numeric records and copies them at the trust boundary', () => {
    expect(parseMonitorRendererBatch([operation, heartbeat])).toEqual([operation, heartbeat])
    expect(parseMonitorRendererRecord(operation)).not.toBe(operation)
  })

  it.each([
    { ...operation, data: { nested: { prompt: 'PRIVATE SENTINEL' } } },
    { ...operation, name: 'PRIVATE SENTINEL' },
    { ...operation, sessionId: '/Users/private/project' },
    { ...operation, source: 'another-window' },
    { ...operation, durationMs: NaN },
    { ...operation, durationMs: Infinity },
    { ...operation, outcome: 'PRIVATE SENTINEL' },
    { ...heartbeat, longTaskCount: -1 },
    { ...heartbeat, inputCount: 0.5 },
    { ...heartbeat, heapUsedBytes: 'PRIVATE SENTINEL' },
  ])('rejects unsupported fields, identities and measurements: %#', value => {
    expect(parseMonitorRendererRecord(value)).toBeNull()
  })

  it('rejects oversized batches before processing their records', () => {
    expect(parseMonitorRendererBatch(Array(MONITOR_POLICY.rendererBatchRecords + 1).fill(operation))).toBeNull()
    expect(parseMonitorRendererBatch([operation, null])).toBeNull()
    expect(parseMonitorRendererBatch({})).toBeNull()
  })

  it('conservatively charges even the largest admitted wire values', () => {
    const largeHeartbeat = { ...heartbeat }
    for (const key of Object.keys(largeHeartbeat) as Array<keyof MonitorHeartbeat>) {
      if (typeof largeHeartbeat[key] === 'number' || largeHeartbeat[key] === null) {
        Object.assign(largeHeartbeat, { [key]: Number.MAX_SAFE_INTEGER })
      }
    }
    const largestOperation = { ...operation, sessionId: 'a'.repeat(96), durationMs: 86_400_000 }
    for (const record of [largeHeartbeat, largestOperation]) {
      expect(parseMonitorRendererRecord(record)).not.toBeNull()
      expect(Buffer.byteLength(JSON.stringify(record))).toBeLessThanOrEqual(MONITOR_RECORD_BYTES)
    }
    expect(MONITOR_POLICY.rendererBatchRecords * (MONITOR_RECORD_BYTES + 1) + 2)
      .toBeLessThanOrEqual(MONITOR_POLICY.batchBytes)
  })
})
