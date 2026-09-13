import type { MonitorIncident } from '@shared/performance/monitorIncidents.js'
import type { MonitorHistoryPage, MonitorHistoryStatus, MonitorReportPreview, MonitorReportResult, MonitorTraceStatus } from '@shared/performance/monitorHistory.js'
import { acceptMonitorResponse, beginMonitorResponse, cancelMonitorResponse, completeMonitorResponse } from '../monitorOperations.js'
import type { MonitorProcessPage } from '@shared/performance/processSnapshot.js'
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

let incidentRead: Promise<MonitorIncident | null> | null = null
let monitorBatchInFlight = false
let monitorSnapshotRead: Promise<MonitorSnapshot | null> | null = null
let processReadInFlight = false
export const performanceApi = {
  beginMonitorResponse,
  acceptMonitorResponse,
  cancelMonitorResponse,
  completeMonitorResponse,
  getMonitorIncident: (id: number): Promise<MonitorIncident | null> => {
    if (incidentRead) return Promise.resolve(null)
    incidentRead = ipcRenderer.invoke('performance:monitor-incident', id).finally(() => { incidentRead = null })
    return incidentRead!
  },
  getMonitorHistoryIncident: (at: number, id: number): Promise<MonitorIncident | null> =>
    ipcRenderer.invoke('performance:monitor-history-incident', at, id),
  getMonitorHistory: (from: number, to: number, cursor?: string, limit = 500): Promise<MonitorHistoryPage | null> =>
    ipcRenderer.invoke('performance:monitor-history', from, to, cursor, limit),
  previewMonitorReport: (from: number, to: number): Promise<MonitorReportPreview | null> =>
    ipcRenderer.invoke('performance:monitor-report-preview', from, to),
  saveMonitorReport: (from: number, to: number): Promise<MonitorReportResult> =>
    ipcRenderer.invoke('performance:monitor-save-report', from, to),
  clearMonitorHistory: (): Promise<MonitorHistoryStatus | null> =>
    ipcRenderer.invoke('performance:monitor-clear-history'),
  getMonitorTraceStatus: (): Promise<MonitorTraceStatus | null> =>
    ipcRenderer.invoke('performance:monitor-trace-status'),
  startMonitorTrace: (mode: 'chromium' | 'main-cpu', durationMs = 30_000): Promise<MonitorTraceStatus | null> =>
    ipcRenderer.invoke('performance:monitor-start-trace', mode, durationMs),
  stopMonitorTrace: (cancel = false): Promise<MonitorTraceStatus | null> =>
    ipcRenderer.invoke('performance:monitor-stop-trace', cancel),
  getMonitorProcesses: async (offset = 0, sort: 'cpu' | 'memory' = 'cpu'): Promise<MonitorProcessPage | null> => {
    if (processReadInFlight) return null
    processReadInFlight = true
    try { return await ipcRenderer.invoke('performance:monitor-processes', offset, sort) }
    finally { processReadInFlight = false }
  },
  getMonitorSnapshot: (): Promise<MonitorSnapshot | null> => {
    // Closing/reopening a dialog while main is frozen must not bypass the
    // per-mount request bound. One shared promise also handles StrictMode.
    if (!monitorSnapshotRead) monitorSnapshotRead = ipcRenderer.invoke('performance:monitor-snapshot')
      .finally(() => { monitorSnapshotRead = null })
    return monitorSnapshotRead!
  },
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
