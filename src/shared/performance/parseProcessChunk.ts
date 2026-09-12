import { SESSION_KINDS } from '../types/providerKind.js'
import { isMonitorId } from './monitorContracts.js'
import type { MonitorProcessChunk, MonitorProcessRow, MonitorProcessSummary } from './processSnapshot.js'

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER
const integer = (v: unknown): v is number => finite(v) && Number.isSafeInteger(v)
const nullable = (v: unknown): v is number | null => v === null || finite(v)
const rowTypes = new Set(['main', 'renderer', 'gpu', 'utility', 'other', 'agent', 'terminal', 'child'])
const qualities = new Set(['ok', 'warming-up', 'partial', 'unsupported'])

export function parseProcessChunk(input: unknown): MonitorProcessChunk | null {
  if (!object(input) || Object.keys(input).length !== 5 || !integer(input.generation) || !integer(input.offset)
    || input.offset > 2048 || typeof input.complete !== 'boolean' || !Array.isArray(input.rows) || input.rows.length > 120
    || !object(input.summary)) return null
  const summary = input.summary
  if (Object.keys(summary).length !== 8 || !finite(summary.sampledAt) || !integer(summary.count) || summary.count > 2048
    || !nullable(summary.cpuPercent) || !nullable(summary.memoryBytes) || !integer(summary.sessionCount) || summary.sessionCount > 2048
    || !integer(summary.missingRoots) || typeof summary.truncated !== 'boolean'
    || typeof summary.quality !== 'string' || !qualities.has(summary.quality)) return null
  const rows: MonitorProcessRow[] = []
  for (const row of input.rows) {
    if (!object(row) || Object.keys(row).length > 11 || typeof row.identity !== 'string' || row.identity.length > 128
      || !/^(?:\d+:-?\d+(?:\.\d+)?|session:[a-zA-Z0-9_-]{1,96})$/.test(row.identity)
      || (row.pid !== null && (!integer(row.pid) || row.pid === 0)) || (row.parentPid !== null && !integer(row.parentPid))
      || typeof row.creationTime !== 'number' || !Number.isFinite(row.creationTime) || Math.abs(row.creationTime) > Number.MAX_SAFE_INTEGER
      || typeof row.type !== 'string' || !rowTypes.has(row.type) || !Array.isArray(row.sessionIds) || row.sessionIds.length > 4
      || ![...row.sessionIds].every(isMonitorId) || !integer(row.sharedSessionCount) || row.sharedSessionCount > 2048
      || !nullable(row.cpuPercent) || !nullable(row.memoryBytes) || typeof row.quality !== 'string' || !qualities.has(row.quality)
      || (row.provider !== undefined && !SESSION_KINDS.includes(row.provider as never))) return null
    // Fresh projection makes unknown future fields unable to retain content in
    // main's cache. Owner IDs are bounded separately from shared-owner count.
    rows.push({ identity: row.identity, pid: row.pid as number | null, parentPid: row.parentPid as number | null,
      creationTime: row.creationTime, type: row.type as MonitorProcessRow['type'],
      ...(row.provider ? { provider: row.provider as MonitorProcessRow['provider'] } : {}),
      sessionIds: [...row.sessionIds], sharedSessionCount: row.sharedSessionCount,
      cpuPercent: row.cpuPercent, memoryBytes: row.memoryBytes, quality: row.quality as MonitorProcessRow['quality'] })
  }
  return { generation: input.generation, offset: input.offset, complete: input.complete, rows,
    summary: { sampledAt: summary.sampledAt, count: summary.count, cpuPercent: summary.cpuPercent, memoryBytes: summary.memoryBytes,
      quality: summary.quality as MonitorProcessSummary['quality'], sessionCount: summary.sessionCount,
      missingRoots: summary.missingRoots, truncated: summary.truncated } }
}
