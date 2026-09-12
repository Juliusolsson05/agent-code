import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import { getHeapSpaceStatistics, getHeapStatistics } from 'node:v8'
import type { SystemPerformanceStats } from '@shared/performance/types.js'

export type MainProbeSample = SystemPerformanceStats & {
  loopSampledAt: number
  monotonicMs: number
  cpuPercent: number | null
  sleepGap: boolean
}

/**
 * One owner, one interval definition. Reading diagnostics must never reset a
 * histogram or a CPU baseline: otherwise opening a second window silently
 * changes the first window's measurements. The journal and fatal path can read
 * this cache even if the isolated aggregation worker has crashed.
 */
export class MainProbe {
  private timer: ReturnType<typeof setInterval> | null = null
  private histogram: ReturnType<typeof monitorEventLoopDelay> | null = null
  private lastCpu = process.cpuUsage()
  private lastMono = performance.now()
  private suspended = false
  private resumed = false
  private loopWindows: Array<{ at: number; from: number; count: number; meanMs: number; maxMs: number; p99Ms: number }> = []
  private lastMemoryAt = -Infinity
  private listeners = new Set<(sample: MainProbeSample) => void>()
  private sample: MainProbeSample = {
    enabled: true, sampledAt: 0, loopSampledAt: 0, monotonicMs: 0,
    cpuPercent: null, sleepGap: false, heapUsed: 0, heapTotal: 0,
    heapLimit: 0, rss: 0, external: 0, arrayBuffers: 0, heapSpaces: [],
    detachedContexts: 0, nativeContexts: 0, eventLoopDelay: null,
  }

  start(): void {
    if (this.timer) return
    this.histogram = monitorEventLoopDelay({ resolution: 20 })
    this.histogram.enable()
    this.lastCpu = process.cpuUsage()
    this.lastMono = performance.now()
    this.tick()
    this.timer = setInterval(() => this.tick(), 1000)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.histogram?.disable()
    this.histogram = null
  }

  read(): MainProbeSample { return this.sample }

  noteSuspend(): void { this.suspended = true }
  noteResume(): void { this.suspended = false; this.resumed = true }

  readJournalWindow(): { meanMs: number; maxMs: number; p99WorstWindowMs: number; windowMs: number } | null {
    const now = performance.now()
    const windows = this.loopWindows.filter(window => window.at > now - 5000)
    const count = windows.reduce((sum, window) => sum + window.count, 0)
    if (!count) return null
    // Native ELD histograms cannot be merged with RecordableHistogram.add on
    // the supported Node runtime. Do not average per-window p99s and pretend
    // that is a distribution. Preserve the exact peak and weighted mean, and
    // label the worst-window p99 explicitly as a worst-window statistic, not a merged percentile.
    return {
      meanMs: windows.reduce((sum, window) => sum + window.meanMs * window.count, 0) / count,
      maxMs: Math.max(...windows.map(window => window.maxMs)),
      p99WorstWindowMs: Math.max(...windows.map(window => window.p99Ms)),
      windowMs: now - windows[0].from,
    }
  }

  subscribe(listener: (sample: MainProbeSample) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private tick(): void {
    // A monitoring exception cannot be allowed to become an application crash.
    // Retaining the timestamp of the last successful sample makes failures
    // observable as staleness instead of fabricating a reassuring zero.
    try {
      const now = Date.now()
      const mono = performance.now()
      const elapsed = mono - this.lastMono
      const cpu = process.cpuUsage()
      // A long callback gap is also exactly what an awake main-thread stall
      // looks like. Only Electron suspend/resume evidence may suppress it.
      const sleepGap = this.suspended || this.resumed
      this.resumed = false
      const histogram = this.histogram
      const eventLoopDelay = histogram && Number.isFinite(histogram.mean) && !sleepGap
        ? { meanMs: histogram.mean / 1e6, maxMs: histogram.max / 1e6, p99Ms: histogram.percentile(99) / 1e6 }
        : null
      this.sample = {
        ...this.sample, loopSampledAt: now, monotonicMs: mono, sleepGap, eventLoopDelay,
        cpuPercent: elapsed >= 100 && !sleepGap
          ? Math.max(0, (cpu.user - this.lastCpu.user + cpu.system - this.lastCpu.system) / (elapsed * 10)) : null,
      }
      if (eventLoopDelay && histogram) {
        this.loopWindows.push({ at: mono, from: this.lastMono, count: histogram.count, ...eventLoopDelay })
        if (this.loopWindows.length > 6) this.loopWindows.shift()
      }
      if (sleepGap) this.loopWindows = []
      this.lastCpu = cpu
      this.lastMono = mono
      histogram?.reset()
      if (mono - this.lastMemoryAt >= 5000) {
        const memory = process.memoryUsage()
        const heap = getHeapStatistics()
        this.sample = {
          ...this.sample, sampledAt: now, ...memory, heapLimit: heap.heap_size_limit,
          detachedContexts: heap.number_of_detached_contexts,
          nativeContexts: heap.number_of_native_contexts,
          heapSpaces: getHeapSpaceStatistics().map(space => ({
            spaceName: space.space_name, spaceSize: space.space_size,
            spaceUsedSize: space.space_used_size, spaceAvailableSize: space.space_available_size,
            physicalSpaceSize: space.physical_space_size,
          })),
        }
        this.lastMemoryAt = mono
      }
      for (const listener of this.listeners) {
        try { listener(this.sample) } catch { /* One sink cannot starve other observers. */ }
      }
    } catch { /* The existing cache remains available during teardown/native failures. */ }
  }
}

export const mainProbe = new MainProbe()
