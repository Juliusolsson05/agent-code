import { describe, expect, it } from 'vitest'
import { IncidentEngine } from './IncidentEngine.js'
import { parseMonitorIncident } from '@shared/performance/parseMonitorIncident.js'
import type { MonitorEnvelope } from '@shared/performance/monitorSnapshot.js'
const main = (at: number, delay = 20, sleepGap = false, heapUsed = 10): MonitorEnvelope => ({ kind: 'main', sample: {
  at, cpuPercent: 1, rss: 100, heapUsed, heapLimit: 100, loopMeanMs: delay, loopP99Ms: delay, loopMaxMs: delay, sleepGap,
} })
const windowSample = (at: number, visible = true): MonitorEnvelope => ({ kind: 'window', sample: {
  kind: 'heartbeat', windowId: 1, receivedAt: at, monotonicMs: at, timeOriginMs: 0, visibility: visible ? 'visible' : 'hidden',
  lagMs: 0, longTaskCount: 0, longTaskTotalMs: 0, longTaskMaxMs: 0, inputCount: 0, inputMaxMs: 0,
  heapUsedBytes: null, heapLimitBytes: null, longTasksSupported: true, inputSupported: true,
} })

describe('incident evidence and exclusion rules', () => {
  it('captures surrounding context, coalesces triggers and bounds long-run retention', () => {
    const engine = new IncidentEngine()
    for (let at = 1000; at <= 200000; at += 1000) engine.accept([main(at, at % 70000 === 0 ? 2000 : 20)], at, at)
    expect(engine.summaries()).toHaveLength(2)
    const detail = engine.detail(1)!
    expect(detail.state).toBe('complete')
    expect(detail.evidence.length).toBeGreaterThan(60)
    expect(parseMonitorIncident(detail)).toEqual(detail)
    expect(JSON.stringify(detail).length).toBeLessThan(1024 * 1024)
    for (let at = 300000; at < 5000000; at += 70000) engine.accept([main(at, 2000)], at, at)
    expect(engine.summaries()).toHaveLength(50)
  })
  it('does not classify sleep, hidden windows, main delivery gaps or provider waits as renderer faults', () => {
    const engine = new IncidentEngine()
    engine.reconcile([1], [], 1000)
    engine.accept([main(1000), windowSample(1000)], 1000, 1000)
    engine.accept([main(6000)], 6000, 6000)
    expect(engine.summaries()).toHaveLength(0)
    engine.reconcile([1], [1], 20000)
    engine.accept([main(20000, 9000, true)], 20000, 20000)
    engine.tick(21000, 21000)
    engine.accept([{ kind: 'operation', at: 21000, windowId: 1, sample: { kind: 'operation', name: 'provider.first-output', durationMs: 100000, outcome: 'success' } }], 21000, 21000)
    expect(engine.summaries()).toHaveLength(0)
    engine.tick(40000, 40000)
    expect(engine.summaries()).toHaveLength(0)
  })
  it('requires fresh main coverage for missing heartbeats and independent heap intervals', () => {
    const engine = new IncidentEngine()
    engine.reconcile([1], [1], 1000)
    engine.accept([main(1000), windowSample(1000)], 1000, 1000)
    engine.accept([main(6000)], 6000, 6000)
    expect(engine.summaries()[0]).toMatchObject({ rule: 'renderer-stall', threshold: 4000 })
    const heap = new IncidentEngine()
    for (let at = 1000; at <= 3000; at += 1000) heap.accept([main(at, 20, false, 80)], at, at)
    expect(heap.summaries()).toHaveLength(0)
    heap.accept([main(6000, 20, false, 80), main(11000, 20, false, 80)], 11000, 11000)
    heap.accept([main(16000, 20, false, 80)], 16000, 16000)
    expect(heap.summaries()[0]?.rule).toBe('memory-pressure')
  })
  it('detects a renderer that never heartbeats and gives a newly shown window a fresh interval', () => {
    const engine = new IncidentEngine()
    engine.reconcile([1], [], 1000)
    engine.accept([main(1000)], 1000, 1000)
    engine.reconcile([1], [1], 3000)
    engine.accept([main(6000)], 6000, 6000)
    expect(engine.summaries()).toHaveLength(0)
    engine.accept([main(8001)], 8001, 8001)
    expect(engine.summaries()[0]).toMatchObject({ rule: 'renderer-stall', scope: 1, threshold: 4000 })
  })
})
