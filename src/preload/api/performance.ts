import { ipcRenderer } from 'electron'

import type {
  PerformanceConfig,
  PanePerformanceSnapshot,
  PerformanceRecord,
  PerformanceSnapshot,
  SystemPerformanceStats,
} from '@shared/performance/types.js'

export const performanceApi = {
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
}
