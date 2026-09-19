import type { MonitorHistoryPoint, MonitorHistoryResolution } from '@shared/performance/monitorHistory.js'
import type { MonitorProcessSummary } from '@shared/performance/processSnapshot.js'
import type { MonitorWorkerSnapshot } from '@shared/performance/monitorSnapshot.js'

export const HISTORY_INTERVAL: Record<MonitorHistoryResolution, number> = { '1s': 1000, '10s': 10_000, '1m': 60_000 }

export function pointFrom(snapshot: MonitorWorkerSnapshot, processes: MonitorProcessSummary | null, resolution: MonitorHistoryResolution, droppedRecords: number, restarts: number): MonitorHistoryPoint {
  const visible = snapshot.windows.filter(window => window.visibility === 'visible')
  return {
    schemaVersion: 1, at: snapshot.sampledAt, resolution,
    main: snapshot.main && {
      cpuPercent: snapshot.main.cpuPercent, rss: snapshot.main.rss, heapUsed: snapshot.main.heapUsed,
      heapLimit: snapshot.main.heapLimit, loopP99Ms: snapshot.main.loopP99Ms, loopMaxMs: snapshot.main.loopMaxMs,
      sleepGap: snapshot.main.sleepGap,
    },
    processes: processes && {
      cpuPercent: processes.cpuPercent, memoryBytes: processes.memoryBytes, count: processes.count,
      sessionCount: processes.sessionCount, quality: processes.quality,
    },
    windows: {
      count: snapshot.windows.length, visible: visible.length,
      maxLagMs: snapshot.windows.reduce((max, window) => Math.max(max, window.lagMs), 0),
      longTaskMs: snapshot.windows.reduce((sum, window) => sum + (window.longTasksSupported ? window.longTaskTotalMs : 0), 0),
      maxInputMs: snapshot.windows.reduce((max, window) => Math.max(max, window.inputSupported ? window.inputMaxMs : 0), 0),
    },
    workerRss: snapshot.workerRss, droppedRecords, restarts,
  }
}

const maxNullable = (a: number | null, b: number | null): number | null => a === null ? b : b === null ? a : Math.max(a, b)
// Coverage degrades toward the least trustworthy sample in a bucket, so a
// rollup can never present a partly stale interval as fully observed.
const QUALITY_RANK: Record<string, number> = { ok: 0, unsupported: 1, 'warming-up': 2, partial: 3, stale: 4 }

/** Merge two observations into one peak-preserving bucket.
 *
 * WHY peaks instead of the last sample: coarse tiers and the 300-bucket chart
 * overview used to keep a single instant per bucket. A 900 ms stall inside a
 * quiet minute vanished from the 24 h and 7 d views, which are exactly the
 * views used to ask "was the app slow this afternoon?". Every stored field is
 * a level or a monotonic counter, so max is meaningful for all of them; sums
 * would change units between tiers (long-task ms per second vs per minute).
 *
 * Sleep-gap samples report the suspension itself as loop delay. They do not
 * contribute loop/CPU peaks when a real sample shares the bucket, and a bucket
 * is marked as a gap only when every main sample in it was one. */
export function mergePoints(into: MonitorHistoryPoint, next: MonitorHistoryPoint): MonitorHistoryPoint {
  let main = into.main ?? next.main
  if (into.main && next.main) {
    const a = into.main
    const b = next.main
    const loopSource = a.sleepGap === b.sleepGap ? null : a.sleepGap ? b : a
    main = {
      cpuPercent: loopSource ? loopSource.cpuPercent : maxNullable(a.cpuPercent, b.cpuPercent),
      rss: Math.max(a.rss, b.rss), heapUsed: Math.max(a.heapUsed, b.heapUsed), heapLimit: Math.max(a.heapLimit, b.heapLimit),
      loopP99Ms: loopSource ? loopSource.loopP99Ms : maxNullable(a.loopP99Ms, b.loopP99Ms),
      loopMaxMs: loopSource ? loopSource.loopMaxMs : maxNullable(a.loopMaxMs, b.loopMaxMs),
      sleepGap: a.sleepGap && b.sleepGap,
    }
  }
  let processes = into.processes ?? next.processes
  if (into.processes && next.processes) {
    const a = into.processes
    const b = next.processes
    processes = {
      cpuPercent: maxNullable(a.cpuPercent, b.cpuPercent), memoryBytes: maxNullable(a.memoryBytes, b.memoryBytes),
      count: Math.max(a.count, b.count), sessionCount: Math.max(a.sessionCount, b.sessionCount),
      quality: (QUALITY_RANK[b.quality] ?? 0) > (QUALITY_RANK[a.quality] ?? 0) ? b.quality : a.quality,
    }
  }
  return {
    schemaVersion: 1, at: Math.max(into.at, next.at), resolution: into.resolution, main, processes,
    windows: {
      count: Math.max(into.windows.count, next.windows.count), visible: Math.max(into.windows.visible, next.windows.visible),
      maxLagMs: Math.max(into.windows.maxLagMs, next.windows.maxLagMs), longTaskMs: Math.max(into.windows.longTaskMs, next.windows.longTaskMs),
      maxInputMs: Math.max(into.windows.maxInputMs, next.windows.maxInputMs),
    },
    workerRss: Math.max(into.workerRss, next.workerRss),
    droppedRecords: Math.max(into.droppedRecords, next.droppedRecords), restarts: Math.max(into.restarts, next.restarts),
  }
}

/** Accumulates one tier's wall-aligned bucket. The completed bucket is
 * returned when a sample opens the next one; `peek` exposes the open bucket so
 * queries still show "now" before a 1 m bucket closes. */
export class TierRollup {
  private current: MonitorHistoryPoint | null = null
  private bucket = Number.NaN
  constructor(readonly resolution: MonitorHistoryResolution) {}
  add(point: MonitorHistoryPoint): MonitorHistoryPoint | null {
    const bucket = Math.floor(point.at / HISTORY_INTERVAL[this.resolution])
    const tagged: MonitorHistoryPoint = { ...point, resolution: this.resolution }
    // A sample for an EARLIER bucket means the wall clock stepped backwards.
    // A small step (NTP slew, at most two buckets) merges into the open bucket:
    // reopening a closed one wrote a second point for a time already on disk.
    // A LARGER step instead closes the open bucket and starts over. Merging
    // every earlier sample collapsed a one-hour step into a single point stamped
    // with the pre-step time, hiding all new samples from queries until wall
    // time caught up. Paged queries tolerate the rare backwards file order.
    if (this.current && bucket <= this.bucket && this.bucket - bucket <= 2) {
      this.current = mergePoints(this.current, tagged)
      return null
    }
    // A later bucket, or a large backward step, closes the open one.
    const done = this.current
    this.current = tagged
    this.bucket = bucket
    return done
  }
  peek(): MonitorHistoryPoint | null { return this.current }
  take(): MonitorHistoryPoint | null {
    const done = this.current
    this.reset()
    return done
  }
  reset(): void { this.current = null; this.bucket = Number.NaN }
}
