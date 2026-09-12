import { utilityProcess } from 'electron'
import type { UtilityProcess } from 'electron'
import { fileURLToPath } from 'node:url'
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
  private queue = new BoundedQueue<MonitorEnvelope>(4000, MONITOR_POLICY.coordinatorQueueBytes)
  private sequence = 0
  private pending: { sequence: number; at: number; count: number } | null = null
  private lost = 0
  private launches = 0
  private retryAt = 0
  private stopped = false
  private cache: MonitorSnapshot = {
    schemaVersion: 1, runId: getAppRunId(), enabled: true, sampledAt: 0,
    collector: 'starting', droppedRecords: 0, queuedBytes: 0, restarts: 0,
    main: null, windows: [], operations: [], recent: [], workerRss: 0,
  }

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
    this.timer = setInterval(() => this.pump(), 1000)
    this.timer.unref()
  }

  read(): MonitorSnapshot {
    return {
      ...this.cache, queuedBytes: this.queue.stats.bytes,
      droppedRecords: this.queue.stats.dropped + this.lost,
      restarts: Math.max(0, this.launches - 1),
      collector: this.stopped ? 'stopped'
        : this.cache.sampledAt && Date.now() - this.cache.sampledAt > 5000 ? 'degraded' : this.cache.collector,
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
      this.enqueue({ kind: 'window', sample: { ...sample, windowId, receivedAt: Date.now(), longTasksSupported: heartbeat.longTasksSupported === true, inputSupported: heartbeat.inputSupported === true } })
    }
  }

  closeWindow(windowId: number): void { this.enqueue({ kind: 'window-closed', windowId }) }

  operation(sample: MonitorOperation, windowId: number | null = null): void {
    const parsed = parseMonitorRendererRecord(sample)
    if (parsed?.kind === 'operation') this.enqueue({ kind: 'operation', at: Date.now(), windowId, sample: parsed })
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.unsubscribe?.()
    this.unsubscribe = null
    this.child?.kill()
    this.child = null
    this.queue.clear()
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
      })
      this.child = child
      child.on('message', (message: MonitorWorkerResponse) => {
        if (this.child !== child || !this.pending || message?.sequence !== this.pending.sequence) return
        // The worker is our own bundled code, but a protocol/version mismatch
        // must degrade monitoring rather than overwrite the cache with junk.
        if (message.snapshot?.schemaVersion !== 1 || !Number.isFinite(message.snapshot.sampledAt)) {
          this.fail(child)
          return
        }
        this.pending = null
        this.cache = { ...this.cache, ...message.snapshot, collector: 'healthy' }
      })
      child.on('exit', () => this.fail(child))
      child.on('error', () => this.fail(child))
    } catch { this.fail(null) }
  }

  private fail(child: UtilityProcess | null): void {
    if (child !== this.child) return
    this.child = null
    child?.kill()
    this.lost += this.pending?.count ?? 0
    this.pending = null
    this.retryAt = Date.now() + 5000 * this.launches
    this.cache = { ...this.cache, collector: 'degraded' }
  }

  private pump(): void {
    try {
      if (this.pending && Date.now() - this.pending.at > 5000) this.fail(this.child)
      if (!this.child && Date.now() >= this.retryAt) this.launch()
      if (!this.child || this.pending) return
      const records = this.queue.drain(MONITOR_POLICY.rendererBatchRecords, MONITOR_POLICY.batchBytes - 1024)
      if (!records.length) return
      const sequence = ++this.sequence
      // One credit means a suspended worker cannot accumulate an invisible
      // Electron message-port queue. Timeout discards the in-flight evidence,
      // counts the loss, and caps process restarts for the entire app run.
      this.pending = { sequence, at: Date.now(), count: records.length }
      this.child.postMessage({ sequence, records })
    } catch { this.fail(this.child) }
  }
}

export const monitorCoordinator = new MonitorCoordinator()
