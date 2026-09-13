import type { MonitorIncident } from '@shared/performance/monitorIncidents.js'
import { parseMonitorWorkerQueryResult } from '@shared/performance/parseMonitorHistory.js'
import type { MonitorHistoryPage, MonitorHistoryStatus, MonitorReportPreview, MonitorReportResult, MonitorWorkerQuery, MonitorWorkerQueryResult } from '@shared/performance/monitorHistory.js'
import { mainOperations, setMainOperationSink } from './operations.js'
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
import { MONITOR_HISTORY_DIR } from '@main/storage/paths.js'

// Queries whose late completion changes nothing the user was already told.
// Only these may be abandoned at their deadline (see pump()).
const READ_ONLY_QUERIES = new Set<MonitorWorkerQuery['kind']>(['incident', 'history-incident', 'history', 'history-status', 'report-preview'])

export class MonitorCoordinator {
  private child: UtilityProcess | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private unsubscribe: (() => void) | null = null
  private queue = new BoundedQueue<MonitorEnvelope>(1600, 1600 * MONITOR_RECORD_BYTES)
  // WHY a separate lane for main samples and heartbeats: they are the evidence
  // that main and each renderer are alive. In the shared 1,600-record queue an
  // operation storm (many streaming panes committing) dropped the oldest
  // records first, so a healthy window could go four seconds with no heartbeat
  // delivered and be reported as a renderer stall. Only ~65 records per second
  // arrive here (one main sample plus one heartbeat per window), so 256 slots
  // absorb several seconds of a stalled helper.
  private priorityQueue = new BoundedQueue<MonitorEnvelope>(256, 256 * MONITOR_RECORD_BYTES)
  private processQueue = new BoundedQueue<MonitorEnvelope>(2306, 2306 * MONITOR_RECORD_BYTES)
  private sequence = 0
  private pending: { sequence: number; at: number; count: number; priority: number; timeoutMs: number; query?: QueryWaiter } | null = null
  private lost = 0
  // Lost records that could have carried liveness evidence: priority-lane
  // evictions plus the main samples and heartbeats inside a batch lost with a
  // failed helper. Reported separately because only these can explain a
  // missing heartbeat; operation-queue drops cannot, now that heartbeats never
  // share that queue.
  private livenessLost = 0
  private launches = 0
  private retryAt = 0
  private stopped = false
  private lastReplyAt = 0
  private processSource: ElectronProcessSource | null = null
  private processPage: MonitorProcessPage = { summary: EMPTY_PROCESS_SUMMARY, rows: [], total: 0 }
  private processTransfer: { generation: number; rows: MonitorProcessRow[] } | null = null
  private moreProcesses = false
  private processReceivedAt = 0
  private visibleWindows = new Set<number>()
  // WHY a small FIFO instead of one waiter slot: the Timeline, report preview
  // and incident drawer can legitimately ask at the same moment. A single slot
  // turned the second request into an immediate null ("history unavailable")
  // even though the helper was healthy. Eight waiters bound memory and keep a
  // stalled helper from accumulating renderer promises.
  private queries: QueryWaiter[] = []
  // Keyed by window, source AND producer generation. A reload starts a new
  // generation whose counter restarts at zero, and a report the retired
  // generation sent just before the reload can still arrive afterwards. Per
  // generation baselines count each producer's loss exactly once either way.
  private sourceDrops = new Map<string, number>()
  // A query past its deadline whose helper is still alive. Its waiter already
  // received null; see pump() for why the helper is no longer killed.
  private abandoned: { sequence: number; at: number } | null = null
  private closing = false
  setWindowVisible(id: number, visible: boolean): void {
    if (visible && this.visibleWindows.size < 64) this.visibleWindows.add(id)
    else this.visibleWindows.delete(id)
  }
  /** Register a BrowserWindow when main creates it, not at its first heartbeat.
   * Liveness learned from heartbeats can never detect a renderer that fails
   * to boot, which is precisely the renderer-stall case with no other signal. */
  openWindow(id: number, visible: boolean): void {
    if (!Number.isSafeInteger(id) || id < 1) return
    if (this.liveWindows.has(id) || this.liveWindows.size < MONITOR_POLICY.windowLimit) this.liveWindows.add(id)
    this.setWindowVisible(id, visible)
  }
  readIncident(id: number): Promise<MonitorIncident | null> {
    if (!Number.isSafeInteger(id) || id < 1) return Promise.resolve(null)
    return this.request({ kind: 'incident', id }).then(result => result?.kind === 'incident' ? result.value : null)
  }
  readHistoryIncident(at: number, id: number): Promise<MonitorIncident | null> {
    if (!Number.isFinite(at) || at < 0 || !Number.isSafeInteger(id) || id < 1) return Promise.resolve(null)
    return this.request({ kind: 'history-incident', at, id }).then(result => result?.kind === 'history-incident' ? result.value : null)
  }
  readHistory(from: number, to: number, cursor?: string, limit: unknown = 500): Promise<MonitorHistoryPage | null> {
    if (!validRange(from, to) || (cursor !== undefined && (typeof cursor !== 'string' || !/^\d{1,7}$/.test(cursor)))) return Promise.resolve(null)
    // IPC arguments are untyped at runtime. NaN or an object limit used to
    // survive Math.floor as NaN and reach the helper, which rejected the
    // parsed request shape and killed itself as malformed.
    const bounded = typeof limit === 'number' && Number.isFinite(limit) ? Math.max(1, Math.min(1000, Math.floor(limit))) : 500
    return this.request({ kind: 'history', from, to, ...(cursor ? { cursor } : {}), limit: bounded })
      .then(result => result?.kind === 'history' ? result.value : null)
  }
  readHistoryStatus(): Promise<MonitorHistoryStatus | null> {
    return this.request({ kind: 'history-status' }).then(result => result?.kind === 'history-status' ? result.value : null)
  }
  previewReport(from: number, to: number): Promise<MonitorReportPreview | null> {
    if (!validRange(from, to)) return Promise.resolve(null)
    return this.request({ kind: 'report-preview', from, to }).then(result => result?.kind === 'report-preview' ? result.value : null)
  }
  exportReport(from: number, to: number, destination: string, build: Record<string, string | boolean>): Promise<MonitorReportResult> {
    if (!validRange(from, to) || !destination || destination.length > 4096) return Promise.resolve({ ok: false, code: 'invalid-range' })
    return this.request({ kind: 'report-export', from, to, destination, build }).then(result => result?.kind === 'report-export' ? result.value : { ok: false, code: 'unavailable' })
  }
  /** `sent` distinguishes "never reached the helper, nothing was deleted" from
   * "sent but unconfirmed", where a clear may already be partly done. It is
   * read from the waiter when the reply settles, not when the clear is queued:
   * a clear still waiting in the queue when the helper fails is resolved with
   * null too, and calling that "possibly deleted" would be false the other way. */
  clearHistory(): Promise<{ sent: boolean; status: MonitorHistoryStatus | null }> {
    let waiter: QueryWaiter | undefined
    return this.request({ kind: 'history-clear' }, queued => { waiter = queued })
      .then(result => ({ sent: waiter?.sent === true, status: result?.kind === 'history-clear' ? result.value : null }))
  }
  private liveWindows = new Set<number>()
  private cache: MonitorSnapshot = {
    schemaVersion: 1, runId: getAppRunId(), enabled: true, sampledAt: 0,
    collector: 'starting', droppedRecords: 0, queuedBytes: 0, restarts: 0,
    main: null, windows: [], operations: [], recent: [], workerRss: 0,
  }

  constructor(private readonly monotonicNow: () => number = () => performance.now()) {}

  start(): void {
    if (this.timer || this.stopped) return
    setMainOperationSink(record => this.operation(record))
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
      this.enqueue({ kind: 'main', sample: main }, true)
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
      ...this.cache, processes: this.processSummary(), queuedBytes: this.queue.stats.bytes + this.priorityQueue.stats.bytes + this.processQueue.stats.bytes,
      droppedRecords: this.droppedRecords(),
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
      this.enqueue({ kind: 'window', sample: { ...sample, windowId, receivedAt: Date.now(), longTasksSupported: heartbeat.longTasksSupported === true, inputSupported: heartbeat.inputSupported === true } }, true)
    }
  }

  closeWindow(windowId: number): void {
    this.liveWindows.delete(windowId)
    this.visibleWindows.delete(windowId)
    this.cache = { ...this.cache, windows: this.cache.windows.filter(window => window.windowId !== windowId) }
    for (const key of [...this.sourceDrops.keys()]) if (key.startsWith(`${windowId}:`)) this.sourceDrops.delete(key)
  }

  operation(sample: MonitorOperation, windowId: number | null = null): void {
    const parsed = parseMonitorRendererRecord(sample)
    if (parsed?.kind === 'operation') this.enqueue({ kind: 'operation', at: Date.now(), windowId, sample: parsed })
  }

  sourceLoss(windowId: number, source: 'preload' | 'renderer', generation: string, dropped: number): void {
    if (!Number.isSafeInteger(windowId) || windowId < 1 || !Number.isSafeInteger(dropped) || dropped < 0) return
    const key = `${windowId}:${source}:${generation}`
    const previous = this.sourceDrops.get(key)
    if (previous === undefined && this.sourceDrops.size >= MONITOR_POLICY.windowLimit * 4) {
      // Evict the oldest baseline by insertion order. Only a producer silent
      // long enough to be the oldest of 256 generations can be recounted.
      const oldest = this.sourceDrops.keys().next().value
      if (oldest !== undefined) this.sourceDrops.delete(oldest)
    }
    // Counters are monotonic within one generation, so a report can only add
    // the part above that generation's last value. Earlier designs inferred a
    // reload from a smaller value, which missed resets whose first value was
    // larger and double counted late reports from the retired producer.
    this.lost = Math.min(Number.MAX_SAFE_INTEGER, this.lost + Math.max(0, dropped - (previous ?? 0)))
    this.sourceDrops.set(key, Math.max(dropped, previous ?? 0))
  }

  stop(): void {
    this.stopped = true
    for (const query of this.queries.splice(0)) query.resolve(null)
    this.pending?.query?.resolve(null)
    this.processSource?.stop()
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.unsubscribe?.()
    this.unsubscribe = null
    // Detach before kill: UtilityProcess may emit `exit` synchronously from a
    // test double and asynchronously in Electron. In either case the ordinary
    // failure handler must not treat an intentional shutdown as a fresh crash
    // and attempt to kill/count the same generation again.
    const child = this.child
    this.child = null
    try { child?.kill() } catch { /* The helper may already have exited. */ }
    this.queue.clear()
    this.priorityQueue.clear()
    this.processQueue.clear()
    this.sourceDrops.clear()
  }

  async shutdown(deadlineMs = 2000): Promise<void> {
    if (this.stopped) return
    const deadline = this.monotonicNow() + Math.max(100, deadlineMs)
    const sleep = () => new Promise(resolve => setTimeout(resolve, 20))
    this.processSource?.stop()
    // From here only the durability flush may take the single credit. A late
    // renderer query, or a queued process generation reserving 100 of 120
    // slots per batch, would otherwise compete with the drain for the deadline.
    this.closing = true
    this.processQueue.clear()
    this.moreProcesses = false
    this.abandoned = null

    // A renderer may have started a history query immediately before quit. It
    // is safe to abandon queries that have not left main; letting them occupy
    // the single-credit channel would make durability wait behind UI work that
    // can no longer be observed.
    for (const query of this.queries.splice(0)) query.resolve(null)
    // An already-posted READ-ONLY query holds the single credit for nothing the
    // user can still see, so abandon it: its records were delivered with the
    // request, and a late reply carries a stale sequence that is ignored.
    // A posted export or clear is NOT abandoned. The flush would otherwise run
    // beside it: a clear still deleting would see the pre-clear incidents and
    // histograms re-persisted by the flush, and an export could finish moving
    // onto the user's file after its caller was told it failed. It keeps the
    // credit through the drain window below; if it still has not replied, the
    // flush is skipped and stop() kills the helper mid-operation instead.
    if (this.pending?.query && READ_ONLY_QUERIES.has(this.pending.query.request.kind)) {
      this.pending.query.resolve(null)
      this.pending = null
    }

    // WHY drain before flushing: one batch carries at most 120 records, and
    // stop() clears whatever is still queued. The old sequence flushed a single
    // batch, so an operation storm right before quit (exactly when evidence
    // matters) lost everything behind it. Reserve up to half the budget, capped
    // at one second, for the flush itself so draining cannot starve it.
    const drainUntil = deadline - Math.min(1000, (deadline - this.monotonicNow()) / 2)
    while (this.child && this.monotonicNow() < drainUntil && (this.pending || this.queue.stats.records > 0 || this.priorityQueue.stats.records > 0)) {
      if (!this.pending) this.pump()
      await sleep()
    }
    if (this.child && this.monotonicNow() < deadline && !this.pending?.query) {
      let flushed = false
      void this.request({ kind: 'history-flush' }).then(() => { flushed = true })
      while (!flushed && this.child && this.monotonicNow() < deadline) {
        if (!this.pending) this.pump()
        await sleep()
      }
    }
    this.stop()
  }

  private enqueue(record: MonitorEnvelope, priority = false): void {
    if (!this.stopped) (priority ? this.priorityQueue : this.queue).push(record, MONITOR_RECORD_BYTES)
  }

  private droppedRecords(): number {
    return Math.min(Number.MAX_SAFE_INTEGER,
      this.queue.stats.dropped + this.priorityQueue.stats.dropped + this.processQueue.stats.dropped + mainOperations.dropped + this.lost)
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
          if (this.child !== child) return
          if (this.abandoned && message?.sequence === this.abandoned.sequence) {
            // The late reply of an abandoned query proves the helper is alive
            // and reopens the query lane. It has no waiter, and its snapshot is
            // older than replies already applied, so both are discarded.
            this.abandoned = null
            this.lastReplyAt = this.monotonicNow()
            return
          }
          if (!this.pending || message?.sequence !== this.pending.sequence) return
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
          if (this.pending.query) {
            const result = parseMonitorWorkerQueryResult(message.queryResult)
            if (!result || result.kind !== this.pending.query.request.kind) { this.fail(child); return }
            this.pending.query.resolve(result)
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
    this.abandoned = null
    this.lost += this.pending?.count ?? 0
    this.livenessLost += this.pending?.priority ?? 0
    this.pending?.query?.resolve(null)
    // Waiters cannot carry over: the replacement helper may be seconds away
    // and each renderer caller already keeps its previous page on null.
    for (const query of this.queries.splice(0)) query.resolve(null)
    this.pending = null
    this.processTransfer = null
    this.moreProcesses = false
    this.retryAt = this.monotonicNow() + 5000 * this.launches
    this.cache = { ...this.cache, collector: 'degraded' }
  }

  private canRequest(kind: MonitorWorkerQuery['kind']): boolean {
    return !this.stopped && this.child !== null && (!this.closing || kind === 'history-flush') && this.queries.length < 8
  }

  private request(request: MonitorWorkerQuery, onQueued?: (waiter: QueryWaiter) => void): Promise<MonitorWorkerQueryResult | null> {
    if (!this.canRequest(request.kind)) return Promise.resolve(null)
    return new Promise(resolve => {
      const waiter: QueryWaiter = { request, resolve, sent: false }
      this.queries.push(waiter)
      onQueued?.(waiter)
    })
  }

  private pump(): void {
    mainOperations.sweep()
    try {
      if (this.pending && this.monotonicNow() - this.pending.at > this.pending.timeoutMs) {
        const query = this.pending.query
        if (query && READ_ONLY_QUERIES.has(query.request.kind)) {
          // WHY a slow read-only query no longer kills the helper: its deadline
          // proves only that one disk scan is slow. Killing discarded open rollup
          // buckets and captures, and the replacement re-indexed history before
          // answering, so a Timeline polling a slow disk looped timeout, kill,
          // re-index until the launch budget ran out and monitoring stayed off
          // for the rest of the run. The helper handled this batch's records
          // before awaiting the query, so releasing the credit loses nothing.
          // Records keep flowing; new queries wait for the late reply so slow
          // scans cannot pile up concurrently inside the helper.
          query.resolve(null)
          this.abandoned = { sequence: this.pending.sequence, at: this.monotonicNow() }
          this.pending = null
        } else {
          // Mutating work (report export, history clear, the quit flush) is
          // never abandoned. The helper would keep going after its waiter was
          // told "unavailable": an export could later replace the user's chosen
          // file with no path or Reveal shown, and a clear could finish deleting
          // after the UI said nothing was deleted. Killing the helper at the
          // deadline is what makes the reported outcome true.
          this.fail(this.child)
        }
      }
      // An abandoned scan that never answers is a wedged read, not a slow one.
      // Reopening the query lane would add another stuck scan to the helper's
      // small I/O thread pool every two minutes and starve history writes, so
      // restart the helper instead (this counts against the launch budget).
      if (this.abandoned && this.monotonicNow() - this.abandoned.at > 120_000) this.fail(this.child)
      if (!this.child && this.monotonicNow() >= this.retryAt) this.launch()
      if (!this.child || this.pending) return
      // Reserve 100 of 120 slots for a complete process generation. At the
      // declared 2,048-target + 256-Electron ceiling this drains in 4.8s,
      // independent of an operation storm. A slow worker finishes its current
      // generation before the source admits a new one; it never restarts the
      // same half-transfer every five seconds. Both queues total <2 MiB.
      // Liveness evidence goes first and never waits behind an operation storm.
      const priority = this.priorityQueue.drain(40, 40 * MONITOR_RECORD_BYTES)
      const processLimit = Math.min(100, 120 - priority.length)
      const processes = this.processQueue.drain(processLimit, processLimit * MONITOR_RECORD_BYTES)
      const restLimit = 120 - priority.length - processes.length
      const records = [...priority, ...processes, ...this.queue.drain(restLimit, restLimit * MONITOR_RECORD_BYTES)]
      const queryReady = this.queries.length > 0 && !this.abandoned
      if (!records.length && !this.moreProcesses && !queryReady) return
      const sequence = ++this.sequence
      // One credit means a suspended worker cannot accumulate an invisible
      // Electron message-port queue. A record batch or mutating query that
      // misses its deadline kills the helper, counts its in-flight records as
      // lost and consumes the app-run restart budget; a read-only query is
      // abandoned instead (see above).
      const query = queryReady ? this.queries.shift() : undefined
      if (query) query.sent = true
      // A clear gets the export's longer deadline: removing a large history
      // folder on a slow disk legitimately takes more than ten seconds, and it
      // is no longer abandoned, so a short deadline would kill a working clear.
      const kind = query?.request.kind
      const timeoutMs = kind === 'report-export' || kind === 'history-clear' ? 60_000
        : kind === 'history-flush' ? 2500 : query ? 10_000 : 5000
      this.pending = { sequence, at: this.monotonicNow(), count: records.length, priority: priority.length, timeoutMs, ...(query ? { query } : {}) }
      this.child.postMessage({ sequence, runId: this.cache.runId, historyRoot: MONITOR_HISTORY_DIR, restarts: Math.max(0, this.launches - 1), records,
        liveWindowIds: [...this.liveWindows], visibleWindowIds: [...this.visibleWindows],
        droppedRecords: this.droppedRecords(),
        livenessDroppedRecords: Math.min(Number.MAX_SAFE_INTEGER, this.priorityQueue.stats.dropped + this.livenessLost),
        ...(query ? { query: query.request } : {}) })
    } catch { this.fail(this.child) }
  }
}

type QueryWaiter = { request: MonitorWorkerQuery; resolve: (value: MonitorWorkerQueryResult | null) => void; sent: boolean }
const validRange = (from: number, to: number): boolean => Number.isFinite(from) && Number.isFinite(to)
  && from >= 0 && to >= from && to <= Number.MAX_SAFE_INTEGER && to - from <= MONITOR_POLICY.historyMs

export const monitorCoordinator = new MonitorCoordinator()
