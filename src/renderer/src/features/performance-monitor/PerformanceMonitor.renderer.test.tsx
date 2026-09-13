import { act, render, renderHook, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MonitorSnapshot } from '@shared/performance/monitorSnapshot.js'
import type { MonitorProcessPage } from '@shared/performance/processSnapshot.js'
import { PerformanceMonitor } from './PerformanceMonitor'
import { useMonitor } from './useMonitor'

const main = { at: 1000, cpuPercent: 0, rss: 1024, heapUsed: 512, heapLimit: 2048, loopMeanMs: 20, loopP99Ms: 20, loopMaxMs: 20, sleepGap: false }
const snapshot: MonitorSnapshot = {
  schemaVersion: 1, runId: 'test', enabled: true, sampledAt: 1000, main, windows: [], operations: [],
  recent: [main, { ...main, at: 2000 }], workerRss: 1024, collector: 'healthy', droppedRecords: 0, queuedBytes: 0, restarts: 0,
}
function api(
  read: () => Promise<MonitorSnapshot | null>,
  getMonitorProcesses: (offset: number, sort: 'cpu' | 'memory') => Promise<MonitorProcessPage | null> = vi.fn(async () => null),
  overrides: Record<string, unknown> = {},
) {
  Object.defineProperty(window, 'api', { value: {
    getMonitorSnapshot: read, getMonitorProcesses,
    previewMonitorReport: vi.fn(async () => ({ from: 0, to: 1, estimatedBytes: 4096,
      dataClasses: ['metrics', 'operations', 'incidents', 'coverage', 'build'], localOnly: true,
      status: { state: 'healthy', bytes: 4096, oldestAt: 0, newestAt: 1, points: 2,
        incidents: 0, exporting: false, shortened: false } })),
    getMonitorTraceStatus: vi.fn(async () => ({ state: 'idle', mode: null, ownerWindowId: null,
      startedAt: null, endsAt: null, path: null, bytes: null, truncated: false, message: null })),
    saveMonitorReport: vi.fn(async () => ({ ok: false, code: 'cancelled' })),
    clearMonitorHistory: vi.fn(async () => null),
    startMonitorTrace: vi.fn(async () => null), stopMonitorTrace: vi.fn(async () => null),
    writeHeapSnapshot: vi.fn(async () => ({ ok: false, error: 'cancelled' })), revealPath: vi.fn(async () => {}),
    ...overrides,
  }, configurable: true })
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('monitor display lifecycle', () => {
  it('stops polling after unmount and never overlaps a delayed read', async () => {
    vi.useFakeTimers()
    let resolve!: (snapshot: MonitorSnapshot) => void
    const read = vi.fn(() => new Promise<MonitorSnapshot>(done => { resolve = done }))
    api(read)
    const hook = renderHook(() => useMonitor())
    await act(async () => { vi.advanceTimersByTime(15000) })
    expect(read).toHaveBeenCalledTimes(1)
    expect(hook.result.current.error).toBe(true)
    hook.unmount()
    await act(async () => { resolve(snapshot); await Promise.resolve(); vi.advanceTimersByTime(10000) })
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('exposes an accessible dialog and distinguishes actual zero from unavailable values', async () => {
    api(vi.fn(async () => snapshot))
    render(<PerformanceMonitor onClose={vi.fn()} />)
    expect(await screen.findByRole('dialog', { name: 'Performance Monitor' })).toBeInTheDocument()
    expect(await screen.findByText('Peak 0.0 %')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Processes' })).toBeInTheDocument()
    expect(screen.getByText('Always on · no automatic uploads')).toBeInTheDocument()
  })

  it('returns pagination to the last valid page when a process fleet shrinks', async () => {
    vi.useFakeTimers()
    const rows = Array.from({ length: 50 }, (_, index) => ({
      identity: `${index + 1}:1`, pid: index + 1, parentPid: 1, creationTime: 1,
      type: 'agent' as const, provider: 'claude' as const, sessionIds: [`s-${index}`],
      sharedSessionCount: 1, cpuPercent: 1, memoryBytes: 1024, quality: 'ok' as const,
    }))
    let total = 100
    const readProcesses = vi.fn(async (offset: number) => ({
      summary: { sampledAt: 1, count: total, cpuPercent: 1, memoryBytes: 1024,
        quality: 'ok' as const, sessionCount: total, missingRoots: 0, truncated: false },
      rows: offset < total ? rows.slice(0, Math.min(50, total - offset)) : [], total,
    }))
    api(vi.fn(async () => snapshot), readProcesses)
    render(<PerformanceMonitor onClose={vi.fn()} />)
    await act(async () => { await Promise.resolve() })
    screen.getByRole('button', { name: 'Processes' }).click()
    await act(async () => { await Promise.resolve() })
    screen.getByRole('button', { name: 'Next' }).click()
    await act(async () => { await Promise.resolve() })
    expect(readProcesses).toHaveBeenLastCalledWith(50, 'cpu')

    total = 10
    await act(async () => { vi.advanceTimersByTime(2000); await Promise.resolve() })
    await act(async () => { await Promise.resolve() })
    expect(readProcesses).toHaveBeenLastCalledWith(0, 'cpu')
  })

  it('previews local-only reports and starts an explicitly selected trace', async () => {
    const start = vi.fn(async () => ({ state: 'recording' as const, mode: 'chromium' as const,
      ownerWindowId: 7, startedAt: 1, endsAt: 30_001, path: null, bytes: null,
      truncated: false, message: null }))
    api(vi.fn(async () => ({ ...snapshot, history: { state: 'healthy' as const, bytes: 4096,
      oldestAt: 0, newestAt: 1, points: 2, incidents: 0, exporting: false, shortened: false } })), undefined, { startMonitorTrace: start })
    render(<PerformanceMonitor onClose={vi.fn()} />)
    screen.getByRole('button', { name: 'Recordings' }).click()

    expect(await screen.findByText(/metrics, operations, incidents, coverage, build/)).toHaveTextContent('local file only')
    screen.getByRole('button', { name: 'Record Chromium Trace' }).click()
    await vi.waitFor(() => expect(start).toHaveBeenCalledWith('chromium', 30_000))
    expect(await screen.findByRole('button', { name: 'Stop and Save' })).toBeInTheDocument()
  })
})
