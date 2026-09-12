import { BoundedQueue } from '@shared/performance/boundedQueue.js'
import { LatencyHistogram } from '@shared/performance/latencyHistogram.js'
import { MONITOR_POLICY } from '@shared/performance/monitorPolicy.js'
import type { MonitorEnvelope, MonitorMainSample, MonitorWindowSample, MonitorOperationSummary, MonitorWorkerSnapshot } from '@shared/performance/monitorSnapshot.js'

/** Worker-owned evidence. Every cardinality is bounded independently of run length. */
export class MonitorAggregator {
  private main: MonitorMainSample | null = null
  private recent = new BoundedQueue<MonitorMainSample>(900, 900 * 256)
  private windows = new Map<number, MonitorWindowSample>()
  private operations = new Map<string, { summary: Omit<MonitorOperationSummary, 'histogram'>; histogram: LatencyHistogram }>()

  accept(records: MonitorEnvelope[]): void {
    for (const record of records) {
      switch (record.kind) {
        case 'main':
          this.main = record.sample
          this.recent.push(record.sample, 256)
          break
        case 'window':
          if (this.windows.has(record.sample.windowId) || this.windows.size < MONITOR_POLICY.windowLimit) {
            this.windows.set(record.sample.windowId, record.sample)
          }
          break
        case 'window-closed': this.windows.delete(record.windowId); break
        case 'operation': {
          // Session IDs are deliberately absent from the aggregation key. A
          // long-lived app may create millions of sessions; finite operation ×
          // outcome keys keep the baseline fixed-size and avoid leaking paths.
          const { name, outcome, durationMs } = record.sample
          const key = `${name}:${outcome}`
          let entry = this.operations.get(key)
          if (!entry && this.operations.size < 100) {
            entry = { summary: { name, outcome }, histogram: new LatencyHistogram() }
            this.operations.set(key, entry)
          }
          entry?.histogram.observe(durationMs)
          break
        }
      }
    }
  }

  reconcileWindows(liveWindowIds: number[]): void {
    const live = new Set(liveWindowIds.slice(0, MONITOR_POLICY.windowLimit))
    for (const id of this.windows.keys()) if (!live.has(id)) this.windows.delete(id)
  }

  snapshot(now: number, workerRss: number): MonitorWorkerSnapshot {
    // Drain/reinsert preserves ring order without exposing mutable storage.
    // This path runs only once per acknowledged batch in the isolated worker.
    const recent = this.recent.drain().filter(sample => now - sample.at <= MONITOR_POLICY.recentMs)
    for (const sample of recent) this.recent.push(sample, 256)
    return {
      schemaVersion: 1, sampledAt: now, main: this.main, recent: recent.slice(-120), workerRss,
      windows: [...this.windows.values()],
      operations: [...this.operations.values()].map(entry => ({ ...entry.summary, histogram: entry.histogram.snapshot() })),
    }
  }
}
