// src/main/performance/heapWatchdog.ts
//
// Heap-pressure watchdog for the Electron main process.
//
// WHY this exists: Agent Code long-running sessions have OOMed the main
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

import { spawn } from 'node:child_process'
import { writeHeapSnapshot, getHeapStatistics } from 'node:v8'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { app } from 'electron'

import { HEAP_SNAPSHOT_DIR } from '@main/storage/paths.js'
import { getAppRunId } from '@main/incident/appRunIds.js'

// Threshold rationale: use the lower of 3 GiB and 75% of the ACTUAL
// V8 heap limit for this Electron process. The original watchdog used
// a fixed 3 GiB threshold because the first observed crash had a ~4 GiB
// main-process heap cap. A later crash on 2026-05-11 died around
// 1.2 GiB old-space, so the fixed threshold never fired. The heap cap
// varies with Electron/Node flags and process mode; measuring it at
// runtime is the only threshold that works across dev/prod launches.
const HEAP_USED_TRIP_BYTES = 3 * 1024 * 1024 * 1024
// Lowered from 0.75 after a real OOM aborted at ~0.67 of the limit: a large
// allocation can fail well below the heap limit, so trip a bit earlier to give
// the snapshot a chance. (Large single-allocation aborts are fundamentally
// caught by the Crashpad minidump + prior-run classifier, not by polling — this
// only widens the window for the gradual / fast-climb cases.)
const HEAP_LIMIT_TRIP_RATIO = 0.70

// Adaptive sampling: 30 s at rest (heap pressure usually builds over hours), but
// drop to 2 s once we cross HALF the limit so a FAST runaway has a chance to be
// sampled before the abort. The real crash that motivated this went ~1.1 GB →
// ~2.7 GB in under 5 s — a 30 s poll never saw it.
const SAMPLE_INTERVAL_MS = 30_000
const FAST_SAMPLE_INTERVAL_MS = 2_000
const FAST_SAMPLE_PRESSURE_RATIO = 0.5

// Forensic callback, fired once when the watchdog trips and a snapshot is
// written. It lets the always-on incident journal record a heap.pressure
// incident (with the snapshot path) WITHOUT coupling the watchdog to the journal
// type — the watchdog stays a self-contained, independently-testable module.
export type HeapPressureInfo = {
  heapUsed: number
  heapLimit: number
  rss: number
  uptimeMs: number
  snapshotPath: string
}

let watchdogTimer: NodeJS.Timeout | null = null
let watchdogStopped = false
let snapshotWritten = false
let onHeapPressure: ((info: HeapPressureInfo) => void) | null = null

export function startMainHeapWatchdog(opts?: {
  onHeapPressure?: (info: HeapPressureInfo) => void
}): void {
  if (watchdogTimer || watchdogStopped) return
  onHeapPressure = opts?.onHeapPressure ?? null
  scheduleNextSample(SAMPLE_INTERVAL_MS)
}

// setTimeout recursion (not setInterval) so each sample can pick the NEXT delay
// from the current pressure — fast under load, lazy at rest.
function scheduleNextSample(delayMs: number): void {
  watchdogTimer = setTimeout(() => {
    void sampleAndMaybeSnapshot().then(pressureRatio => {
      if (watchdogStopped) return
      scheduleNextSample(
        pressureRatio >= FAST_SAMPLE_PRESSURE_RATIO ? FAST_SAMPLE_INTERVAL_MS : SAMPLE_INTERVAL_MS,
      )
    })
  }, delayMs)
  watchdogTimer.unref()
}

export function stopMainHeapWatchdog(): void {
  watchdogStopped = true
  if (watchdogTimer) {
    clearTimeout(watchdogTimer)
    watchdogTimer = null
  }
}

async function sampleAndMaybeSnapshot(): Promise<number> {
  const stats = getHeapStatistics()
  // used_heap_size is the metric we care about: total_heap_size can
  // briefly inflate from internal fragmentation without being close to
  // the limit. used_heap_size is what the v8 fatal-error report shows.
  const heapUsed = stats.used_heap_size
  const limit = stats.heap_size_limit
  // Ratio drives the adaptive sample cadence (see scheduleNextSample).
  const pressureRatio = limit > 0 ? heapUsed / limit : 0
  const tripAt = Math.min(HEAP_USED_TRIP_BYTES, limit * HEAP_LIMIT_TRIP_RATIO)
  if (heapUsed < tripAt) return pressureRatio
  if (snapshotWritten) return pressureRatio
  snapshotWritten = true

  const dir = HEAP_SNAPSHOT_DIR
  try {
    await mkdir(dir, { recursive: true })
  } catch (err) {
    // Best-effort: if mkdir fails we still try writeHeapSnapshot in
    // CWD because the snapshot is the load-bearing artifact, not the
    // tidy directory layout.
    // eslint-disable-next-line no-console
    console.warn('[heap-watchdog] mkdir failed', err)
  }
  // Stamp the snapshot with the canonical appRunId so it correlates with the
  // heap.pressure incident and the rest of this run's diagnostics by one key.
  // (Single-shot per run, so one snapshot per id; retention only keys off the
  // .heapsnapshot suffix, so the name shape is free to change.)
  const file = join(dir, `main-${getAppRunId()}.heapsnapshot`)
  // eslint-disable-next-line no-console
  console.warn(
    `[heap-watchdog] heapUsed=${heapUsed} limit=${limit} tripAt=${Math.round(tripAt)} → writing snapshot to ${file}`,
  )
  try {
    writeHeapSnapshot(file)
    // eslint-disable-next-line no-console
    console.warn(`[heap-watchdog] snapshot written: ${file}`)
    // Turn the silent snapshot into a durable incident: tell the journal (if
    // wired) that we crossed the heap-pressure threshold and where the snapshot
    // landed. Defensive — recording an incident must never destabilize the
    // capture path, which by definition runs near-OOM.
    try {
      const memory = process.memoryUsage()
      onHeapPressure?.({
        heapUsed,
        heapLimit: limit,
        rss: memory.rss,
        uptimeMs: Math.round(process.uptime() * 1000),
        snapshotPath: file,
      })
    } catch {
      // best-effort
    }
    // Auto-summarize the snapshot we just wrote (#288). Best-effort, fully
    // defensive: a failure here must NEVER propagate into or block the
    // watchdog/capture path, which runs under memory pressure.
    maybeLogHeapSummary(file)
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[heap-watchdog] snapshot write failed', err)
    // Reset the gate so a later sample can retry once the immediate
    // pressure subsides. We deliberately do not retry inside this
    // tick — the failure most likely IS heap exhaustion.
    snapshotWritten = false
  }
  return pressureRatio
}

// ---------------------------------------------------------------------------
// #288 PART B: auto-summary of the snapshot we just captured.
// ---------------------------------------------------------------------------
//
// WHY a CHILD PROCESS, never inline: parsing a 120–300 MB .heapsnapshot means
// JSON.parse-ing the whole document and building several aggregation maps. Doing
// that in THIS process would spike the very heap we are trying to measure —
// possibly tipping us straight into the OOM we were trying to forensically
// capture. The analyzer (scripts/analyze-heapsnapshot.mjs) is therefore spawned
// as a separate `node` process with its own --max-old-space-size budget, and we
// merely tee the first chunk of its stdout into the main log with a
// `[heap-summary]` prefix.
//
// WHY fully defensive (swallow everything): this runs on the capture path,
// which by definition fires when the process is already near-OOM. Nothing here
// may throw, block, or keep the event loop alive. spawn() is async; we attach
// listeners and return immediately. Any error — script missing, node missing,
// spawn EACCES, malformed snapshot — is caught and logged at most once.
//
// WHY gated (env flag OR dev): the analyzer script lives in the repo `scripts/`
// directory, which is a DEV-TIME artifact. It is NOT copied into the packaged
// app by scripts/copy-packaged-resources.mjs, so in a packaged build
// `app.getAppPath()/scripts/analyze-heapsnapshot.mjs` does not exist. Rather
// than guess where (or whether) scripts land in the asar, we gate the
// auto-summary to non-packaged runs OR an explicit opt-in env flag
// AGENT_CODE_HEAP_SUMMARY=1. When PART A's packaging story is settled (#288
// follow-up), the resolver below is the single place to extend. Until then the
// watchdog's load-bearing behavior — writing the snapshot — is unchanged in
// packaged builds; only the convenience summary is dev/flag-gated.
function maybeLogHeapSummary(snapshotPath: string): void {
  try {
    const optedIn = process.env.AGENT_CODE_HEAP_SUMMARY === '1'
    // app.isPackaged can throw if app is unavailable in some test harnesses;
    // it's inside the try, so a throw just disables the summary.
    const packaged = app.isPackaged
    if (packaged && !optedIn) return

    // Resolve the analyzer relative to the app root. In dev `getAppPath()` is
    // the repo root, where `scripts/` lives. In a packaged build this path
    // very likely does not exist — hence the gate above — but we still guard
    // by letting spawn fail harmlessly if it's absent.
    const scriptPath = join(app.getAppPath(), 'scripts', 'analyze-heapsnapshot.mjs')

    const child = spawn(
      process.execPath,
      ['--max-old-space-size=4096', scriptPath, snapshotPath, '--top', '20'],
      {
        // stdin ignored; stdout piped so we can tee a few summary lines.
        // stderr is 'ignore' (review fix #2): we previously piped stderr but
        // never attached a 'data' listener to drain it. A piped stream that is
        // never read has a bounded OS pipe buffer (~64 KB); if the analyzer
        // wrote more than that to stderr — e.g. a V8 GC/--trace warning, an
        // ELIFECYCLE dump, or a stack trace on a malformed snapshot — it would
        // block on write() against a full pipe and hang indefinitely, holding
        // the child alive on the very capture path that must stay non-blocking.
        // 'ignore' routes the child's stderr to /dev/null so it can never
        // back-pressure; we don't surface analyzer stderr in the log anyway, so
        // nothing is lost. stdout stays piped+drained for the summary tee below.
        // detached:false so the child dies with us if we exit — we don't want a
        // runaway analyzer outliving a crash.
        stdio: ['ignore', 'pipe', 'ignore'],
        // ELECTRON_RUN_AS_NODE makes the Electron binary behave as plain node,
        // so process.execPath (the Electron exe) can run a .mjs script.
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      },
    )

    // Collect stdout and emit only the first ~25 lines. We cap the buffer so a
    // misbehaving child can't grow our heap; once we have enough we stop.
    let buf = ''
    let done = false
    const MAX_LINES = 25
    const emit = (): void => {
      if (done) return
      done = true
      const lines = buf.split('\n').slice(0, MAX_LINES)
      for (const line of lines) {
        // eslint-disable-next-line no-console
        console.warn(`[heap-summary] ${line}`)
      }
    }
    child.stdout?.on('data', (chunk: Buffer) => {
      // Once emit() has fired (done=true) the summary is already logged, so
      // there's nothing left to buffer (review nit #5): keep appending and the
      // re-split would just churn the heap on a child that's still streaming
      // its (now-irrelevant) tail. Early-return so post-emit chunks are dropped
      // cheaply; the child still drains naturally and exits on its own.
      if (done) return
      if (buf.length < 64 * 1024) buf += chunk.toString('utf8')
      if (buf.split('\n').length > MAX_LINES) emit()
    })
    child.on('close', emit)
    // Swallow spawn/runtime errors entirely — the summary is a nicety.
    child.on('error', (err) => {
      // eslint-disable-next-line no-console
      console.warn('[heap-summary] analyzer spawn failed (non-fatal)', err)
    })
    // Never let this child keep the process alive.
    child.unref()
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[heap-summary] skipped (non-fatal)', err)
  }
}
