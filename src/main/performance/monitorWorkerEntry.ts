import { IncidentEngine } from './IncidentEngine.js'
import { performance } from 'node:perf_hooks'
import { NativeProcessSampler } from './NativeProcessSampler.js'
import type { MonitorProcessContext, MonitorProcessPage } from '@shared/performance/processSnapshot.js'
import { MONITOR_POLICY } from '@shared/performance/monitorPolicy.js'
import { MonitorAggregator } from './MonitorAggregator.js'
import type { MonitorWorkerRequest } from '@shared/performance/monitorSnapshot.js'

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
let context: (MonitorProcessContext & { expected: number; received: number }) | null = null
let lastSnapshotAt = -Infinity
let transfer: MonitorProcessPage | null = null
let transferOffset = 0
let transferGeneration = 0
let sentPage: MonitorProcessPage | null = null
parent.on('message', ({ data }) => {
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
  const snapshot = mono - lastSnapshotAt >= 1000
    ? { ...aggregator.snapshot(now, process.memoryUsage.rss()), incidents: incidents.summaries() } : undefined
  if (snapshot) lastSnapshotAt = mono
  const page = processes.read()
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
  parent.postMessage({ sequence: data.sequence, snapshot, processChunk, ...(data.query?.kind === 'incident' ? { incident: incidents.detail(data.query.id) } : {}) })
})
