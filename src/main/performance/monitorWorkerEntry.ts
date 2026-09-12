import { IncidentEngine } from './IncidentEngine.js'
import { MonitorHistoryStore } from './MonitorHistoryStore.js'
import { performance } from 'node:perf_hooks'
import { NativeProcessSampler } from './NativeProcessSampler.js'
import type { MonitorProcessContext, MonitorProcessPage } from '@shared/performance/processSnapshot.js'
import { MONITOR_POLICY } from '@shared/performance/monitorPolicy.js'
import { MonitorAggregator } from './MonitorAggregator.js'
import type { MonitorWorkerRequest } from '@shared/performance/monitorSnapshot.js'
import type { MonitorHistoryStatus, MonitorWorkerQueryResult } from '@shared/performance/monitorHistory.js'
import { isMonitorId } from '@shared/performance/monitorContracts.js'
import { MONITOR_HISTORY_DIR } from '@main/storage/paths.js'

// utilityProcess runs in Electron's signed helper, including distributions
// whose RunAsNode fuse is disabled. No transcript/provider modules belong in
// this entry: the worker only receives numeric, already-normalized evidence.
const parent = (process as unknown as { parentPort: {
  on(event: 'message', listener: (event: { data: MonitorWorkerRequest }) => void): void
  postMessage(message: unknown): void
} }).parentPort
const aggregator = new MonitorAggregator()
const incidents = new IncidentEngine()
setInterval(() => incidents.tick(Date.now(), performance.now()), 1000).unref()
const processes = new NativeProcessSampler()
let history: MonitorHistoryStore | null = null
let context: (MonitorProcessContext & { expected: number; received: number }) | null = null
let lastSnapshotAt = -Infinity
let transfer: MonitorProcessPage | null = null
let transferOffset = 0
let transferGeneration = 0
let sentPage: MonitorProcessPage | null = null
const unavailableHistory = (): MonitorHistoryStatus => ({ state: 'unavailable', bytes: 0, oldestAt: null, newestAt: null, points: 0, incidents: 0, exporting: false, shortened: false })
parent.on('message', async ({ data }) => {
  if (!history && isMonitorId(data.runId)) history = new MonitorHistoryStore(MONITOR_HISTORY_DIR, data.runId)
  aggregator.accept(data.records)
  const now = Date.now()
  const mono = performance.now()
  incidents.reconcile(data.liveWindowIds ?? [], data.visibleWindowIds ?? [], mono)
  incidents.accept(data.records, now, mono)
  incidents.loss(data.droppedRecords ?? 0, now, mono)
  for (const record of data.records) {
    if (record.kind === 'process-context-start') {
      context = { ...record, targets: [], electron: [], received: 0 }
    } else if (record.kind === 'process-context-end' && context?.generation === record.generation) {
      if (context.received === context.expected) void processes.sample(context).catch(() => {})
      context = null
    } else if (record.kind === 'process-electron' && context?.generation === record.generation) {
      if (context.electron.length < MONITOR_POLICY.processLimit) { context.electron.push(record.sample); context.received++ }
    } else if (record.kind === 'process-target' && context?.generation === record.generation) {
      if (context.targets.length < MONITOR_POLICY.processLimit) { context.targets.push(record.sample); context.received++ }
    }
  }
  if (data.liveWindowIds) aggregator.reconcileWindows(data.liveWindowIds)
  const page = processes.read()
  const snapshot = mono - lastSnapshotAt >= 1000
    ? { ...aggregator.snapshot(now, process.memoryUsage.rss()), incidents: incidents.summaries(), history: history?.status() ?? unavailableHistory() } : undefined
  if (snapshot) lastSnapshotAt = mono
  if (snapshot && history) {
    const detail = incidents.summaries().map(summary => incidents.detail(summary.id)).filter((row): row is NonNullable<typeof row> => row !== null)
    history.record(snapshot, page.summary.sampledAt > 0 ? page.summary : null, detail, data.droppedRecords ?? 0, data.restarts ?? 0)
  }
  if (!transfer && page !== sentPage) {
    transfer = page; transferOffset = 0; transferGeneration++
  }
  const processChunk = transfer ? {
    generation: transferGeneration, offset: transferOffset, summary: transfer.summary,
    rows: transfer.rows.slice(transferOffset, transferOffset + 120),
    complete: transferOffset + 120 >= transfer.rows.length,
  } : undefined
  if (transfer && processChunk) {
    transferOffset += processChunk.rows.length
    if (processChunk.complete) { sentPage = transfer; transfer = null }
  }
  let queryResult: MonitorWorkerQueryResult | undefined
  const query = data.query
  if (query?.kind === 'incident') queryResult = { kind: 'incident', value: incidents.detail(query.id) }
  else if (query?.kind === 'history') queryResult = { kind: 'history', value: history
    ? await history.query(query.from, query.to, query.cursor, query.limit)
    : { resolution: '1s', from: query.from, to: query.to, points: [], nextCursor: null, complete: true, status: unavailableHistory() } }
  else if (query?.kind === 'history-status') queryResult = { kind: 'history-status', value: history?.status() ?? unavailableHistory() }
  else if (query?.kind === 'report-preview') queryResult = { kind: 'report-preview', value: history
    ? await history.preview(query.from, query.to)
    : { from: query.from, to: query.to, estimatedBytes: 0, dataClasses: ['coverage'], localOnly: true, status: unavailableHistory() } }
  else if (query?.kind === 'report-export') queryResult = { kind: 'report-export', value: history
    ? await history.exportReport(query.from, query.to, query.destination, query.build)
    : { ok: false, code: 'unavailable' } }
  else if (query?.kind === 'history-clear') queryResult = { kind: 'history-clear', value: history ? await history.clear() : unavailableHistory() }
  parent.postMessage({ sequence: data.sequence, snapshot, processChunk, ...(queryResult ? { queryResult } : {}) })
})
