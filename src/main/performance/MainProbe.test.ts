import { afterEach, describe, expect, it, vi } from 'vitest'

const probe = vi.hoisted(() => ({ enable: vi.fn(), disable: vi.fn(), reset: vi.fn(), percentile: () => 30e6, mean: 22e6, max: 40e6 }))
vi.mock('node:perf_hooks', () => ({ monitorEventLoopDelay: () => probe, performance: { now: () => Date.now() } }))
import { MainProbe } from './MainProbe.js'

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks() })
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
    vi.setSystemTime(Date.now() + 60000)
    vi.advanceTimersByTime(1000)
    expect(sampler.read()).toMatchObject({ sleepGap: true, cpuPercent: null, eventLoopDelay: null })
    sampler.stop()
  })
})
