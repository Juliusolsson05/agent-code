import type {
  MonitorHistoryPage, MonitorHistoryPoint, MonitorHistoryStatus,
  MonitorReportPreview, MonitorReportResult, MonitorWorkerQueryResult,
} from './monitorHistory.js'
import { parseIncidentSummary, parseMonitorIncident } from './parseMonitorIncident.js'
import { MONITOR_POLICY } from './monitorPolicy.js'

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER
const nullable = (value: unknown): value is number | null => value === null || finite(value)
const utf8 = new TextEncoder()

export function parseMonitorHistoryStatus(value: unknown): MonitorHistoryStatus | null {
  if (!object(value) || Object.keys(value).length !== 8 || !['healthy', 'degraded', 'unavailable'].includes(value.state as string)
    || !finite(value.bytes) || !nullable(value.oldestAt) || !nullable(value.newestAt) || !finite(value.points)
    || !finite(value.incidents) || typeof value.exporting !== 'boolean' || typeof value.shortened !== 'boolean') return null
  return value as MonitorHistoryStatus
}

export function parseMonitorHistoryPoint(value: unknown): MonitorHistoryPoint | null {
  if (!object(value) || Object.keys(value).length !== 9 || value.schemaVersion !== 1 || !finite(value.at)
    || !['1s', '10s', '1m'].includes(value.resolution as string) || !finite(value.workerRss)
    || !finite(value.droppedRecords) || !finite(value.restarts) || !object(value.windows)) return null
  const main = value.main
  if (main !== null && (!object(main) || Object.keys(main).length !== 7 || !nullable(main.cpuPercent)
    || !finite(main.rss) || !finite(main.heapUsed) || !finite(main.heapLimit)
    || !nullable(main.loopP99Ms) || !nullable(main.loopMaxMs) || typeof main.sleepGap !== 'boolean')) return null
  const processes = value.processes
  if (processes !== null && (!object(processes) || Object.keys(processes).length !== 5 || !nullable(processes.cpuPercent)
    || !nullable(processes.memoryBytes) || !finite(processes.count) || !finite(processes.sessionCount)
    || !['ok', 'warming-up', 'stale', 'unsupported', 'partial'].includes(processes.quality as string))) return null
  if (Object.keys(value.windows).length !== 5 || !finite(value.windows.count) || !finite(value.windows.visible)
    || !finite(value.windows.maxLagMs) || !finite(value.windows.longTaskMs) || !finite(value.windows.maxInputMs)) return null
  return value as MonitorHistoryPoint
}

function parsePage(value: unknown): MonitorHistoryPage | null {
  if (!object(value) || Object.keys(value).length !== 8 || !['1s', '10s', '1m'].includes(value.resolution as string)
    || !finite(value.from) || !finite(value.to) || !Array.isArray(value.points) || value.points.length > 1000
    || !Array.isArray(value.incidents) || value.incidents.length > 50
    || (value.nextCursor !== null && (typeof value.nextCursor !== 'string' || !/^\d{1,7}$/.test(value.nextCursor)))
    || typeof value.complete !== 'boolean') return null
  const status = parseMonitorHistoryStatus(value.status)
  const points = value.points.map(parseMonitorHistoryPoint)
  const incidents = value.incidents.map(parseIncidentSummary)
  if (!status || points.some(point => point === null) || incidents.some(incident => incident === null)) return null
  return { ...value, points: points as MonitorHistoryPoint[], incidents: incidents as MonitorHistoryPage['incidents'], status } as MonitorHistoryPage
}

function parsePreview(value: unknown): MonitorReportPreview | null {
  if (!object(value) || Object.keys(value).length !== 6 || !finite(value.from) || !finite(value.to)
    || !finite(value.estimatedBytes) || value.estimatedBytes > 8 * 1024 * 1024 || value.localOnly !== true
    || !Array.isArray(value.dataClasses) || value.dataClasses.length > 5
    || value.dataClasses.some(item => !['metrics', 'operations', 'incidents', 'coverage', 'build'].includes(item))) return null
  const status = parseMonitorHistoryStatus(value.status)
  return status ? { ...value, status } as MonitorReportPreview : null
}

function parseReportResult(value: unknown): MonitorReportResult | null {
  if (!object(value) || typeof value.ok !== 'boolean') return null
  if (!value.ok) return Object.keys(value).length === 2 && ['cancelled', 'busy', 'write-failed', 'invalid-range', 'unavailable'].includes(value.code as string)
    ? value as MonitorReportResult : null
  return Object.keys(value).length === 5 && typeof value.path === 'string' && value.path.length <= 4096
    && finite(value.bytes) && value.bytes <= 8 * 1024 * 1024 && finite(value.points) && finite(value.incidents)
    ? value as MonitorReportResult : null
}

export function parseMonitorWorkerQueryResult(value: unknown): MonitorWorkerQueryResult | null {
  // Shape limits alone do not cap structured-clone size when every numeric
  // field uses its longest legal representation. Main enforces the same byte
  // ceiling advertised by policy before accepting a helper query response.
  try { if (utf8.encode(JSON.stringify(value)).byteLength > MONITOR_POLICY.queryBytes) return null }
  catch { return null }
  if (!object(value) || Object.keys(value).length !== 2 || typeof value.kind !== 'string') return null
  if (value.kind === 'incident' || value.kind === 'history-incident') {
    if (value.value === null) return { kind: value.kind, value: null }
    const incident = parseMonitorIncident(value.value)
    return incident ? { kind: value.kind, value: incident } as MonitorWorkerQueryResult : null
  }
  if (value.kind === 'history') { const page = parsePage(value.value); return page ? { kind: 'history', value: page } : null }
  if (value.kind === 'history-status' || value.kind === 'history-clear') {
    const status = parseMonitorHistoryStatus(value.value)
    return status ? { kind: value.kind, value: status } : null
  }
  if (value.kind === 'report-preview') { const preview = parsePreview(value.value); return preview ? { kind: 'report-preview', value: preview } : null }
  if (value.kind === 'report-export') { const result = parseReportResult(value.value); return result ? { kind: 'report-export', value: result } : null }
  if (value.kind === 'history-flush' && value.value === true) return { kind: 'history-flush', value: true }
  return null
}
