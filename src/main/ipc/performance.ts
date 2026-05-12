import { ipcMain } from 'electron'
import { getHeapStatistics } from 'node:v8'

import { performanceService } from '@main/performance/PerformanceService.js'
import { ProcessTelemetry } from '@main/performance/ProcessTelemetry.js'
import type { SessionManager } from '@main/sessionManager.js'
import type {
  PerformanceRecord,
  SystemPerformanceStats,
} from '@shared/performance/types.js'

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
  // WHY synchronous-style handler (no I/O): the renderer polls this
  // at 1 Hz to drive the always-visible badge + sparkline. Anything
  // beyond `process.memoryUsage()` + `v8.getHeapStatistics()` would
  // be wasted work on every tick — both calls are cheap and return
  // immediately without touching disk.
  //
  // WHY gated on performanceService.getConfig().enabled (which
  // mirrors AGENT_CODE_PERF, with CC_SHELL_PERF kept as a legacy alias:
  // the badge is an opt-in diagnostic, not
  // a feature for end users. When disabled we still respond with a
  // valid shape (enabled: false plus zeros) so the renderer hook
  // can detect the gate on its first probe without throwing. The
  // poller stops after seeing enabled=false; subsequent ticks
  // never fire so the zero values are never displayed.
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
    }
  })
}
