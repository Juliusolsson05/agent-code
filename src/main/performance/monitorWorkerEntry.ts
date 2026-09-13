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
import { isAbsolute } from 'node:path'

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
let incidentFingerprint = ''
const unavailableHistory = (): MonitorHistoryStatus => ({ state: 'unavailable', bytes: 0, oldestAt: null, newestAt: null, points: 0, incidents: 0, exporting: false, shortened: false })
parent.on('message', async ({ data }) => {
  if (!history && isMonitorId(data.runId) && typeof data.historyRoot === 'string' && data.historyRoot.length <= 4096 && isAbsolute(data.historyRoot)) {
    history = new MonitorHistoryStore(data.historyRoot, data.runId)
  }
  aggregator.accept(data.records)
  const now = Date.now()
  const mono = performance.now()
  incidents.reconcile(data.liveWindowIds ?? [], data.visibleWindowIds ?? [], mono)
  // Loss first: the reported count covers records dropped BEFORE this batch,
  // so it must not mark captures this batch is about to open as truncated.
  incidents.loss(data.droppedRecords ?? 0, mono)
  incidents.accept(data.records, now, mono)
  // WHY interrupt only after this batch is accepted: the coordinator sends its
  // final drained records together with the flush. Interrupting first closed
  // captures before the last seconds of evidence (often the stall that made
  // the user quit) could join them, and those records then started nothing.
  const flushing = data.query?.kind === 'history-flush'
  if (flushing) incidents.interrupt()
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
  // A flush always records. The one-second snapshot throttle otherwise skips
  // the final message when quit follows a reply within a second, so the
  // interrupted incident states above would never reach the store.
  const snapshot = flushing || mono - lastSnapshotAt >= 1000
    ? { ...aggregator.snapshot(now, process.memoryUsage.rss()), incidents: incidents.summaries(), history: history?.status() ?? unavailableHistory() } : undefined
  if (snapshot) lastSnapshotAt = mono
  if (snapshot && history) {
    // Full evidence is copied only when a summary field that persistence
    // reflects actually changed (a new incident, a state change, truncation
    // or more captured evidence). Rebuilding and serializing fifty evidence
    // sets every second was the helper's largest steady CPU cost.
    const summaries = incidents.summaries()
    const fingerprint = summaries.map(row => `${row.at}:${row.id}:${row.state}:${row.truncated}:${row.evidenceCount}`).join('|')
    const detail = fingerprint === incidentFingerprint ? null
      : summaries.map(summary => incidents.detail(summary.id)).filter((row): row is NonNullable<typeof row> => row !== null)
    incidentFingerprint = fingerprint
    history.record(snapshot, page.summary.sampledAt > 0 ? page.summary : null, detail, data.droppedRecords ?? 0, data.restarts ?? 0)
  }
  if (!transfer && page !== sentPage) {
    transfer = page; transferOffset = 0; transferGeneration++
  }
  // Query replies never carry process chunks. The coordinator may abandon a
  // slow query and apply later replies first; a chunk inside that late reply
  // would arrive out of offset order and fail the whole process transfer.
  const processChunk = transfer && !data.query ? {
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
  else if (query?.kind === 'history-incident') queryResult = { kind: 'history-incident', value: history ? await history.readIncident(query.at, query.id) : null }
  else if (query?.kind === 'history') queryResult = { kind: 'history', value: history
    ? await history.query(query.from, query.to, query.cursor, query.limit)
    : { resolution: '1s', from: query.from, to: query.to, points: [], incidents: [], nextCursor: null, complete: true, status: unavailableHistory() } }
  else if (query?.kind === 'history-status') queryResult = { kind: 'history-status', value: history?.status() ?? unavailableHistory() }
  else if (query?.kind === 'report-preview') queryResult = { kind: 'report-preview', value: history
    ? await history.preview(query.from, query.to)
    : { from: query.from, to: query.to, estimatedBytes: 0, dataClasses: ['coverage'], localOnly: true, status: unavailableHistory() } }
  else if (query?.kind === 'report-export') queryResult = { kind: 'report-export', value: history
    ? await history.exportReport(query.from, query.to, query.destination, query.build)
    : { ok: false, code: 'unavailable' } }
  else if (query?.kind === 'history-clear') {
    // Reset in-memory evidence synchronously, before the first await. The
    // one-second tick timer can run while clear() awaits disk work, and every
    // later snapshot would otherwise re-persist the incidents and operation
    // histograms the user just deleted.
    incidents.clear()
    aggregator.clearHistory()
    incidentFingerprint = ''
    queryResult = { kind: 'history-clear', value: history ? await history.clear() : unavailableHistory() }
  }
  else if (query?.kind === 'history-flush') {
    // The coordinator sends this only from Electron's admitted quit path. A
    // normal snapshot reply proves aggregation finished, but it does not prove
    // the store's coalesced writer reached disk. flush() also emits partially
    // filled 10 s / 1 m rollup buckets, which would otherwise die with the run.
    await history?.flush()
    queryResult = { kind: 'history-flush', value: true }
  }
  parent.postMessage({ sequence: data.sequence, snapshot, processChunk, ...(queryResult ? { queryResult } : {}) })
})
