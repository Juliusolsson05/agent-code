import { act, render, renderHook, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MonitorSnapshot } from '@shared/performance/monitorSnapshot.js'
import { PerformanceMonitor } from './PerformanceMonitor'
import { useMonitor } from './useMonitor'

const main = { at: 1000, cpuPercent: 0, rss: 1024, heapUsed: 512, heapLimit: 2048, loopMeanMs: 20, loopP99Ms: 20, loopMaxMs: 20, sleepGap: false }
const snapshot: MonitorSnapshot = {
  schemaVersion: 1, runId: 'test', enabled: true, sampledAt: 1000, main, windows: [], operations: [],
  recent: [main, { ...main, at: 2000 }], workerRss: 1024, collector: 'healthy', droppedRecords: 0, queuedBytes: 0, restarts: 0,
}
function api(read: () => Promise<MonitorSnapshot | null>) {
  Object.defineProperty(window, 'api', { value: { getMonitorSnapshot: read }, configurable: true })
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
})
