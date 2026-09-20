import { INCIDENT_RULES } from './monitorIncidents.js'
import type { MonitorIncident, MonitorIncidentSummary, MonitorEvidencePoint } from './monitorIncidents.js'
import { MONITOR_OPERATIONS } from './monitorPolicy.js'
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER
const nullable = (value: unknown): value is number | null => value === null || finite(value)
export function parseIncidentSummary(value: unknown): MonitorIncidentSummary | null {
  if (!object(value) || Object.keys(value).length > 13 || !finite(value.id) || !Number.isSafeInteger(value.id)
    || value.ruleVersion !== 1 || !INCIDENT_RULES.includes(value.rule as never) || !finite(value.at) || !finite(value.scope)
    || !Number.isSafeInteger(value.scope) || !['warning', 'error'].includes(value.severity as string)
    || !finite(value.observed) || !finite(value.threshold) || !['capturing', 'complete', 'interrupted'].includes(value.state as string)
    || typeof value.truncated !== 'boolean' || !finite(value.evidenceCount) || value.evidenceCount > 160
    || (value.operation !== undefined && !MONITOR_OPERATIONS.includes(value.operation as never))) return null
  return { id: value.id, ruleVersion: 1, rule: value.rule as MonitorIncidentSummary['rule'], at: value.at, scope: value.scope,
    severity: value.severity as MonitorIncidentSummary['severity'], observed: value.observed, threshold: value.threshold,
    state: value.state as MonitorIncidentSummary['state'], truncated: value.truncated, evidenceCount: value.evidenceCount,
    ...(value.operation ? { operation: value.operation as MonitorIncidentSummary['operation'] } : {}) }
}
export function parseMonitorIncident(value: unknown): MonitorIncident | null {
  if (!object(value) || !Array.isArray(value.evidence) || value.evidence.length > 160) return null
  const { evidence: input, ...rest } = value
  const summary = parseIncidentSummary(rest)
  if (!summary || summary.evidenceCount !== input.length) return null
  const evidence: MonitorEvidencePoint[] = []
  for (const row of input) {
    if (!object(row) || Object.keys(row).length !== 8 || !finite(row.at) || !['main', 'window'].includes(row.kind as string)
      || !finite(row.scope) || !nullable(row.value) || !nullable(row.cpuPercent) || !nullable(row.heapRatio)
      || !nullable(row.longTaskMs) || typeof row.sleepGap !== 'boolean') return null
    evidence.push({ at: row.at, kind: row.kind as MonitorEvidencePoint['kind'], scope: row.scope, value: row.value,
      cpuPercent: row.cpuPercent, heapRatio: row.heapRatio, longTaskMs: row.longTaskMs, sleepGap: row.sleepGap })
  }
  return { ...summary, evidence }
}
