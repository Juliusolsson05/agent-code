import { parseProcessChunk } from '@shared/performance/parseProcessChunk.js'
import { parseMonitorSnapshot } from '@shared/performance/parseMonitorSnapshot.js'
import { ElectronProcessSource } from './ElectronProcessSource.js'
import type { MonitorProcessTarget, MonitorProcessPage, MonitorProcessRow } from '@shared/performance/processSnapshot.js'
import { EMPTY_PROCESS_SUMMARY } from './NativeProcessSampler.js'
import { utilityProcess } from 'electron'
import type { UtilityProcess } from 'electron'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { BoundedQueue } from '@shared/performance/boundedQueue.js'
import { MONITOR_POLICY } from '@shared/performance/monitorPolicy.js'
import { parseMonitorRendererRecord, MONITOR_RECORD_BYTES } from '@shared/performance/monitorContracts.js'
import type { MonitorOperation } from '@shared/performance/monitorContracts.js'
import type { MonitorEnvelope, MonitorSnapshot, MonitorWorkerResponse } from '@shared/performance/monitorSnapshot.js'
import type { RendererFreezeHeartbeat } from '@shared/incident/rendererFreeze.js'
import { mainProbe } from './MainProbe.js'
import { getAppRunId } from '@main/incident/appRunIds.js'

export class MonitorCoordinator {
  private child: UtilityProcess | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private unsubscribe: (() => void) | null = null
  private queue = new BoundedQueue<MonitorEnvelope>(1600, 1600 * MONITOR_RECORD_BYTES)
  private processQueue = new BoundedQueue<MonitorEnvelope>(2306, 2306 * MONITOR_RECORD_BYTES)
  private sequence = 0
  private pending: { sequence: number; at: number; count: number } | null = null
  private lost = 0
  private launches = 0
  private retryAt = 0
  private stopped = false
  private lastReplyAt = 0
  private processSource: ElectronProcessSource | null = null
  private processPage: MonitorProcessPage = { summary: EMPTY_PROCESS_SUMMARY, rows: [], total: 0 }
  private processTransfer: { generation: number; rows: MonitorProcessRow[] } | null = null
  private moreProcesses = false
  private processReceivedAt = 0
  private liveWindows = new Set<number>()
  private cache: MonitorSnapshot = {
    schemaVersion: 1, runId: getAppRunId(), enabled: true, sampledAt: 0,
    collector: 'starting', droppedRecords: 0, queuedBytes: 0, restarts: 0,
    main: null, windows: [], operations: [], recent: [], workerRss: 0,
  }

  constructor(private readonly monotonicNow: () => number = () => performance.now()) {}

  start(): void {
    if (this.timer || this.stopped) return
    mainProbe.start()
    this.unsubscribe = mainProbe.subscribe(sample => {
      const main = {
        at: sample.loopSampledAt, cpuPercent: sample.cpuPercent, rss: sample.rss,
        heapUsed: sample.heapUsed, heapLimit: sample.heapLimit, sleepGap: sample.sleepGap,
        loopMeanMs: sample.eventLoopDelay?.meanMs ?? null,
        loopP99Ms: sample.eventLoopDelay?.p99Ms ?? null,
        loopMaxMs: sample.eventLoopDelay?.maxMs ?? null,
      }
      this.cache = { ...this.cache, main }
      this.enqueue({ kind: 'main', sample: main })
    })
    this.launch()
    this.timer = setInterval(() => this.pump(), 200)
    this.timer.unref()
  }

  startProcesses(targets: () => MonitorProcessTarget[]): void {
    if (this.processSource) return
    this.processSource = new ElectronProcessSource(targets, record => this.processQueue.push(record, MONITOR_RECORD_BYTES), () => this.processQueue.stats.records === 0)
    this.processSource.start()
  }

  readAllProcesses(): MonitorProcessPage { return this.processPage }

  readProcesses(offset = 0, sort: 'cpu' | 'memory' = 'cpu'): MonitorProcessPage {
    const start = Number.isSafeInteger(offset) && offset >= 0 ? Math.min(offset, MONITOR_POLICY.processLimit) : 0
    const rows = sort === 'memory' ? [...this.processPage.rows].sort((a, b) => (b.memoryBytes ?? -1) - (a.memoryBytes ?? -1)) : this.processPage.rows
    return { summary: this.processSummary(), total: rows.length, rows: rows.slice(start, start + 50) }
  }

  private processSummary() {
    const summary = this.processPage.summary
    return { ...summary, quality: summary.sampledAt > 0 && this.monotonicNow() - this.processReceivedAt > 15000 ? 'stale' as const : summary.quality }
  }

  read(): MonitorSnapshot {
    return {
      ...this.cache, processes: this.processSummary(), queuedBytes: this.queue.stats.bytes + this.processQueue.stats.bytes,
      droppedRecords: this.queue.stats.dropped + this.processQueue.stats.dropped + this.lost,
      restarts: Math.max(0, this.launches - 1),
      collector: this.stopped ? 'stopped'
        : this.lastReplyAt && this.monotonicNow() - this.lastReplyAt > 5000 ? 'degraded' : this.cache.collector,
    }
  }

  heartbeat(windowId: number, heartbeat: RendererFreezeHeartbeat): void {
    // Only the already validated freeze heartbeat reaches this adapter. Never
    // copy the incoming object wholesale: its optional legacy DOM diagnostics
    // and future fields must not expand the baseline privacy contract.
    const sample = parseMonitorRendererRecord({
      kind: 'heartbeat', monotonicMs: heartbeat.monotonicMs,
      timeOriginMs: heartbeat.timeOriginMs ?? Math.max(0, heartbeat.sentAt - heartbeat.monotonicMs),
      lagMs: heartbeat.eventLoopLagMs, visibility: heartbeat.visibilityState === 'visible' ? 'visible' : 'hidden',
      longTaskCount: heartbeat.longTasks.count, longTaskTotalMs: heartbeat.longTasks.totalMs,
      longTaskMaxMs: heartbeat.longTasks.maxMs, heapUsedBytes: heartbeat.heap?.usedBytes ?? null,
      heapLimitBytes: heartbeat.heap?.limitBytes ?? null,
      inputCount: heartbeat.input?.count ?? 0, inputMaxMs: heartbeat.input?.maxMs ?? 0,
    })
    if (sample?.kind === 'heartbeat') {
      if (!this.liveWindows.has(windowId) && this.liveWindows.size >= MONITOR_POLICY.windowLimit) { this.lost++; return }
      this.liveWindows.add(windowId)
      this.enqueue({ kind: 'window', sample: { ...sample, windowId, receivedAt: Date.now(), longTasksSupported: heartbeat.longTasksSupported === true, inputSupported: heartbeat.inputSupported === true } })
    }
  }

  closeWindow(windowId: number): void {
    this.liveWindows.delete(windowId)
    this.cache = { ...this.cache, windows: this.cache.windows.filter(window => window.windowId !== windowId) }
  }

  operation(sample: MonitorOperation, windowId: number | null = null): void {
    const parsed = parseMonitorRendererRecord(sample)
    if (parsed?.kind === 'operation') this.enqueue({ kind: 'operation', at: Date.now(), windowId, sample: parsed })
  }

  stop(): void {
    this.stopped = true
    this.processSource?.stop()
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.unsubscribe?.()
    this.unsubscribe = null
    this.child?.kill()
    this.child = null
    this.queue.clear()
    this.processQueue.clear()
  }

  private enqueue(record: MonitorEnvelope): void {
    if (!this.stopped) this.queue.push(record, MONITOR_RECORD_BYTES)
  }

  private launch(): void {
    if (this.stopped || this.child || this.launches >= 4) return
    this.launches++
    try {
      const child = utilityProcess.fork(fileURLToPath(new URL('./performanceWorker.js', import.meta.url)), [], {
        serviceName: 'Agent Code Performance Monitor', stdio: 'ignore',
        // This helper never needs provider credentials, NODE_OPTIONS, or app
        // configuration from the launch environment. Pass only OS necessities.
        env: { PATH: '/usr/bin:/bin', ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
      })
      this.child = child
      child.on('message', (message: MonitorWorkerResponse) => {
        try {
          if (this.child !== child || !this.pending || message?.sequence !== this.pending.sequence) return
          const snapshot = message.snapshot === undefined ? null : parseMonitorSnapshot(message.snapshot)
          const chunk = message.processChunk === undefined ? null : parseProcessChunk(message.processChunk)
          if ((message.snapshot !== undefined && !snapshot) || (message.processChunk !== undefined && !chunk)) {
            this.fail(child); return
          }
          if (chunk) {
            if (chunk.offset === 0) this.processTransfer = { generation: chunk.generation, rows: [] }
            const transfer = this.processTransfer
            if (!transfer || transfer.generation !== chunk.generation || transfer.rows.length !== chunk.offset
              || transfer.rows.length + chunk.rows.length > MONITOR_POLICY.processLimit) { this.fail(child); return }
            transfer.rows.push(...chunk.rows)
            this.moreProcesses = !chunk.complete
            if (chunk.complete && chunk.summary.sampledAt > 0) {
              this.processPage = { summary: chunk.summary, rows: transfer.rows, total: transfer.rows.length }
              this.processSource?.captureBirths(transfer.rows, chunk.summary.contextGeneration)
              this.processReceivedAt = this.monotonicNow()
              this.processTransfer = null
            }
          }
          this.pending = null
          this.lastReplyAt = this.monotonicNow()
          if (snapshot) this.cache = {
            ...this.cache, ...snapshot, main: this.cache.main,
            windows: snapshot.windows.filter(window => this.liveWindows.has(window.windowId)), collector: 'healthy',
          }
        } catch { this.fail(child) }
      })
      child.on('exit', () => this.fail(child))
      child.on('error', () => this.fail(child))
    } catch { this.fail(null) }
  }

  private fail(child: UtilityProcess | null): void {
    if (child !== this.child) return
    this.child = null
    try { child?.kill() } catch { /* Exiting helpers can reject native handle access. */ }
    this.lost += this.pending?.count ?? 0
    this.pending = null
    this.processTransfer = null
    this.moreProcesses = false
    this.retryAt = this.monotonicNow() + 5000 * this.launches
    this.cache = { ...this.cache, collector: 'degraded' }
  }

  private pump(): void {
    try {
      if (this.pending && this.monotonicNow() - this.pending.at > 5000) this.fail(this.child)
      if (!this.child && this.monotonicNow() >= this.retryAt) this.launch()
      if (!this.child || this.pending) return
      // Reserve 100 of 120 slots for a complete process generation. At the
      // declared 2,048-target + 256-Electron ceiling this drains in 4.8s,
      // independent of an operation storm. A slow worker finishes its current
      // generation before the source admits a new one; it never restarts the
      // same half-transfer every five seconds. Both queues total <2 MiB.
      const processes = this.processQueue.drain(100, 100 * MONITOR_RECORD_BYTES)
      const records = [...processes, ...this.queue.drain(120 - processes.length, (120 - processes.length) * MONITOR_RECORD_BYTES)]
      if (!records.length && !this.moreProcesses) return
      const sequence = ++this.sequence
      // One credit means a suspended worker cannot accumulate an invisible
      // Electron message-port queue. Timeout discards the in-flight evidence,
      // counts the loss, and caps process restarts for the entire app run.
      this.pending = { sequence, at: this.monotonicNow(), count: records.length }
      this.child.postMessage({ sequence, records, liveWindowIds: [...this.liveWindows] })
    } catch { this.fail(this.child) }
  }
}

export const monitorCoordinator = new MonitorCoordinator()
