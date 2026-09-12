import { parseIncidentSummary } from './parseMonitorIncident.js'
import { parseMonitorRendererRecord } from './monitorContracts.js'
import { isLatencyHistogram } from './latencyHistogram.js'
import type { MonitorMainSample, MonitorWorkerSnapshot } from './monitorSnapshot.js'

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER
const nullable = (value: unknown): value is number | null => value === null || finite(value)
function mainSample(value: unknown): MonitorMainSample | null {
  if (!object(value) || Object.keys(value).length !== 9 || !finite(value.at) || !nullable(value.cpuPercent)
    || !finite(value.rss) || !finite(value.heapUsed) || !finite(value.heapLimit) || !nullable(value.loopMeanMs)
    || !nullable(value.loopP99Ms) || !nullable(value.loopMaxMs) || typeof value.sleepGap !== 'boolean') return null
  return { at: value.at, cpuPercent: value.cpuPercent, rss: value.rss, heapUsed: value.heapUsed, heapLimit: value.heapLimit,
    loopMeanMs: value.loopMeanMs, loopP99Ms: value.loopP99Ms, loopMaxMs: value.loopMaxMs, sleepGap: value.sleepGap }
}

/** A bundled worker is trusted code, but skewed or malformed responses must
 * degrade diagnostics rather than throwing through main's fatal error hook.
 * Validate/copy every retained field before acknowledging or replacing state. */
export function parseMonitorSnapshot(value: unknown): MonitorWorkerSnapshot | null {
  if (!object(value) || (Object.keys(value).length !== 7 && Object.keys(value).length !== 8) || value.schemaVersion !== 1
    || !finite(value.sampledAt) || !finite(value.workerRss)
    || !Array.isArray(value.windows) || value.windows.length > 64
    || !Array.isArray(value.recent) || value.recent.length > 120
    || !Array.isArray(value.operations) || value.operations.length > 100) return null
  const incidents = value.incidents === undefined ? [] : Array.isArray(value.incidents) && value.incidents.length <= 50 ? value.incidents.map(parseIncidentSummary) : null
  if (!incidents || incidents.some(row => !row)) return null
  const main = value.main === null ? null : mainSample(value.main)
  if (value.main !== null && !main) return null
  const recent: MonitorWorkerSnapshot['recent'] = []
  for (const row of value.recent) { const sample = mainSample(row); if (!sample) return null; recent.push(sample) }
  const windows: MonitorWorkerSnapshot['windows'] = []
  for (const row of value.windows) {
    if (!object(row)) return null
    const { windowId, receivedAt, longTasksSupported, inputSupported, ...record } = row
    if (!finite(windowId) || !Number.isSafeInteger(windowId) || !finite(receivedAt)
      || typeof longTasksSupported !== 'boolean' || typeof inputSupported !== 'boolean') return null
    const parsed = parseMonitorRendererRecord(record)
    if (parsed?.kind !== 'heartbeat') return null
    windows.push({ ...parsed, windowId, receivedAt, longTasksSupported, inputSupported })
  }
  const operations: MonitorWorkerSnapshot['operations'] = []
  for (const row of value.operations) {
    if (!object(row) || Object.keys(row).length !== 3 || !isLatencyHistogram(row.histogram)) return null
    const parsed = parseMonitorRendererRecord({ kind: 'operation', name: row.name, outcome: row.outcome, durationMs: 0 })
    if (parsed?.kind !== 'operation') return null
    operations.push({ name: parsed.name, outcome: parsed.outcome, histogram: {
      count: row.histogram.count, counts: [...row.histogram.counts], sumMs: row.histogram.sumMs, maxMs: row.histogram.maxMs,
    } })
  }
  return { schemaVersion: 1, sampledAt: value.sampledAt, main, windows, operations, recent, workerRss: value.workerRss, ...(value.incidents === undefined ? {} : { incidents: incidents as NonNullable<MonitorWorkerSnapshot['incidents']> }) }
}
