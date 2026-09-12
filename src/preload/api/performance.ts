import type { MonitorSnapshot } from '@shared/performance/monitorSnapshot.js'
import { parseMonitorRendererBatch } from '@shared/performance/monitorContracts.js'
import type { MonitorRendererRecord } from '@shared/performance/monitorContracts.js'
import { ipcRenderer } from 'electron'

import type {
  PerformanceConfig,
  PanePerformanceSnapshot,
  PerformanceRecord,
  PerformanceSnapshot,
  SystemPerformanceStats,
} from '@shared/performance/types.js'

let monitorBatchInFlight = false
export const performanceApi = {
  getMonitorSnapshot: (): Promise<MonitorSnapshot | null> => ipcRenderer.invoke('performance:monitor-snapshot'),
  appendMonitorRecords: async (records: MonitorRendererRecord[]): Promise<boolean> => {
    if (monitorBatchInFlight) return false
    const parsed = parseMonitorRendererBatch(records)
    if (!parsed) return false
    monitorBatchInFlight = true
    try {
      await ipcRenderer.invoke('performance:monitor-batch', parsed)
      return true
    } finally { monitorBatchInFlight = false }
  },
  getPerformanceConfig: (): Promise<PerformanceConfig> =>
    ipcRenderer.invoke('performance:get-config'),

  appendPerformanceRecords: (records: PerformanceRecord[]): Promise<void> =>
    ipcRenderer.invoke('performance:batch', records),

  flushPerformance: (): Promise<void> =>
    ipcRenderer.invoke('performance:flush'),

  getPerformanceSnapshot: (): Promise<PerformanceSnapshot> =>
    ipcRenderer.invoke('performance:snapshot'),

  getPanePerformanceStats: (sessionIds: string[]): Promise<PanePerformanceSnapshot> =>
    ipcRenderer.invoke('performance:pane-stats', sessionIds),

  getSystemPerformanceStats: (): Promise<SystemPerformanceStats> =>
    ipcRenderer.invoke('performance:system-stats'),

  writeHeapSnapshot: (): Promise<
    { ok: true; path: string } | { ok: false; error: string }
  > => ipcRenderer.invoke('performance:write-heap-snapshot'),

  revealPath: (path: string): Promise<void> =>
    ipcRenderer.invoke('performance:reveal-path', path),
}
