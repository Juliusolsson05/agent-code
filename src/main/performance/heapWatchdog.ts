// src/main/performance/heapWatchdog.ts
//
// Heap-pressure watchdog for the Electron main process.
//
// WHY this exists: cc-shell long-running sessions have OOMed the main
// process (4 GB v8 cap on macOS). Reproductions take 20+ hours, so
// catching them with a debugger is impractical. The watchdog samples
// `v8.getHeapStatistics()` at a low duty cycle and writes a heap
// snapshot to disk the first time the process crosses a "we will OOM
// soon" threshold. The snapshot is a forensic artifact that
// Chrome DevTools / clinic.js can analyse — pin-pointing which
// retainer chains are holding all the memory without us having to
// guess.
//
// WHY a single-shot snapshot (not periodic): heap snapshots are large
// (1-3 GB at the threshold we care about), expensive to write
// (multi-second STW pause), and only useful when the heap is in the
// "near-OOM, not yet OOM" state. Once we have one, we have what we
// need to investigate; subsequent snapshots from the same session
// rarely add information and would themselves accelerate the OOM.
//
// WHY no exit / restart on threshold: that is a policy decision the
// user owns. Crashing on heap exhaustion already produces a v8 fatal
// error log; what we lacked was the snapshot. We add the snapshot,
// nothing else.

import { writeHeapSnapshot, getHeapStatistics } from 'node:v8'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { STATE_DIR } from '@main/storage/paths.js'

// Threshold rationale: use the lower of 3 GiB and 75% of the ACTUAL
// V8 heap limit for this Electron process. The original watchdog used
// a fixed 3 GiB threshold because the first observed crash had a ~4 GiB
// main-process heap cap. A later crash on 2026-05-11 died around
// 1.2 GiB old-space, so the fixed threshold never fired. The heap cap
// varies with Electron/Node flags and process mode; measuring it at
// runtime is the only threshold that works across dev/prod launches.
const HEAP_USED_TRIP_BYTES = 3 * 1024 * 1024 * 1024
const HEAP_LIMIT_TRIP_RATIO = 0.75

// Sample every 30 s. Heap pressure builds over hours, not seconds, so
// finer sampling buys nothing and just wakes the event loop more.
const SAMPLE_INTERVAL_MS = 30_000

let watchdogTimer: NodeJS.Timeout | null = null
let snapshotWritten = false

export function startMainHeapWatchdog(): void {
  if (watchdogTimer) return
  watchdogTimer = setInterval(() => {
    void sampleAndMaybeSnapshot()
  }, SAMPLE_INTERVAL_MS).unref()
}

export function stopMainHeapWatchdog(): void {
  if (watchdogTimer) {
    clearInterval(watchdogTimer)
    watchdogTimer = null
  }
}

async function sampleAndMaybeSnapshot(): Promise<void> {
  const stats = getHeapStatistics()
  // used_heap_size is the metric we care about: total_heap_size can
  // briefly inflate from internal fragmentation without being close to
  // the limit. used_heap_size is what the v8 fatal-error report shows.
  const heapUsed = stats.used_heap_size
  const limit = stats.heap_size_limit
  const tripAt = Math.min(HEAP_USED_TRIP_BYTES, limit * HEAP_LIMIT_TRIP_RATIO)
  if (heapUsed < tripAt) return
  if (snapshotWritten) return
  snapshotWritten = true

  const dir = join(STATE_DIR, 'heap-snapshots')
  try {
    await mkdir(dir, { recursive: true })
  } catch (err) {
    // Best-effort: if mkdir fails we still try writeHeapSnapshot in
    // CWD because the snapshot is the load-bearing artifact, not the
    // tidy directory layout.
    // eslint-disable-next-line no-console
    console.warn('[heap-watchdog] mkdir failed', err)
  }
  const file = join(
    dir,
    `main-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}.heapsnapshot`,
  )
  // eslint-disable-next-line no-console
  console.warn(
    `[heap-watchdog] heapUsed=${heapUsed} limit=${limit} tripAt=${Math.round(tripAt)} → writing snapshot to ${file}`,
  )
  try {
    writeHeapSnapshot(file)
    // eslint-disable-next-line no-console
    console.warn(`[heap-watchdog] snapshot written: ${file}`)
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[heap-watchdog] snapshot write failed', err)
    // Reset the gate so a later sample can retry once the immediate
    // pressure subsides. We deliberately do not retry inside this
    // tick — the failure most likely IS heap exhaustion.
    snapshotWritten = false
  }
}
