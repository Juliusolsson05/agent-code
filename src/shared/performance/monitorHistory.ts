import type { MonitorIncident, MonitorIncidentSummary } from './monitorIncidents.js'

export type MonitorHistoryResolution = '1s' | '10s' | '1m'
export type MonitorHistoryPoint = {
  schemaVersion: 1
  at: number
  resolution: MonitorHistoryResolution
  main: null | { cpuPercent: number | null; rss: number; heapUsed: number; heapLimit: number; loopP99Ms: number | null; loopMaxMs: number | null; sleepGap: boolean }
  processes: null | { cpuPercent: number | null; memoryBytes: number | null; count: number; sessionCount: number; quality: string }
  windows: { count: number; visible: number; maxLagMs: number; longTaskMs: number; maxInputMs: number }
  workerRss: number
  droppedRecords: number
  restarts: number
}

export type MonitorHistoryStatus = {
  state: 'healthy' | 'degraded' | 'unavailable'
  bytes: number
  oldestAt: number | null
  newestAt: number | null
  points: number
  incidents: number
  exporting: boolean
  shortened: boolean
}

export type MonitorHistoryPage = {
  resolution: MonitorHistoryResolution
  from: number
  to: number
  points: MonitorHistoryPoint[]
  incidents: MonitorIncidentSummary[]
  nextCursor: string | null
  complete: boolean
  status: MonitorHistoryStatus
}

export type MonitorReportPreview = {
  from: number
  to: number
  estimatedBytes: number
  dataClasses: Array<'metrics' | 'operations' | 'incidents' | 'coverage' | 'build'>
  localOnly: true
  status: MonitorHistoryStatus
}

export type MonitorReportResult =
  | { ok: true; path: string; bytes: number; points: number; incidents: number }
  | { ok: false; code: 'cancelled' | 'busy' | 'write-failed' | 'invalid-range' | 'unavailable' }

/** Clear History is destructive and privacy-motivated, so the renderer must
 * learn whether data was actually deleted rather than infer it from a status. */
export type MonitorClearHistoryResult = {
  outcome: 'cleared' | 'cancelled' | 'busy' | 'unavailable' | 'failed'
  status: MonitorHistoryStatus | null
}

export type MonitorTraceMode = 'chromium' | 'main-cpu'
export type MonitorTraceStatus = {
  state: 'idle' | 'starting' | 'recording' | 'stopping' | 'complete' | 'failed' | 'cancelled' | 'unsupported'
  mode: MonitorTraceMode | null
  ownerWindowId: number | null
  startedAt: number | null
  endsAt: number | null
  path: string | null
  bytes: number | null
  truncated: boolean
  message: string | null
}

export type MonitorHistoryQuery = {
  kind: 'history'
  from: number
  to: number
  cursor?: string
  limit: number
}

export type MonitorWorkerQuery =
  | { kind: 'incident'; id: number }
  | { kind: 'history-incident'; at: number; id: number }
  | MonitorHistoryQuery
  | { kind: 'history-status' }
  | { kind: 'report-preview'; from: number; to: number }
  | { kind: 'report-export'; from: number; to: number; destination: string; build: Record<string, string | boolean> }
  | { kind: 'history-clear' }
  | { kind: 'history-flush' }

export type MonitorWorkerQueryResult =
  | { kind: 'incident'; value: MonitorIncident | null }
  | { kind: 'history-incident'; value: MonitorIncident | null }
  | { kind: 'history'; value: MonitorHistoryPage }
  | { kind: 'history-status'; value: MonitorHistoryStatus }
  | { kind: 'report-preview'; value: MonitorReportPreview }
  | { kind: 'report-export'; value: MonitorReportResult }
  | { kind: 'history-clear'; value: MonitorHistoryStatus }
  | { kind: 'history-flush'; value: true }
