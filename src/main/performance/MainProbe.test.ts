import { afterEach, describe, expect, it, vi } from 'vitest'

const probe = vi.hoisted(() => ({ enable: vi.fn(), disable: vi.fn(), reset: vi.fn(), percentile: vi.fn(() => 30e6), mean: 22e6, max: 40e6, count: 50 }))
vi.mock('node:perf_hooks', () => ({ monitorEventLoopDelay: () => probe, performance: { now: () => Date.now() } }))
import { MainProbe } from './MainProbe.js'

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); probe.max = 40e6 })
describe('shared main sample ownership', () => {
  it('keeps reads passive and starts only one sampler, with independent sink failures', () => {
    vi.useFakeTimers()
    const sampler = new MainProbe()
    const sink = vi.fn()
    sampler.subscribe(() => { throw new Error('broken sink') })
    const unsubscribe = sampler.subscribe(sink)
    sampler.start()
    sampler.start()
    const initial = sampler.read()
    for (let i = 0; i < 100; i++) expect(sampler.read()).toBe(initial)
    expect(probe.enable).toHaveBeenCalledTimes(1)
    expect(probe.reset).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1000)
    expect(sink).toHaveBeenCalledTimes(2)
    expect(sampler.read().sampledAt).toBe(initial.sampledAt)
    expect(sampler.read().loopSampledAt).toBe(initial.loopSampledAt + 1000)
    unsubscribe()
    sampler.stop()
    vi.advanceTimersByTime(10000)
    expect(sink).toHaveBeenCalledTimes(2)
    expect(probe.disable).toHaveBeenCalledTimes(1)
  })

  it('marks an event-loop discontinuity rather than inventing CPU or latency during sleep', () => {
    vi.useFakeTimers()
    const sampler = new MainProbe()
    sampler.start()
    sampler.noteSuspend()
    vi.setSystemTime(Date.now() + 60000)
    sampler.noteResume()
    vi.advanceTimersByTime(1000)
    expect(sampler.read()).toMatchObject({ sleepGap: true, cpuPercent: null, eventLoopDelay: null })
    sampler.stop()
  })
  it('preserves awake stalls and keeps earlier peaks in the journal window', () => {
    vi.useFakeTimers()
    const sampler = new MainProbe()
    sampler.start()
    probe.max = 500e6
    vi.setSystemTime(Date.now() + 6000)
    vi.advanceTimersByTime(1000)
    expect(sampler.read().sleepGap).toBe(false)
    expect(sampler.read().cpuPercent).not.toBeNull()
    expect(sampler.read().eventLoopDelay?.maxMs).toBe(500)
    probe.max = 20e6
    vi.advanceTimersByTime(3000)
    expect(sampler.read().eventLoopDelay?.maxMs).toBe(20)
    expect(sampler.readJournalWindow()?.maxMs).toBe(500)
    expect(sampler.readJournalWindow()?.windowMs).toBeGreaterThanOrEqual(5000)
    sampler.stop()
  })

  it('labels rounded per-window p99 separately while retaining the actual peak', () => {
    vi.useFakeTimers()
    const sampler = new MainProbe()
    // Node rounds rank for 51 observations: fifty 20ms values plus one 1000ms
    // value have a native p99 near 20ms, although five merged windows have a
    // p99 near 1000ms. Worst-window p99 therefore cannot be called a bound.
    probe.count = 51
    probe.max = 1000e6
    probe.percentile.mockReturnValue(20e6)
    sampler.start()
    vi.advanceTimersByTime(5000)
    expect(sampler.readJournalWindow()).toMatchObject({ p99WorstWindowMs: 20, maxMs: 1000 })
    expect(sampler.readJournalWindow()).not.toHaveProperty('p99UpperBoundMs')
    sampler.stop()
    probe.count = 50
    probe.percentile.mockReturnValue(30e6)
  })

})
