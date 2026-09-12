import { afterEach, describe, expect, it, vi } from 'vitest'

const metrics = vi.hoisted(() => vi.fn(() => []))
vi.mock('electron', () => ({ app: { getAppMetrics: metrics } }))

import type { MonitorEnvelope } from '@shared/performance/monitorSnapshot.js'
import { ElectronProcessSource } from './ElectronProcessSource.js'

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks() })

describe('process root identity handoff', () => {
  it('keeps a delayed sampled birth when a newer context has already been emitted', () => {
    vi.useFakeTimers()
    const records: MonitorEnvelope[] = []
    const source = new ElectronProcessSource(() => [{
      sessionId: 'session-a', generation: 'backend-a', kind: 'claude', pid: 20,
      exited: false, lastActivityAt: null,
    }], record => records.push(record))
    source.start()
    vi.advanceTimersByTime(5000)
    source.captureBirths([{
      identity: '20:123', pid: 20, parentPid: 1, creationTime: 123, type: 'agent',
      provider: 'claude', sessionIds: ['session-a'], sharedSessionCount: 1,
      cpuPercent: null, memoryBytes: 1024, quality: 'warming-up',
    }], 1)
    vi.advanceTimersByTime(5000)

    const target = records.filter((record): record is Extract<MonitorEnvelope, { kind: 'process-target' }> => record.kind === 'process-target').at(-1)
    expect(target?.generation).toBe(3)
    expect(target?.sample).toMatchObject({ sessionId: 'session-a', generation: 'backend-a', pid: 20, creationTime: 123 })
    source.stop()
  })
})
