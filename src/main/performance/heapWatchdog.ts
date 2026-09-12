import { mainProbe } from './MainProbe.js'
import type { MainProbeSample } from './MainProbe.js'

export type HeapPressureInfo = {
  heapUsed: number
  heapLimit: number
  rss: number
  uptimeMs: number
  snapshotPath: string | null
  snapshotError?: string
  snapshotAttempts?: number
}

let unsubscribe: (() => void) | null = null
let reported = false

/**
 * Automatic pressure handling is deliberately metadata-only. The former
 * writeHeapSnapshot path could block main for seconds and require roughly
 * twice the live heap, turning a survivable pressure event into an OOM. Moving
 * that call to a worker would snapshot the worker's isolate, not main's heap.
 * Explicit user-requested heap capture remains a separate diagnostic action;
 * process.report's fatal-error escape path remains owned by AppRunJournal.
 *
 * The original threshold protects the same incident contract: 1.5 GiB or 70%
 * of V8's limit, whichever comes first. One callback per run avoids flooding
 * disk while a large but stable workload remains above the threshold.
 */
export function startMainHeapWatchdog(opts?: { onHeapPressure?: (info: HeapPressureInfo) => void }): void {
  if (unsubscribe) return
  const sample = (value: MainProbeSample): void => {
    if (reported || value.heapLimit <= 0 || value.heapUsed < Math.min(1.5 * 1024 ** 3, value.heapLimit * 0.7)) return
    reported = true
    try {
      opts?.onHeapPressure?.({
        heapUsed: value.heapUsed, heapLimit: value.heapLimit, rss: value.rss,
        uptimeMs: Math.round(process.uptime() * 1000), snapshotPath: null, snapshotAttempts: 0,
      })
    } catch { /* Diagnostic sinks must never destabilize the pressure path. */ }
  }
  unsubscribe = mainProbe.subscribe(sample)
  sample(mainProbe.read())
}

export function stopMainHeapWatchdog(): void {
  unsubscribe?.()
  unsubscribe = null
}

export function __resetHeapWatchdogForTests(): void {
  stopMainHeapWatchdog()
  reported = false
}
