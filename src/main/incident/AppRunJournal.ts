import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { arch, platform } from 'node:os'
import { join } from 'node:path'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import { pid, versions } from 'node:process'
import { getHeapStatistics } from 'node:v8'
import { BrowserWindow } from 'electron'

import { INCIDENT_RUNS_DIR, STATE_DIR } from '@main/storage/paths.js'
import { scheduleDebugStoragePrune } from '@main/storage/debugRetention.js'
import type { StateProcessLock } from '@main/storage/processLock.js'
import { createAppRunId } from '@main/incident/appRunIds.js'
import type {
  AppRunHeartbeat,
  AppRunJournalEvent,
  AppRunJournalEventInput,
  AppRunJournalManifest,
} from '@main/incident/journalTypes.js'
import { sanitizePerformanceData } from '@shared/performance/serialization.js'

const HEARTBEAT_INTERVAL_MS = 5_000
const FLUSH_INTERVAL_MS = 1_000
const MAX_PENDING_EVENTS = 2_000

type AcquiredStateProcessLock = Extract<StateProcessLock, { acquired: true }>

type AppRunJournalOptions = {
  appVersion: string
  perfEnabled: boolean
  lock: AcquiredStateProcessLock
}

export class AppRunJournal {
  readonly appRunId: string
  readonly runDir: string

  private readonly manifest: AppRunJournalManifest
  private readonly eventsPath: string
  private readonly heartbeatPath: string
  private readonly cleanShutdownPath: string
  private readonly eventLoopDelay = monitorEventLoopDelay({ resolution: 20 })
  private pending: AppRunJournalEvent[] = []
  private droppedPendingEvents = 0
  private nextEventSeq = 1
  private heartbeatSeq = 1
  private flushTimer: ReturnType<typeof setInterval> | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private writeQueue: Promise<void> = Promise.resolve()
  private started = false
  private cleanShutdownMarked = false

  constructor(options: AppRunJournalOptions) {
    const startedAt = new Date()
    this.appRunId = createAppRunId(startedAt, pid)
    this.runDir = join(INCIDENT_RUNS_DIR, this.appRunId)
    this.eventsPath = join(this.runDir, 'events.jsonl')
    this.heartbeatPath = join(this.runDir, 'heartbeat.json')
    this.cleanShutdownPath = join(this.runDir, 'clean-shutdown')
    this.manifest = {
      schemaVersion: 1,
      appRunId: this.appRunId,
      startedAt: startedAt.getTime(),
      startedAtIso: startedAt.toISOString(),
      pid,
      platform: platform(),
      arch: arch(),
      node: versions.node,
      electron: versions.electron,
      chrome: versions.chrome,
      appVersion: options.appVersion,
      stateDir: STATE_DIR,
      perfEnabled: options.perfEnabled,
      lock: {
        // Token deliberately omitted — see AppRunJournalManifest.lock. The lock
        // token is a removal secret and must not land in a retained file.
        path: options.lock.path,
      },
    }
  }

  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    await mkdir(this.runDir, { recursive: true })
    await writeFile(join(this.runDir, 'manifest.json'), `${JSON.stringify(this.manifest, null, 2)}\n`, 'utf8')
    this.eventLoopDelay.enable()
    this.flushTimer = setInterval(() => {
      void this.flush()
    }, FLUSH_INTERVAL_MS)
    this.flushTimer.unref()
    this.heartbeatTimer = setInterval(() => {
      void this.writeHeartbeat()
    }, HEARTBEAT_INTERVAL_MS)
    this.heartbeatTimer.unref()
    this.record({
      area: 'app.lifecycle',
      name: 'app.run.started',
      data: {
        runDir: this.runDir,
        perfEnabled: this.manifest.perfEnabled,
      },
    })
    await this.writeHeartbeat()
    scheduleDebugStoragePrune('incident-run-start')
  }

  record(input: AppRunJournalEventInput): void {
    if (!this.started) return
    const event = this.createEvent(input)
    if (this.pending.length >= MAX_PENDING_EVENTS) {
      // WHY drop oldest: the incident journal is supposed to explain pressure,
      // not add pressure. A stuck disk or broken filesystem during a bad run
      // should cost us old breadcrumbs, not unbounded heap growth in main.
      this.pending.shift()
      this.droppedPendingEvents += 1
    }
    this.pending.push(event)
  }

  recordError(name: string, error: unknown, data?: Record<string, unknown>): void {
    const normalizedError = error instanceof Error
      ? { name: error.name, message: error.message, stack: error.stack }
      : { message: String(error) }
    this.record({
      area: areaFromName(name),
      name,
      severity: 'error',
      data: {
        ...data,
        error: normalizedError,
      },
    })
  }

  async flush(): Promise<void> {
    if (!this.started) return
    const batch = this.takePendingBatch()
    if (batch.length === 0) return
    const lines = batch.map(event => JSON.stringify(event)).join('\n') + '\n'
    this.writeQueue = this.writeQueue
      .catch(() => {})
      .then(async () => {
        await mkdir(this.runDir, { recursive: true })
        await writeFile(this.eventsPath, lines, { encoding: 'utf8', flag: 'a' })
      })
      .catch(err => {
        // The journal is forensics, not product state. A disk-full or
        // permission failure must not crash the Electron main process while we
        // are recording why the app is already unhealthy. But silently dropping
        // this batch would discard the NEWEST events during exactly the
        // disk-trouble the journal exists to capture, so re-queue them at the
        // front and let the next flush retry. Re-queueing is bounded: record()'s
        // drop-oldest rule (and the trim below) keep `pending` at MAX_PENDING_EVENTS.
        console.warn('[incident-journal] event append failed; re-queueing batch:', err)
        this.pending.unshift(...batch)
        while (this.pending.length > MAX_PENDING_EVENTS) {
          this.pending.shift()
          this.droppedPendingEvents += 1
        }
      })
    await this.writeQueue
  }

  /**
   * Synchronous drain of the pending buffer. {@link flush} is async and relies
   * on the 1s timer or a microtask to land its writes — neither survives
   * Electron's quit teardown, because the process exits as soon as the
   * synchronous `will-quit`/`before-quit` listeners return. So the quit path
   * (stop / markCleanShutdown) MUST persist synchronously or it loses every
   * event queued at shutdown (app.before_quit / app.will_quit and any
   * late-startup breadcrumbs). Bounded by MAX_PENDING_EVENTS, so the single
   * appendFileSync stays cheap.
   */
  private flushSync(): void {
    if (!this.started) return
    const batch = this.takePendingBatch()
    if (batch.length === 0) return
    const lines = batch.map(event => JSON.stringify(event)).join('\n') + '\n'
    try {
      mkdirSync(this.runDir, { recursive: true })
      appendFileSync(this.eventsPath, lines, 'utf8')
    } catch (err) {
      console.warn('[incident-journal] synchronous flush failed:', err)
    }
  }

  stop(): void {
    if (this.flushTimer) clearInterval(this.flushTimer)
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.flushTimer = null
    this.heartbeatTimer = null
    this.eventLoopDelay.disable()
    // Synchronous: the async flush() never lands during quit teardown (see flushSync).
    this.flushSync()
  }

  markCleanShutdown(reason: string): void {
    if (!this.started || this.cleanShutdownMarked) return
    this.cleanShutdownMarked = true
    // Queue the clean-shutdown event alongside whatever is still pending
    // (app.before_quit / app.will_quit), then drain the whole buffer
    // SYNCHRONOUSLY. The async flush() cannot land these at quit — Electron
    // exits the moment the synchronous quit listeners return — so routing them
    // through it would truncate events.jsonl just before the most interesting
    // moment. flushSync writes the full tail in one append.
    this.pending.push(this.createEvent({
      area: 'app.lifecycle',
      name: 'app.shutdown.clean',
      data: { reason },
    }))
    this.flushSync()
    // WHY a separate marker FILE on top of the event: events.jsonl tells the
    // story, but future startup code keys off the mere presence of this tiny
    // file to distinguish "the user quit cleanly" from "main vanished". It must
    // be written synchronously for the same quit-teardown-race reason.
    const ts = Date.now()
    try {
      mkdirSync(this.runDir, { recursive: true })
      writeFileSync(
        this.cleanShutdownPath,
        `${JSON.stringify({
          schemaVersion: 1,
          appRunId: this.appRunId,
          ts,
          tsIso: new Date(ts).toISOString(),
          reason,
        }, null, 2)}\n`,
        'utf8',
      )
    } catch (err) {
      console.warn('[incident-journal] failed to mark clean shutdown:', err)
    }
  }

  private takePendingBatch(): AppRunJournalEvent[] {
    const batch = this.pending
    this.pending = []
    const dropped = this.droppedPendingEvents
    this.droppedPendingEvents = 0
    if (dropped > 0) {
      batch.unshift(this.createEvent({
        area: 'incident.journal',
        name: 'incident.journal.events_dropped',
        severity: 'warn',
        data: { dropped },
      }))
    }
    return batch
  }

  private createEvent(input: AppRunJournalEventInput): AppRunJournalEvent {
    const ts = Date.now()
    return {
      schemaVersion: 1,
      seq: this.nextEventSeq++,
      ts,
      tsIso: new Date(ts).toISOString(),
      monotonicMs: performance.now(),
      appRunId: this.appRunId,
      area: input.area,
      name: input.name,
      severity: input.severity ?? 'info',
      ids: input.ids,
      data: sanitizePerformanceData(input.data, { verbose: false }),
    }
  }

  private async writeHeartbeat(): Promise<void> {
    if (!this.started) return
    const heartbeat = this.createHeartbeat()
    try {
      await mkdir(this.runDir, { recursive: true })
      await writeFile(this.heartbeatPath, `${JSON.stringify(heartbeat, null, 2)}\n`, 'utf8')
    } catch (err) {
      console.warn('[incident-journal] heartbeat write failed:', err)
    }
  }

  private createHeartbeat(): AppRunHeartbeat {
    const memory = process.memoryUsage()
    const heap = getHeapStatistics()
    const windows = BrowserWindow.getAllWindows()
    const focused = BrowserWindow.getFocusedWindow() !== null
    const delayMean = Number.isFinite(this.eventLoopDelay.mean) ? this.eventLoopDelay.mean : 0
    const heartbeat: AppRunHeartbeat = {
      schemaVersion: 1,
      appRunId: this.appRunId,
      seq: this.heartbeatSeq++,
      ts: Date.now(),
      tsIso: new Date().toISOString(),
      uptimeMs: Math.round(process.uptime() * 1000),
      pid,
      memory: {
        rss: memory.rss,
        heapUsed: memory.heapUsed,
        heapTotal: memory.heapTotal,
        heapLimit: heap.heap_size_limit,
        external: memory.external,
        arrayBuffers: memory.arrayBuffers,
      },
      mainEventLoop: {
        delayMeanMs: nsToMs(delayMean),
        delayMaxMs: nsToMs(this.eventLoopDelay.max),
        delayP99Ms: nsToMs(this.eventLoopDelay.percentile(99)),
      },
      window: {
        count: windows.length,
        focused,
      },
      lastEventSeq: this.nextEventSeq - 1,
    }
    this.eventLoopDelay.reset()
    return heartbeat
  }
}

function areaFromName(name: string): string {
  const parts = name.split('.')
  return parts.length >= 2 ? `${parts[0]}.${parts[1]}` : 'app'
}

function nsToMs(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.round((value / 1_000_000) * 100) / 100
}
