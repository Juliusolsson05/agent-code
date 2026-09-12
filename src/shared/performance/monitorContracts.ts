import { MONITOR_OPERATIONS, MONITOR_POLICY } from './monitorPolicy.js'
import type { MonitorOperationName, MonitorOutcome } from './monitorPolicy.js'

export type MonitorOperation = {
  kind: 'operation'
  name: MonitorOperationName
  durationMs: number
  outcome: MonitorOutcome
  // This is an opaque application ID, never an agent title or project path.
  // Main stamps source/run identity from the sender; neither is renderer input.
  sessionId?: string
}

export type MonitorHeartbeat = {
  kind: 'heartbeat'
  monotonicMs: number
  timeOriginMs: number
  lagMs: number
  visibility: 'visible' | 'hidden'
  longTaskCount: number
  longTaskTotalMs: number
  longTaskMaxMs: number
  heapUsedBytes: number | null
  heapLimitBytes: number | null
  inputCount: number
  inputMaxMs: number
}

export type MonitorRendererRecord = MonitorOperation | MonitorHeartbeat

const operations = new Set<string>(MONITOR_OPERATIONS)
const outcomes = new Set<string>(['success', 'error', 'cancelled', 'timeout'])
const operationKeys = new Set(['kind', 'name', 'durationMs', 'outcome', 'sessionId'])
const heartbeatKeys = new Set([
  'kind', 'monotonicMs', 'timeOriginMs', 'lagMs', 'visibility', 'longTaskCount',
  'longTaskTotalMs', 'longTaskMaxMs', 'heapUsedBytes', 'heapLimitBytes', 'inputCount', 'inputMaxMs',
])
const finite = (value: unknown, max = Number.MAX_SAFE_INTEGER): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max
const count = (value: unknown): value is number => finite(value) && Number.isSafeInteger(value)
const nullableNumber = (value: unknown): value is number | null => value === null || finite(value)

// IDs are deliberately short ASCII tokens. The wire schema cannot carry an
// arbitrary metadata bag: shallow key redaction would miss nested content, and
// truncating a prompt would still retain a prompt. Reject unknown fields before
// constructing a fresh value, so the returned object cannot carry hidden data.
export function isMonitorId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,96}$/.test(value)
}

export function parseMonitorRendererRecord(input: unknown): MonitorRendererRecord | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const value = input as Record<string, unknown>
  const keys = Object.keys(value)
  if (value.kind === 'operation') {
    if (keys.length > operationKeys.size || keys.some(key => !operationKeys.has(key))) return null
    if (typeof value.name !== 'string' || !operations.has(value.name)
      || !finite(value.durationMs, 24 * 60 * 60_000)
      || typeof value.outcome !== 'string' || !outcomes.has(value.outcome)
      || (value.sessionId !== undefined && !isMonitorId(value.sessionId))) return null
    return {
      kind: 'operation', name: value.name as MonitorOperationName,
      durationMs: value.durationMs, outcome: value.outcome as MonitorOutcome,
      ...(value.sessionId === undefined ? {} : { sessionId: value.sessionId as string }),
    }
  }
  if (value.kind !== 'heartbeat' || keys.length !== heartbeatKeys.size
    || keys.some(key => !heartbeatKeys.has(key))) return null
  if (!finite(value.monotonicMs) || !finite(value.timeOriginMs)
    || !finite(value.lagMs) || !count(value.longTaskCount)
    || !finite(value.longTaskTotalMs) || !finite(value.longTaskMaxMs)
    || !count(value.inputCount) || !finite(value.inputMaxMs)
    || !nullableNumber(value.heapUsedBytes) || !nullableNumber(value.heapLimitBytes)
    || (value.visibility !== 'visible' && value.visibility !== 'hidden')) return null
  return {
    kind: 'heartbeat', monotonicMs: value.monotonicMs, timeOriginMs: value.timeOriginMs,
    lagMs: value.lagMs, visibility: value.visibility,
    longTaskCount: value.longTaskCount, longTaskTotalMs: value.longTaskTotalMs,
    longTaskMaxMs: value.longTaskMaxMs, heapUsedBytes: value.heapUsedBytes,
    heapLimitBytes: value.heapLimitBytes, inputCount: value.inputCount, inputMaxMs: value.inputMaxMs,
  }
}

export function parseMonitorRendererBatch(input: unknown): MonitorRendererRecord[] | null {
  if (!Array.isArray(input) || input.length > MONITOR_POLICY.rendererBatchRecords) return null
  const result: MonitorRendererRecord[] = []
  for (const item of input) {
    const parsed = parseMonitorRendererRecord(item)
    if (!parsed) return null
    result.push(parsed)
  }
  return result
}

// This conservative byte charge avoids JSON.stringify on instrumentation hot
// paths. Every admitted record is a fixed set of finite numeric fields/enums
// and at most one 96-byte ASCII ID. The tests prove its serialized upper bound;
// expanding the schema requires revisiting this charge and the batch limit.
export const MONITOR_RECORD_BYTES = 512

