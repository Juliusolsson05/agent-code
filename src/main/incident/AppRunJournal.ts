import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { arch, platform } from 'node:os'
import { join } from 'node:path'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import { pid, versions } from 'node:process'
import { getHeapStatistics } from 'node:v8'
import { BrowserWindow } from 'electron'

import { INCIDENT_RUNS_DIR, STATE_DIR } from '@main/storage/paths.js'
import { scheduleDebugStoragePrune } from '@main/storage/debugRetention.js'
import type { StateProcessLock } from '@main/storage/processLock.js'
import { createIncidentId, getAppRunId } from '@main/incident/appRunIds.js'
import type {
  AppRunHeartbeat,
  AppRunIncident,
  AppRunIncidentInput,
  AppRunJournalEvent,
  AppRunJournalEventInput,
  AppRunJournalManifest,
} from '@main/incident/journalTypes.js'
import { sanitizePerformanceData } from '@shared/performance/serialization.js'

const HEARTBEAT_INTERVAL_MS = 5_000
const FLUSH_INTERVAL_MS = 1_000
const MAX_PENDING_EVENTS = 2_000
// Hard per-run ceiling on total bytes appended to events.jsonl + incidents.jsonl.
// WHY: the historical "logging ate 500 GB" incident came from append-only logs
// with no per-file ceiling. heartbeat.json here is overwrite-only (constant
// size), but events/incidents are append-only — so a pathological record() loop
// in one long-lived run could still grow them without bound, AND that run is
// protected from retention (it's always the newest 50). This ceiling makes EACH
// run's journal provably bounded; with the incidents retention bucket on top,
// the whole tree cannot run away. 50 MiB is ~10000x a normal run (~5 KB), so it
// only ever trips on a genuine fault — at which point dropping further records
// is the right call (the journal must never be the thing that fills the disk).
const MAX_RUN_JOURNAL_BYTES = 50 * 1024 * 1024

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
  private readonly incidentsPath: string
  private readonly heartbeatPath: string
  private readonly cleanShutdownPath: string
  private readonly eventLoopDelay = monitorEventLoopDelay({ resolution: 20 })
  private pending: AppRunJournalEvent[] = []
  private droppedPendingEvents = 0
  private nextEventSeq = 1
  private nextIncidentSeq = 1
  private heartbeatSeq = 1
  // Running total of bytes appended to events.jsonl + incidents.jsonl this run,
  // and a one-shot flag so we log the cap being hit exactly once. heartbeat.json
  // is excluded (overwrite-only — it can't grow).
  private journalBytesWritten = 0
  private journalCapped = false
  private flushTimer: ReturnType<typeof setInterval> | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private writeQueue: Promise<void> = Promise.resolve()
  private started = false
  private cleanShutdownMarked = false
  private heartbeatInFlight = false

  constructor(options: AppRunJournalOptions) {
    const startedAt = new Date()
    // Canonical, shared run id (see getAppRunId) — NOT a journal-private id.
    // PerformanceService stamps the same value, so incidents and perf runs
    // correlate by one key.
    this.appRunId = getAppRunId()
    this.runDir = join(INCIDENT_RUNS_DIR, this.appRunId)
    this.eventsPath = join(this.runDir, 'events.jsonl')
    this.incidentsPath = join(this.runDir, 'incidents.jsonl')
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
    try {
      await mkdir(this.runDir, { recursive: true })
      await writeFile(join(this.runDir, 'manifest.json'), `${JSON.stringify(this.manifest, null, 2)}\n`, 'utf8')
    } catch (err) {
      // The journal must NEVER gate app launch. A full / read-only / sandboxed
      // ~/.config is a disk problem, not a reason the product can't start — and
      // it would be doubly ironic for the disk-safety feature to brick boot.
      // Degrade to a no-op: started=false makes record()/recordIncident() and the
      // timers below inert, so the app boots cleanly without a journal. This is
      // the same "forensics, not product state" invariant the write paths hold.
      this.started = false
      console.warn('[incident-journal] failed to start; running without a journal:', err)
      return
    }
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
    this.record({
      area: areaFromName(name),
      name,
      severity: 'error',
      data: {
        ...data,
        error: normalizeError(error),
      },
    })
  }

  /**
   * Record a higher-level failure fact to incidents.jsonl. Incidents are rare
   * and almost always crash-adjacent, so this writes SYNCHRONOUSLY and first
   * flushSync()s the pending event buffer — that way the breadcrumb timeline
   * leading up to the incident is durable even if the process dies milliseconds
   * later (the 1s async flush would otherwise lose the final ~second of events,
   * which is exactly the window before a crash). This is the always-on stand-in
   * for a "flush the in-memory ring on incident" dump.
   *
   * The incident is also mirrored as a normal event so a single events.jsonl
   * scan shows it inline with lifecycle context; incidents.jsonl is the
   * triage-friendly index of just the failures.
   */
  recordIncident(input: AppRunIncidentInput): void {
    if (!this.started) return
    this.flushSync()
    const ts = Date.now()
    const incident: AppRunIncident = {
      schemaVersion: 1,
      incidentId: createIncidentId(new Date(ts)),
      appRunId: this.appRunId,
      seq: this.nextIncidentSeq++,
      ts,
      tsIso: new Date(ts).toISOString(),
      kind: input.kind,
      severity: input.severity,
      process: input.process,
      reason: input.reason,
      exitCode: input.exitCode,
      error: normalizeError(input.error),
      context: sanitizePerformanceData(input.context, { verbose: false }) as
        | Record<string, unknown>
        | undefined,
    }
    const incidentLine = `${safeStringify(incident)}\n`
    if (this.reserveJournalBytes(Buffer.byteLength(incidentLine, 'utf8'))) {
      try {
        mkdirSync(this.runDir, { recursive: true })
        appendFileSync(this.incidentsPath, incidentLine, 'utf8')
      } catch (err) {
        console.warn('[incident-journal] incident append failed:', err)
      }
    }
    this.record({
      area: 'incident',
      name: input.kind,
      severity: input.severity,
      data: {
        incidentId: incident.incidentId,
        reason: input.reason,
        exitCode: input.exitCode,
      },
    })
  }

  // Returns true if `len` more bytes may be appended to the run's journal files,
  // accounting for them; false once the per-run ceiling is reached (and logs the
  // cap once). This is the hard backstop against a runaway run filling the disk.
  private reserveJournalBytes(len: number): boolean {
    // Project the total BEFORE admitting, so the file never overshoots the cap by
    // a whole batch (a single event's nested data can itself be many KB).
    if (this.journalBytesWritten + len > MAX_RUN_JOURNAL_BYTES) {
      if (!this.journalCapped) {
        this.journalCapped = true
        console.warn(
          `[incident-journal] per-run journal cap (${MAX_RUN_JOURNAL_BYTES} bytes) reached; ` +
          'dropping further events/incidents for this run to bound disk usage',
        )
      }
      return false
    }
    this.journalBytesWritten += len
    return true
  }

  async flush(): Promise<void> {
    if (!this.started) return
    const batch = this.takePendingBatch()
    if (batch.length === 0) return
    const lines = batch.map(safeStringify).join('\n') + '\n'
    const bytes = Buffer.byteLength(lines, 'utf8')
    if (!this.reserveJournalBytes(bytes)) return
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
        // front and let the next flush retry. Un-reserve the bytes that never
        // reached disk so the counter tracks real on-disk size (the re-queued
        // batch is re-counted on the next flush). Re-queueing is bounded:
        // record()'s drop-oldest rule (and the trim below) keep `pending` at MAX.
        this.journalBytesWritten = Math.max(0, this.journalBytesWritten - bytes)
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
    const lines = batch.map(safeStringify).join('\n') + '\n'
    if (!this.reserveJournalBytes(Buffer.byteLength(lines, 'utf8'))) return
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
    // Single write in flight: on a slow disk a >5s write would otherwise overlap
    // the next timer tick and interleave into a torn heartbeat.json. Skip rather
    // than queue — heartbeats are disposable, only the latest matters.
    if (!this.started || this.heartbeatInFlight) return
    this.heartbeatInFlight = true
    const heartbeat = this.createHeartbeat()
    // Atomic temp+rename: the crash-moment heartbeat (last memory/uptime before
    // death) is the highest-value sample, and a torn/truncated file would defeat
    // both the debug-bundle copy and any future reader. rename() is atomic on the
    // same filesystem, so a reader always sees a complete prior version.
    const tmpPath = `${this.heartbeatPath}.tmp`
    try {
      await mkdir(this.runDir, { recursive: true })
      await writeFile(tmpPath, `${JSON.stringify(heartbeat, null, 2)}\n`, 'utf8')
      await rename(tmpPath, this.heartbeatPath)
    } catch (err) {
      console.warn('[incident-journal] heartbeat write failed:', err)
    } finally {
      this.heartbeatInFlight = false
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

// Stringify that can never throw. A circular reference or otherwise
// non-serializable `data`/`context` field must NEVER throw out of the journal:
// these run on the quit / lock-release path, so an exception there would leak the
// state lock (the exact failure the journal exists to prevent). NOTE: callers
// must still pass flat, pre-redacted data — sanitizePerformanceData only
// redacts/truncates TOP-LEVEL keys, it does not recurse into nested objects.
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return JSON.stringify({ schemaVersion: 1, serializationError: true })
  }
}

function normalizeError(
  error: unknown,
): { name?: string; message: string; stack?: string } | undefined {
  if (error === undefined || error === null) return undefined
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack }
  }
  return { message: String(error) }
}

function nsToMs(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.round((value / 1_000_000) * 100) / 100
}
