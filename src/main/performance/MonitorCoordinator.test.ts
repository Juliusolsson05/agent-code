import type { MainProbeSample } from './MainProbe.js'
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  launch: vi.fn(),
  metrics: vi.fn(() => []),
  subscribe: vi.fn((_listener: (sample: MainProbeSample) => void) => vi.fn()),
  start: vi.fn(),
}))
vi.mock('electron', () => ({
  app: { getAppMetrics: harness.metrics },
  utilityProcess: { fork: harness.launch },
}))
vi.mock('./MainProbe.js', () => ({ mainProbe: harness }))
vi.mock('@main/incident/appRunIds.js', () => ({ getAppRunId: () => 'run-test' }))
import { MonitorCoordinator } from './MonitorCoordinator.js'

class FakeChild extends EventEmitter {
  postMessage = vi.fn()
  kill = vi.fn(() => { this.emit('exit', 1); return true })
}
const operation = { kind: 'operation' as const, name: 'ipc.handler' as const, durationMs: 4, outcome: 'success' as const }

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks() })
describe('monitor worker isolation', () => {
  it('bounds both source and transport queues while a worker cannot acknowledge', () => {
    vi.useFakeTimers()
    const child = new FakeChild()
    harness.launch.mockReturnValue(child)
    const coordinator = new MonitorCoordinator(() => Date.now())
    coordinator.start()
    for (let i = 0; i < 10000; i++) coordinator.operation(operation)
    vi.advanceTimersByTime(5000)
    expect(child.postMessage).toHaveBeenCalledTimes(1)
    expect(child.postMessage.mock.calls[0][0].records).toHaveLength(120)
    expect(coordinator.read().queuedBytes).toBeLessThanOrEqual(2 * 1024 ** 2)
    expect(coordinator.read().droppedRecords).toBe(8400)
    vi.advanceTimersByTime(2000)
    expect(child.kill).toHaveBeenCalledOnce()
    expect(coordinator.read().collector).toBe('degraded')
    expect(coordinator.read().droppedRecords).toBe(8520)
    coordinator.stop()
  })

  it('ignores stale acknowledgements and limits restarts for the entire app run', () => {
    vi.useFakeTimers()
    harness.launch.mockImplementation(() => new FakeChild())
    const coordinator = new MonitorCoordinator(() => Date.now())
    coordinator.start()
    for (let attempt = 0; attempt < 4; attempt++) {
      coordinator.operation(operation)
      vi.advanceTimersByTime(30000)
    }
    vi.advanceTimersByTime(300000)
    expect(harness.launch).toHaveBeenCalledTimes(4)
    expect(coordinator.read().restarts).toBe(3)
    const obsolete = harness.launch.mock.results[0].value as FakeChild
    obsolete.emit('message', { sequence: 1, snapshot: { schemaVersion: 1, sampledAt: Date.now() } })
    expect(coordinator.read().collector).toBe('degraded')
    coordinator.stop()
    vi.advanceTimersByTime(300000)
    expect(harness.launch).toHaveBeenCalledTimes(4)
  })
  it('does not let a wall-clock rollback postpone its deadline or inherit credentials', () => {
    vi.useFakeTimers()
    vi.stubEnv('PERFORMANCE_TEST_SECRET', 'synthetic-sentinel')
    let mono = 1
    const child = new FakeChild()
    harness.launch.mockReturnValue(child)
    const coordinator = new MonitorCoordinator(() => mono)
    coordinator.start()
    expect(JSON.stringify(harness.launch.mock.calls[0])).not.toContain('synthetic-sentinel')
    coordinator.operation(operation)
    vi.advanceTimersByTime(1000)
    vi.setSystemTime(Date.now() - 3600000)
    mono += 6000
    vi.advanceTimersByTime(1000)
    expect(child.kill).toHaveBeenCalledOnce()
    coordinator.stop()
    vi.unstubAllEnvs()
  })

  it('reconciles window closure under overload and keeps the authoritative live main sample', () => {
    vi.useFakeTimers()
    const child = new FakeChild()
    harness.launch.mockReturnValue(child)
    const coordinator = new MonitorCoordinator(() => Date.now())
    coordinator.start()
    coordinator.heartbeat(1, { sentAt: 100, monotonicMs: 50, eventLoopLagMs: 0,
      visibilityState: 'visible', longTasks: { count: 0, totalMs: 0, maxMs: 0 } })
    coordinator.closeWindow(1)
    for (let i = 0; i < 5000; i++) coordinator.operation(operation)
    vi.advanceTimersByTime(1000)
    harness.subscribe.mock.calls[0][0]({ loopSampledAt: 200, cpuPercent: 1, rss: 100, heapUsed: 10,
      heapLimit: 100, sleepGap: false, eventLoopDelay: { meanMs: 20, maxMs: 40, p99Ms: 30 } } as MainProbeSample)
    const sent = child.postMessage.mock.calls[0][0]
    expect(sent.liveWindowIds).toEqual([])
    child.emit('message', { sequence: sent.sequence, snapshot: {
      schemaVersion: 1, sampledAt: Date.now(), main: { at: 100, cpuPercent: 1, rss: 100, heapUsed: 10,
        heapLimit: 100, loopMeanMs: 20, loopP99Ms: 30, loopMaxMs: 40, sleepGap: false },
      windows: [{ kind: 'heartbeat', windowId: 1, receivedAt: 100, monotonicMs: 50, timeOriginMs: 50,
        lagMs: 0, visibility: 'visible', longTaskCount: 0, longTaskTotalMs: 0, longTaskMaxMs: 0,
        heapUsedBytes: null, heapLimitBytes: null, inputCount: 0, inputMaxMs: 0,
        longTasksSupported: false, inputSupported: false }],
      recent: [], operations: [], workerRss: 0,
    } })
    expect(coordinator.read().main?.at).toBe(200)
    expect(coordinator.read().collector).toBe('healthy')
    expect(coordinator.read().windows).toEqual([])
    coordinator.stop()
  })

  it('contains a malformed acknowledged snapshot without losing the existing cache', () => {
    vi.useFakeTimers()
    const child = new FakeChild()
    harness.launch.mockReturnValue(child)
    const coordinator = new MonitorCoordinator(() => Date.now())
    coordinator.start()
    coordinator.operation(operation)
    vi.advanceTimersByTime(1000)
    const sequence = child.postMessage.mock.calls[0][0].sequence
    expect(() => child.emit('message', { sequence, snapshot: { schemaVersion: 1, sampledAt: Date.now() } })).not.toThrow()
    expect(coordinator.read().collector).toBe('degraded')
    expect(coordinator.read().droppedRecords).toBe(1)
    coordinator.stop()
  })

  it('accounts producer loss once per generation, including late reports from a retired producer', () => {
    const coordinator = new MonitorCoordinator()
    coordinator.sourceLoss(7, 'renderer', 'gen-a', 4)
    coordinator.sourceLoss(7, 'renderer', 'gen-a', 9)
    // Reload: the new generation's counter restarts, even above the old value.
    coordinator.sourceLoss(7, 'renderer', 'gen-b', 12)
    // A report the retired producer sent before the reload arrives late.
    coordinator.sourceLoss(7, 'renderer', 'gen-a', 9)
    coordinator.sourceLoss(7, 'renderer', 'gen-b', 15)
    expect(coordinator.read().droppedRecords).toBe(24)
    coordinator.closeWindow(7)
    coordinator.sourceLoss(7, 'renderer', 'gen-c', 3)
    expect(coordinator.read().droppedRecords).toBe(27)
    coordinator.stop()
  })

  it('publishes process generations atomically and rejects missing chunks', () => {
    vi.useFakeTimers()
    const child = new FakeChild()
    harness.launch.mockReturnValue(child)
    const coordinator = new MonitorCoordinator(() => Date.now())
    coordinator.start()
    coordinator.operation(operation)
    const row = { identity: '1:100', pid: 1, parentPid: 0, creationTime: 100, type: 'main',
      sessionIds: [], sharedSessionCount: 0, cpuPercent: 1, memoryBytes: 1024, quality: 'ok' }
    const summary = { sampledAt: 100, count: 2, cpuPercent: 2, memoryBytes: 2048, quality: 'ok', sessionCount: 0, missingRoots: 0, truncated: false }
    vi.advanceTimersByTime(250)
    child.emit('message', { sequence: 1, processChunk: { generation: 1, offset: 0, complete: false, rows: [row], summary } })
    expect(coordinator.readProcesses().rows).toEqual([])
    vi.advanceTimersByTime(250)
    child.emit('message', { sequence: 2, processChunk: { generation: 1, offset: 1, complete: true, rows: [{ ...row, identity: '2:100', pid: 2 }], summary } })
    expect(coordinator.readProcesses().rows).toHaveLength(2)
    coordinator.operation(operation)
    vi.advanceTimersByTime(250)
    child.emit('message', { sequence: 3, processChunk: { generation: 2, offset: 1, complete: true, rows: [row], summary } })
    expect(coordinator.read().collector).toBe('degraded')
    expect(coordinator.readProcesses().rows).toHaveLength(2)
    coordinator.stop()
  })

  it('reserves transport capacity for the declared maximum process fleet', () => {
    vi.useFakeTimers()
    const child = new FakeChild()
    harness.launch.mockReturnValue(child)
    const coordinator = new MonitorCoordinator(() => Date.now())
    coordinator.start()
    coordinator.startProcesses(() => Array.from({ length: 2048 }, (_, index) => ({
      sessionId: `session-${index}`,
      kind: 'claude' as const,
      pid: 10_000 + index,
      exited: false,
      lastActivityAt: null,
    })))

    const records: Array<{ kind: string }> = []
    for (let index = 0; index < 21; index++) {
      vi.advanceTimersByTime(200)
      const request = child.postMessage.mock.calls.at(-1)?.[0]
      expect(request).toBeDefined()
      records.push(...request.records)
      child.emit('message', { sequence: request.sequence })
    }

    expect(records).toHaveLength(2050)
    expect(records[0]?.kind).toBe('process-context-start')
    expect(records.at(-1)?.kind).toBe('process-context-end')
    expect(coordinator.read().droppedRecords).toBe(0)
    coordinator.stop()
  })

  it('keeps the last valid process page when a restarted worker sends its empty sentinel', () => {
    vi.useFakeTimers()
    const first = new FakeChild()
    const second = new FakeChild()
    harness.launch.mockReturnValueOnce(first).mockReturnValueOnce(second)
    const coordinator = new MonitorCoordinator(() => Date.now())
    coordinator.start()
    coordinator.operation(operation)
    vi.advanceTimersByTime(200)
    const row = { identity: '1:100', pid: 1, parentPid: 0, creationTime: 100, type: 'main',
      sessionIds: [], sharedSessionCount: 0, cpuPercent: 1, memoryBytes: 1024, quality: 'ok' }
    const summary = { contextGeneration: 1, sampledAt: 100, count: 1, cpuPercent: 1,
      memoryBytes: 1024, quality: 'ok', sessionCount: 0, missingRoots: 0, truncated: false }
    first.emit('message', { sequence: 1, processChunk: { generation: 1, offset: 0, complete: true, rows: [row], summary } })
    first.emit('exit', 1)
    vi.advanceTimersByTime(5000)
    coordinator.operation(operation)
    vi.advanceTimersByTime(200)
    const sequence = second.postMessage.mock.calls.at(-1)?.[0].sequence
    second.emit('message', { sequence, processChunk: {
      generation: 1, offset: 0, complete: true, rows: [],
      summary: { sampledAt: 0, count: 0, cpuPercent: null, memoryBytes: null,
        quality: 'warming-up', sessionCount: 0, missingRoots: 0, truncated: false },
    } })
    expect(coordinator.readProcesses().rows).toEqual([row])
    coordinator.stop()
  })

  it('waits for the worker history queue before killing the helper at shutdown', async () => {
    vi.useFakeTimers()
    const child = new FakeChild()
    harness.launch.mockReturnValue(child)
    const coordinator = new MonitorCoordinator(() => Date.now())
    coordinator.start()
    coordinator.operation(operation)
    vi.advanceTimersByTime(200)
    const inFlight = child.postMessage.mock.calls[0]![0]

    const shutdown = coordinator.shutdown()
    child.emit('message', { sequence: inFlight.sequence })
    await vi.advanceTimersByTimeAsync(200)
    const flush = child.postMessage.mock.calls[1]![0]
    expect(flush.query).toEqual({ kind: 'history-flush' })
    expect(child.kill).not.toHaveBeenCalled()

    child.emit('message', {
      sequence: flush.sequence,
      queryResult: { kind: 'history-flush', value: true },
    })
    await vi.advanceTimersByTimeAsync(40)
    await shutdown
    expect(child.kill).toHaveBeenCalledOnce()
  })

  it('drains every queued batch before the final history flush', async () => {
    vi.useFakeTimers()
    const child = new FakeChild()
    harness.launch.mockReturnValue(child)
    const coordinator = new MonitorCoordinator(() => Date.now())
    coordinator.start()
    for (let i = 0; i < 300; i++) coordinator.operation(operation)
    vi.advanceTimersByTime(200)
    const shutdown = coordinator.shutdown()
    const sent: Array<{ sequence: number; records: unknown[]; query?: { kind: string } }> = []
    for (let i = 0; i < 12; i++) {
      const request = child.postMessage.mock.calls.at(-1)![0]
      if (!sent.includes(request)) {
        sent.push(request)
        child.emit('message', request.query
          ? { sequence: request.sequence, queryResult: { kind: 'history-flush', value: true } }
          : { sequence: request.sequence })
      }
      await vi.advanceTimersByTimeAsync(20)
    }
    await shutdown
    expect(sent.flatMap(request => request.records)).toHaveLength(300)
    expect(sent.at(-1)!.query).toEqual({ kind: 'history-flush' })
    expect(coordinator.read().droppedRecords).toBe(0)
  })

  it('abandons an in-flight export at shutdown so the history flush still runs', async () => {
    vi.useFakeTimers()
    const child = new FakeChild()
    harness.launch.mockReturnValue(child)
    const coordinator = new MonitorCoordinator(() => Date.now())
    coordinator.start()
    const exporting = coordinator.exportReport(0, 1, '/reports/report.json', {})
    vi.advanceTimersByTime(200)
    expect(child.postMessage.mock.calls[0]![0].query).toMatchObject({ kind: 'report-export' })
    const shutdown = coordinator.shutdown()
    expect(await exporting).toEqual({ ok: false, code: 'unavailable' })
    await vi.advanceTimersByTimeAsync(40)
    const flush = child.postMessage.mock.calls.at(-1)![0]
    expect(flush.query).toEqual({ kind: 'history-flush' })
    child.emit('message', { sequence: flush.sequence, queryResult: { kind: 'history-flush', value: true } })
    await vi.advanceTimersByTimeAsync(40)
    await shutdown
    expect(child.kill).toHaveBeenCalledOnce()
  })

  it('never abandons a mutating query at its deadline', async () => {
    vi.useFakeTimers()
    const child = new FakeChild()
    harness.launch.mockReturnValue(child)
    const coordinator = new MonitorCoordinator(() => Date.now())
    coordinator.start()
    const clearing = coordinator.clearHistory()
    vi.advanceTimersByTime(200)
    expect(child.postMessage.mock.calls[0]![0].query).toEqual({ kind: 'history-clear' })
    // A clear that outlives its deadline is killed, so "unconfirmed" is honest:
    // the helper cannot keep deleting after the UI has reported an outcome.
    vi.advanceTimersByTime(60_400)
    expect(await clearing).toEqual({ sent: true, status: null })
    expect(child.kill).toHaveBeenCalledOnce()
    coordinator.stop()
  })

  it('abandons a slow query without killing the helper or piling up scans', async () => {
    vi.useFakeTimers()
    const child = new FakeChild()
    harness.launch.mockReturnValue(child)
    const coordinator = new MonitorCoordinator(() => Date.now())
    coordinator.start()
    const status = { state: 'healthy', bytes: 0, oldestAt: null, newestAt: null, points: 0, incidents: 0, exporting: false, shortened: false }
    const first = coordinator.readHistoryStatus()
    const second = coordinator.readHistoryStatus()
    vi.advanceTimersByTime(200)
    const slow = child.postMessage.mock.calls[0]![0]
    vi.advanceTimersByTime(10_400)
    expect(await first).toBeNull()
    expect(child.kill).not.toHaveBeenCalled()
    // Records keep flowing while the abandoned scan finishes...
    coordinator.operation(operation)
    vi.advanceTimersByTime(200)
    const records = child.postMessage.mock.calls.at(-1)![0]
    expect(records.query).toBeUndefined()
    expect(records.records).toHaveLength(1)
    child.emit('message', { sequence: records.sequence })
    // ...but the next query waits for the late reply instead of running concurrently.
    vi.advanceTimersByTime(200)
    expect(child.postMessage).toHaveBeenCalledTimes(2)
    child.emit('message', { sequence: slow.sequence, queryResult: { kind: 'history-status', value: status } })
    vi.advanceTimersByTime(200)
    const next = child.postMessage.mock.calls.at(-1)![0]
    expect(next.query).toEqual({ kind: 'history-status' })
    child.emit('message', { sequence: next.sequence, queryResult: { kind: 'history-status', value: status } })
    expect(await second).toEqual(status)
    expect(harness.launch).toHaveBeenCalledOnce()
    coordinator.stop()
  })

})
