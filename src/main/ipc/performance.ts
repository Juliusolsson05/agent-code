import { ipcMain } from 'electron'

import { performanceService } from '@main/performance/PerformanceService.js'
import { ProcessTelemetry } from '@main/performance/ProcessTelemetry.js'
import type { SessionManager } from '@main/sessionManager.js'
import type { PerformanceRecord } from '@shared/performance/types.js'

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
}
