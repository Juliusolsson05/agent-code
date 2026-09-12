import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({ launch: vi.fn(), subscribe: vi.fn(() => vi.fn()), start: vi.fn() }))
vi.mock('electron', () => ({ utilityProcess: { fork: harness.launch } }))
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
    expect(coordinator.read().droppedRecords).toBe(6000)
    vi.advanceTimersByTime(2000)
    expect(child.kill).toHaveBeenCalledOnce()
    expect(coordinator.read().collector).toBe('degraded')
    expect(coordinator.read().droppedRecords).toBe(6120)
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
    const sent = child.postMessage.mock.calls[0][0]
    expect(sent.liveWindowIds).toEqual([])
    child.emit('message', { sequence: sent.sequence, snapshot: {
      schemaVersion: 1, sampledAt: Date.now(), main: { at: -1 }, windows: [{ windowId: 1 }],
      recent: [], operations: [], workerRss: 0,
    } })
    expect(coordinator.read().main).toBeNull()
    expect(coordinator.read().windows).toEqual([])
    coordinator.stop()
  })

})
