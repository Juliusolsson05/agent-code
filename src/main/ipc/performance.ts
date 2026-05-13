import { ipcMain, shell } from 'electron'
import { getHeapSpaceStatistics, getHeapStatistics, writeHeapSnapshot } from 'node:v8'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { performanceService } from '@main/performance/PerformanceService.js'
import { ProcessTelemetry } from '@main/performance/ProcessTelemetry.js'
import { STATE_DIR } from '@main/storage/paths.js'
import type { SessionManager } from '@main/sessionManager.js'
import type {
  HeapSpaceStats,
  PerformanceRecord,
  SystemPerformanceStats,
} from '@shared/performance/types.js'

// Local event-loop monitor for the system-stats handler.
//
// WHY we own a dedicated monitor here instead of borrowing
// PerformanceService's own monitorEventLoopDelay():
//
//  - PerformanceService samples + resets its histogram on a 5 s
//    cadence. Reading its current state from the 1 Hz IPC handler
//    would race that probe and give us either stale or partial
//    windows depending on timing.
//  - The "current event-loop delay over the last second" answer the
//    popover wants is structurally a per-poll question. A local
//    monitor that resets on each read gives exactly the right window.
//  - The cost of running a second monitor is negligible (`resolution`
//    is the sample interval; perf_hooks samples on a libuv timer
//    that fires whether or not anyone is reading the histogram).
//
// We initialize lazily on the first system-stats call so that when
// AGENT_CODE_PERF is off and the renderer never calls in, we don't
// spin up the monitor at all.
const EVENT_LOOP_RESOLUTION_MS = 20
let eventLoopMonitor: ReturnType<typeof monitorEventLoopDelay> | null = null

function readAndResetEventLoopDelay(): SystemPerformanceStats['eventLoopDelay'] {
  if (!eventLoopMonitor) {
    eventLoopMonitor = monitorEventLoopDelay({ resolution: EVENT_LOOP_RESOLUTION_MS })
    eventLoopMonitor.enable()
    // First read after enabling has no data yet — return null so the
    // popover can show "—" instead of misleading zeros.
    return null
  }
  const meanMs = eventLoopMonitor.mean / 1e6
  const maxMs = eventLoopMonitor.max / 1e6
  const p99Ms = eventLoopMonitor.percentile(99) / 1e6
  eventLoopMonitor.reset()
  // perf_hooks reports Infinity for max/p99 before the first sample
  // lands in a fresh histogram. Coerce those to 0 so the popover
  // doesn't render "Infinity ms" the second after a reset.
  return {
    meanMs: Number.isFinite(meanMs) ? meanMs : 0,
    maxMs: Number.isFinite(maxMs) ? maxMs : 0,
    p99Ms: Number.isFinite(p99Ms) ? p99Ms : 0,
  }
}

function readHeapSpaces(): HeapSpaceStats[] {
  // v8.getHeapSpaceStatistics returns snake_case fields; we re-map
  // to camelCase at the boundary so the popover doesn't have to fight
  // the project's TypeScript style for what is purely a transport
  // detail. Cheap (single allocation per space, ~8 entries).
  return getHeapSpaceStatistics().map(entry => ({
    spaceName: entry.space_name,
    spaceSize: entry.space_size,
    spaceUsedSize: entry.space_used_size,
    spaceAvailableSize: entry.space_available_size,
    physicalSpaceSize: entry.physical_space_size,
  }))
}

export function registerPerformanceIpc(manager: SessionManager): void {
  const processTelemetry = new ProcessTelemetry(manager)

  ipcMain.handle('performance:get-config', () => performanceService.getConfig())

  ipcMain.handle('performance:batch', async (_evt, records: PerformanceRecord[]) => {
    if (!Array.isArray(records) || records.length === 0) return
    performanceService.recordBatch(records)
  })

  ipcMain.handle('performance:flush', async () => {
    await performanceService.flush()
  })

  ipcMain.handle('performance:snapshot', async () => performanceService.snapshot())

  ipcMain.handle('performance:pane-stats', async (_evt, sessionIds?: string[]) =>
    processTelemetry.snapshot(Array.isArray(sessionIds) ? sessionIds : undefined),
  )

  // Main-process heap + RSS snapshot for the header badge.
  //
  // WHY this single handler returns BOTH the basic aggregate numbers
  // (heapUsed/heapTotal/heapLimit/rss/external/arrayBuffers) and the
  // deep-dive fields (per-space breakdown, detached/native contexts,
  // event-loop delay):
  //
  //  - The popover wants ONE consistent timestamped sample to render
  //    against. Splitting into two IPC calls would put us into the
  //    "the chart line is from t and the table row is from t+50ms"
  //    failure mode — small but visible jitter for the user.
  //  - All the calls underneath (process.memoryUsage,
  //    v8.getHeapStatistics, v8.getHeapSpaceStatistics,
  //    monitorEventLoopDelay.percentile) are O(1) and don't touch
  //    disk. The combined work per tick is well under a millisecond.
  //  - The renderer poller already discards the payload entirely
  //    when `enabled: false` — gating per-field would add complexity
  //    for no win.
  //
  // WHY gated on performanceService.getConfig().enabled (which
  // mirrors AGENT_CODE_PERF, with CC_SHELL_PERF kept as a legacy
  // alias): the badge is an opt-in diagnostic, not a feature for end
  // users. When disabled we still respond with a valid shape so the
  // renderer hook can detect the gate on its first probe without
  // throwing. The poller stops after seeing enabled=false;
  // subsequent ticks never fire so the zero values are never
  // displayed.
  ipcMain.handle('performance:system-stats', (): SystemPerformanceStats => {
    const enabled = performanceService.getConfig().enabled
    if (!enabled) {
      return {
        enabled: false,
        sampledAt: Date.now(),
        heapUsed: 0,
        heapTotal: 0,
        heapLimit: 0,
        rss: 0,
        external: 0,
        arrayBuffers: 0,
        heapSpaces: [],
        detachedContexts: 0,
        nativeContexts: 0,
        eventLoopDelay: null,
      }
    }
    const mem = process.memoryUsage()
    const heap = getHeapStatistics()
    return {
      enabled: true,
      sampledAt: Date.now(),
      heapUsed: heap.used_heap_size,
      heapTotal: heap.total_heap_size,
      heapLimit: heap.heap_size_limit,
      rss: mem.rss,
      external: mem.external,
      arrayBuffers: mem.arrayBuffers,
      heapSpaces: readHeapSpaces(),
      // These two come from the same getHeapStatistics() call above
      // — v8 reports them as siblings of used_heap_size in the same
      // struct, so no extra cost. Native contexts ≈ BrowserWindow
      // count + service workers (normally 1–3 in this app); detached
      // contexts should be 0 always.
      detachedContexts: heap.number_of_detached_contexts ?? 0,
      nativeContexts: heap.number_of_native_contexts ?? 0,
      eventLoopDelay: readAndResetEventLoopDelay(),
    }
  })

  // On-demand heap snapshot. Writes a .heapsnapshot file the user
  // can load into Chrome DevTools' Memory tab to see retainer chains
  // and per-constructor instance counts — the gold-standard
  // diagnostic when the live numbers say "leak" but you need to know
  // WHICH object is being retained.
  //
  // WHY this is a separate handler instead of folding it into the
  // 1 Hz system-stats poll: writeHeapSnapshot is a multi-second
  // stop-the-world operation that produces a 100 MB-to-3 GB file. It
  // is appropriate behind an explicit "user clicked Capture" gesture,
  // never as a passive sample.
  //
  // WHY we return the file path: the popover's button can then call
  // shell.showItemInFolder via a follow-up IPC (or the user can
  // navigate to it manually). Returning the path also makes the
  // operation testable without scraping log output.
  //
  // WHY no AGENT_CODE_PERF gate: heap snapshots are a debugging
  // escape hatch, not telemetry. If the user has the popover open
  // (which already implies the flag is on, since the popover only
  // renders when enabled), letting them capture is the right move
  // regardless of the broader telemetry pipeline state.
  ipcMain.handle('performance:write-heap-snapshot', async (): Promise<{
    ok: true
    path: string
  } | {
    ok: false
    error: string
  }> => {
    const dir = join(STATE_DIR, 'heap-snapshots')
    try {
      await mkdir(dir, { recursive: true })
    } catch (err) {
      // mkdir failure is recoverable — writeHeapSnapshot still tries
      // CWD as a fallback inside v8 — but log it so future-me sees
      // the actual failure mode if the snapshot ends up somewhere
      // surprising.
      console.warn('[perf-snapshot] mkdir failed', err)
    }
    const file = join(
      dir,
      `manual-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}.heapsnapshot`,
    )
    try {
      writeHeapSnapshot(file)
      return { ok: true, path: file }
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  })

  // Reveal the snapshot file in Finder / Explorer.
  //
  // WHY a separate handler instead of doing shell.showItemInFolder
  // inside write-heap-snapshot: writing the file can take seconds.
  // If we revealed inside the same handler, the renderer would block
  // on a long IPC roundtrip while the user is also waiting on the
  // snapshot. Splitting them means the renderer can show a "Captured
  // → click to reveal" state immediately after the path is returned,
  // and reveal becomes a separate near-instant IPC.
  ipcMain.handle('performance:reveal-path', async (_evt, path: string): Promise<void> => {
    if (typeof path !== 'string' || !path) return
    shell.showItemInFolder(path)
  })
}
