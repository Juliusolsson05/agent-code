import { createReadStream, createWriteStream } from 'node:fs'
import { appendFile, mkdir, open, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import { finished } from 'node:stream/promises'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import type { MonitorIncident } from '@shared/performance/monitorIncidents.js'
import { parseMonitorIncident } from '@shared/performance/parseMonitorIncident.js'
import { parseMonitorHistoryPoint } from '@shared/performance/parseMonitorHistory.js'
import { parseMonitorSnapshot } from '@shared/performance/parseMonitorSnapshot.js'
import { MONITOR_POLICY } from '@shared/performance/monitorPolicy.js'
import type {
  MonitorHistoryPage, MonitorHistoryPoint, MonitorHistoryResolution,
  MonitorHistoryStatus, MonitorReportPreview, MonitorReportResult,
} from '@shared/performance/monitorHistory.js'
import type { MonitorProcessSummary } from '@shared/performance/processSnapshot.js'
import type { MonitorWorkerSnapshot } from '@shared/performance/monitorSnapshot.js'
import { HISTORY_INTERVAL as INTERVAL, TierRollup, mergePoints, pointFrom } from './historyRollup.js'
import { moveArtifact } from './moveArtifact.js'

const RUNS_DIR = 'runs'
const EXPORTS_DIR = 'exports'
const DATA_BUDGET = 64 * 1024 * 1024
const HARD_BUDGET = 128 * 1024 * 1024
const INCIDENT_BUDGET = 8 * 1024 * 1024
const OPERATIONS_BUDGET = 1024 * 1024
const REPORT_BUDGET = 8 * 1024 * 1024
const LINE_LIMIT = 16 * 1024
const INCIDENT_LIMIT = MONITOR_POLICY.incidentCount
// About seven minutes of rolled-up points (67 per minute across tiers). A disk
// that stalls longer sheds new points as "shortened" coverage instead of
// growing an in-memory backlog inside the helper.
const PENDING_POINT_LIMIT = 512
// A valid point filled with MAX_SAFE_INTEGER values serializes to roughly 652
// bytes. Three hundred points leave more than 60 KiB inside the shared 256 KiB
// response ceiling for framing, status and fifty incident summaries.
const QUERY_POINT_LIMIT = MONITOR_POLICY.historyPagePoints
const TIERS = ['1s', '10s', '1m'] as const
const RETENTION: Record<MonitorHistoryResolution, number> = {
  '1s': 15 * 60_000,
  '10s': 24 * 60 * 60_000,
  '1m': 7 * 24 * 60 * 60_000,
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER
type FileStat = { run: string; resolution: MonitorHistoryResolution; points: number; bytes: number; oldestAt: number | null; newestAt: number | null }

/** Utility-process-owned durable history. The main and renderer paths only
 * exchange bounded records and query pages; slow disks cannot delay prompts,
 * input, painting, or the event-loop probe that diagnoses those paths.
 *
 * WHY an in-memory index: status, resolution choice, incident reads and
 * maintenance previously rescanned every run directory and every JSONL line
 * (maintenance rewrote every tier file every minute). The index is built once
 * at startup and kept exact by the only writer, this store, so steady-state
 * work is proportional to what changed rather than to seven days of history. */
export class MonitorHistoryStore {
  private readonly runDir: string
  private ready: Promise<void>
  private draining: Promise<void> | null = null
  private bytes = 0
  private degraded = false
  private shortened = false
  private exporting = false
  private index = new Map<string, FileStat>()
  private incidentRuns = new Map<string, MonitorIncident[]>()
  private repairedTails = new Set<string>()
  // False until startup indexing completes. Retention deletes any run the
  // index does not know about, so a partial index (EPERM, ENOSPC or an I/O
  // error during startup) must never be treated as "those runs are empty":
  // that would silently erase a week of history exactly when storage is sick.
  private indexed = false
  // Runs with a file that could not be indexed. Retention must treat them as
  // unknown, not empty; only the capacity budget may still remove them.
  private unindexedRuns = new Set<string>()
  private rollups: Record<MonitorHistoryResolution, TierRollup> = { '1s': new TierRollup('1s'), '10s': new TierRollup('10s'), '1m': new TierRollup('1m') }
  // Coalesced work. Incidents and operations are whole-value replacements, so
  // only the newest value matters; the old promise chain queued one rewrite
  // per snapshot and grew without bound whenever the disk fell behind.
  private pendingPoints: MonitorHistoryPoint[] = []
  private pendingIncidents: MonitorIncident[] | null = null
  private pendingOperations: string | null = null
  private maintenanceDue: number | null = null
  private lastMaintenanceAt = -Infinity
  private operationFingerprint = ''

  constructor(private readonly root: string, private readonly runId: string, private readonly now: () => number = () => Date.now()) {
    this.runDir = join(root, RUNS_DIR, runId)
    // Every append/query is ordered after startup indexing. Letting the first
    // record race initialization can undercount existing bytes and exceed the
    // disk ceiling before the first maintenance pass notices.
    this.ready = this.initialize()
  }

  status(): MonitorHistoryStatus {
    let points = 0
    let oldestAt: number | null = null
    let newestAt: number | null = null
    // Derived from the index on every read. Cached counters went stale after
    // compaction and budget pruning removed points they had already counted.
    for (const file of this.index.values()) {
      points += file.points
      if (file.oldestAt !== null) oldestAt = oldestAt === null ? file.oldestAt : Math.min(oldestAt, file.oldestAt)
      if (file.newestAt !== null) newestAt = newestAt === null ? file.newestAt : Math.max(newestAt, file.newestAt)
    }
    let incidents = 0
    for (const rows of this.incidentRuns.values()) incidents += rows.length
    return {
      state: this.degraded ? 'degraded' : 'healthy', bytes: this.bytes, oldestAt, newestAt, points,
      incidents, exporting: this.exporting, shortened: this.shortened,
    }
  }

  record(snapshot: MonitorWorkerSnapshot, processes: MonitorProcessSummary | null, incidents: MonitorIncident[] | null, droppedRecords: number, restarts: number): void {
    const point = pointFrom(snapshot, processes, '1s', droppedRecords, restarts)
    for (const tier of TIERS) {
      const done = this.rollups[tier].add(point)
      if (done) this.queuePoint(done)
    }
    // `null` means unchanged. The worker detects change from a cheap summary
    // fingerprint; stringifying up to fifty full evidence sets here every
    // second cost ~1 MiB of JSON per second of helper CPU for no new data.
    if (incidents) this.pendingIncidents = incidents.slice(-INCIDENT_LIMIT)
    const operationJson = JSON.stringify(snapshot.operations.slice(0, 100))
    if (operationJson !== this.operationFingerprint) {
      this.operationFingerprint = operationJson
      this.pendingOperations = operationJson
    }
    // A backward wall-clock step also counts as due: otherwise compaction,
    // retention and pruning pause for the size of the step and a multi-day
    // step ends with every tier shortened by the capacity budget instead.
    if (snapshot.sampledAt - this.lastMaintenanceAt >= 60_000 || snapshot.sampledAt < this.lastMaintenanceAt) {
      this.lastMaintenanceAt = snapshot.sampledAt
      this.maintenanceDue = snapshot.sampledAt
    }
    this.schedule()
  }

  /** Quit-path durability: close the open rollup buckets and wait for disk. */
  async flush(): Promise<void> {
    await this.ready
    for (const tier of TIERS) {
      const open = this.rollups[tier].take()
      if (open) this.queuePoint(open)
    }
    this.schedule()
    await this.settled()
  }

  async query(from: number, to: number, cursor: string | undefined, limit: number): Promise<MonitorHistoryPage> {
    await this.settled()
    const resolution = this.resolution(from, to)
    const incidentSummaries = this.incidentsIn(from, to).map(({ evidence, ...summary }) => ({ ...summary, evidenceCount: evidence.length }))
    const safeLimit = Number.isFinite(limit) ? limit : 500
    const skip = /^\d+$/.test(cursor ?? '') ? Math.min(1_000_000, Number(cursor)) : 0
    const overview = cursor === undefined && Math.floor(safeLimit) >= 1000
    const boundedLimit = Math.max(1, Math.min(QUERY_POINT_LIMIT, Math.floor(safeLimit)))
    if (overview) {
      // The timeline asks for the maximum bounded page because it needs an
      // overview, not raw backward pagination. Time buckets cover the entire
      // selected interval in one response, so "7 days" cannot silently become
      // "the latest 16 hours" when the minute tier contains 10,080 points.
      // Buckets merge by peak (see mergePoints): a short stall stays visible.
      const bucketMs = Math.max(INTERVAL[resolution], Math.ceil((to - from + 1) / boundedLimit))
      const buckets = new Map<number, MonitorHistoryPoint>()
      for await (const point of this.points(resolution, from, to)) {
        const key = Math.floor((point.at - from) / bucketMs)
        const existing = buckets.get(key)
        buckets.set(key, existing ? mergePoints(existing, point) : point)
      }
      const points = [...buckets.values()].sort((a, b) => a.at - b.at)
      return { resolution, from, to, points, incidents: incidentSummaries, nextCursor: null, complete: true, status: this.status() }
    }
    const ring: MonitorHistoryPoint[] = []
    let eligible = 0
    for await (const point of this.points(resolution, from, to)) {
      eligible++
      ring.push(point)
      if (ring.length > skip + boundedLimit) ring.shift()
    }
    // Pages move backward from the newest evidence. The monitor therefore
    // opens on "now" without loading a full seven-day run, while each returned
    // page remains chronological for chart and table rendering.
    const end = Math.max(0, ring.length - skip)
    const points = ring.slice(Math.max(0, end - boundedLimit), end)
    const hasMore = eligible > skip + points.length
    return { resolution, from, to, points, incidents: incidentSummaries, nextCursor: hasMore ? String(skip + points.length) : null, complete: !hasMore, status: this.status() }
  }

  async readIncident(at: number, id: number): Promise<MonitorIncident | null> {
    if (!finite(at) || !Number.isSafeInteger(id) || id < 1) return null
    await this.settled()
    return this.incidentsIn(at, at).find(incident => incident.id === id && incident.at === at) ?? null
  }

  async preview(from: number, to: number): Promise<MonitorReportPreview> {
    await this.settled()
    const duration = Math.max(0, to - from)
    const interval = INTERVAL[this.resolution(from, to)]
    return {
      from, to, estimatedBytes: Math.min(REPORT_BUDGET, 4096 + Math.ceil(duration / interval) * 480),
      dataClasses: ['metrics', 'operations', 'incidents', 'coverage', 'build'], localOnly: true, status: this.status(),
    }
  }

  async exportReport(from: number, to: number, destination: string, build: Record<string, string | boolean>): Promise<MonitorReportResult> {
    if (this.exporting) return { ok: false, code: 'busy' }
    if (!finite(from) || !finite(to) || from > to || to - from > RETENTION['1m']) return { ok: false, code: 'invalid-range' }
    this.exporting = true
    await this.settled()
    let stream: ReturnType<typeof createWriteStream> | null = null
    // App-owned scratch, swept at startup (see moveArtifact for why not beside
    // the user's destination).
    const tempDestination = join(this.root, EXPORTS_DIR, `report-${process.pid}-${this.now()}.tmp`)
    try {
      await mkdir(join(this.root, EXPORTS_DIR), { recursive: true, mode: 0o700 })
      stream = createWriteStream(tempDestination, { encoding: 'utf8', flags: 'wx', mode: 0o600 })
      let written = 0
      const write = async (chunk: string): Promise<void> => {
        written += Buffer.byteLength(chunk)
        if (written > REPORT_BUDGET) throw new Error('report-budget')
        if (!stream!.write(chunk)) await once(stream!, 'drain')
      }
      const safeBuild = Object.fromEntries(Object.entries(build).filter(([key, value]) => /^[a-zA-Z][a-zA-Z0-9]{0,31}$/.test(key)
        && (typeof value === 'boolean' || (typeof value === 'string' && value.length <= 128))))
      await write(JSON.stringify({ schemaVersion: 1, kind: 'agent-code-performance-report', createdAt: this.now(), range: { from, to }, localOnly: true, build: safeBuild, coverage: this.status() }).slice(0, -1))
      await write(',"points":[')
      let pointCount = 0
      for await (const point of this.points(this.resolution(from, to), from, to)) {
        await write(`${pointCount ? ',' : ''}${JSON.stringify(point)}`); pointCount++
      }
      // Operation histograms are cumulative for a whole app run; they cannot
      // be cut to the requested range. The report previously attached the
      // newest run's histogram to any range, including ranges from other
      // runs. Each overlapping run is now labeled with the span it actually
      // describes, and run identifiers are omitted like window IDs below.
      await write('],"operations":[')
      let operationRuns = 0
      for (const run of this.runsOverlapping(from, to)) {
        const summaries = await this.readOperations(run.name)
        if (!summaries) continue
        await write(`${operationRuns ? ',' : ''}{"scope":"whole-run","from":${run.oldestAt},"to":${run.newestAt},"summaries":${summaries}}`)
        operationRuns++
      }
      await write('],"incidents":[')
      const incidents = this.incidentsIn(from, to)
      const aliases = new Map<number, string>()
      const alias = (scope: number): string => {
        if (scope === 0) return 'application'
        const existing = aliases.get(scope)
        if (existing) return existing
        const value = `window-${aliases.size + 1}`
        aliases.set(scope, value)
        return value
      }
      for (let index = 0; index < incidents.length; index++) {
        const incident = incidents[index]!
        // Runtime window IDs are useful while inspecting the live application,
        // but they do not belong in the intentionally content-minimized report.
        // Alias both the incident and every evidence row through one map so the
        // correlation survives without exporting application identifiers.
        const safe = {
          ...incident,
          scope: alias(incident.scope),
          evidence: incident.evidence.map(point => ({ ...point, scope: alias(point.scope) })),
        }
        await write(`${index ? ',' : ''}${JSON.stringify(safe)}`)
      }
      await write(']}')
      stream.end()
      // `finished` observes both close and error. Waiting only for `close`
      // leaves a late ENOSPC error without a listener and can terminate the
      // utility process instead of returning a bounded write-failed result.
      await finished(stream)
      await moveArtifact(tempDestination, destination)
      return { ok: true, path: destination, bytes: written, points: pointCount, incidents: incidents.length }
    } catch {
      stream?.destroy()
      // Never remove the destination on failure: it may be an existing report
      // the user chose to replace, and the temporary file owns this attempt.
      await rm(tempDestination, { force: true }).catch(() => {})
      return { ok: false, code: 'write-failed' }
    } finally { this.exporting = false }
  }

  async clear(): Promise<MonitorHistoryStatus> {
    if (this.exporting) return this.status()
    await this.settled()
    // Open buckets and coalesced values belong to the history being deleted.
    this.pendingPoints = []; this.pendingIncidents = null; this.pendingOperations = null; this.maintenanceDue = null
    for (const tier of TIERS) this.rollups[tier].reset()
    try {
      await rm(join(this.root, RUNS_DIR), { recursive: true, force: true })
      await mkdir(this.runDir, { recursive: true })
      this.index.clear(); this.incidentRuns.clear(); this.repairedTails.clear(); this.indexed = true
      this.bytes = 0; this.shortened = false; this.degraded = false
      this.operationFingerprint = ''; this.unindexedRuns.clear()
      this.lastMaintenanceAt = -Infinity
    } catch { this.degraded = true }
    return this.status()
  }

  async settled(): Promise<void> {
    await this.ready
    while (this.draining) await this.draining
  }

  private queuePoint(point: MonitorHistoryPoint): void {
    if (this.pendingPoints.length >= PENDING_POINT_LIMIT) { this.shortened = true; return }
    this.pendingPoints.push(point)
  }

  private hasWork(): boolean {
    return this.pendingPoints.length > 0 || this.pendingIncidents !== null || this.pendingOperations !== null || this.maintenanceDue !== null
  }

  private schedule(): void {
    if (this.draining || !this.hasWork()) return
    this.draining = this.drain().finally(() => {
      this.draining = null
      // Work queued between the drain's final check and this callback would
      // otherwise wait for the next snapshot.
      this.schedule()
    })
  }

  private async drain(): Promise<void> {
    await this.ready
    const step = async (work: () => Promise<void>): Promise<void> => { try { await work() } catch { this.degraded = true } }
    while (this.hasWork()) {
      const points = this.pendingPoints.splice(0)
      const incidents = this.pendingIncidents; this.pendingIncidents = null
      const operations = this.pendingOperations; this.pendingOperations = null
      const maintenance = this.maintenanceDue; this.maintenanceDue = null
      if (points.length) await step(() => this.appendPoints(points))
      if (incidents) await step(() => this.persistIncidents(incidents))
      if (operations !== null) await step(() => this.replaceBounded(join(this.runDir, 'operations.json'), operations, OPERATIONS_BUDGET))
      if (maintenance !== null) await step(() => this.maintain(maintenance))
    }
  }

  private async initialize(): Promise<void> {
    // Each step degrades on its own. A failed scratch cleanup or one unreadable
    // file used to abort the whole pass and leave the index partial, after
    // which retention treated every unindexed run as empty and deleted it.
    await mkdir(this.runDir, { recursive: true }).catch(() => { this.degraded = true })
    await rm(join(this.root, EXPORTS_DIR), { recursive: true, force: true }).catch(() => { this.degraded = true })
    try {
      await this.cleanupTemps()
      for (const run of await this.runNames()) {
        for (const resolution of TIERS) {
          const file = join(this.root, RUNS_DIR, run, `${resolution}.jsonl`)
          try {
            // Repair before indexing: a torn final append from a crashed helper
            // is expected crash residue, not corruption worth a degraded state.
            await this.repairTail(file)
            const size = await stat(file).then(value => value.size, () => null)
            if (size === null) continue
            const entry: FileStat = { run, resolution, points: 0, bytes: size, oldestAt: null, newestAt: null }
            const failure = { failed: false }
            for await (const line of this.lines(file, failure)) {
              const point = this.parseLine(line)
              if (point) this.notePoint(entry, point)
            }
            if (failure.failed) throw new Error('index-read-failed')
            this.index.set(file, entry)
          } catch {
            this.degraded = true
            this.unindexedRuns.add(run)
          }
        }
        const file = join(this.root, RUNS_DIR, run, 'incidents.json')
        const stored = await this.readIncidentFile(file)
        // Every retained run is repaired, not only the current one. A crash or
        // force-quit in ANY earlier run left its last capture as "capturing"
        // forever, and only a helper restart within the same run fixed it.
        const repaired = stored.map(incident => incident.state === 'capturing' ? { ...incident, state: 'interrupted' as const } : incident)
        if (repaired.some((incident, position) => incident !== stored[position])) {
          await this.replaceBounded(file, JSON.stringify(repaired), INCIDENT_BUDGET).catch(() => { this.degraded = true })
        }
        if (repaired.length) this.incidentRuns.set(run, repaired)
      }
      await this.enforceIncidentLimit()
      this.bytes = await this.diskBytes()
      await this.pruneRuns(DATA_BUDGET)
      this.indexed = true
    } catch { this.degraded = true }
  }

  private notePoint(entry: FileStat, point: MonitorHistoryPoint): void {
    entry.points++
    entry.oldestAt = entry.oldestAt === null ? point.at : Math.min(entry.oldestAt, point.at)
    entry.newestAt = entry.newestAt === null ? point.at : Math.max(entry.newestAt, point.at)
  }

  private async persistIncidents(current: MonitorIncident[]): Promise<void> {
    // A helper restart keeps the same canonical appRunId but constructs a new
    // IncidentEngine. Replacing the file with that engine's initially empty
    // list erased the pre-crash evidence. Merge by wall-time + run-local ID so
    // current captures can update in place while earlier generations survive.
    const existing = this.incidentRuns.get(this.runId) ?? []
    const merged = new Map(existing.map(incident => [`${incident.at}:${incident.id}`, incident]))
    for (const incident of current) merged.set(`${incident.at}:${incident.id}`, incident)
    const rows = [...merged.values()].sort((a, b) => a.at - b.at).slice(-INCIDENT_LIMIT)
    await this.replaceBounded(join(this.runDir, 'incidents.json'), JSON.stringify(rows), INCIDENT_BUDGET)
    this.incidentRuns.set(this.runId, rows)
    await this.enforceIncidentLimit()
  }

  private async appendPoints(points: MonitorHistoryPoint[]): Promise<void> {
    for (const resolution of TIERS) {
      const rows = points.filter(point => point.resolution === resolution)
      if (!rows.length) continue
      const lines = rows.map(point => `${JSON.stringify(point)}\n`).filter(line => {
        if (Buffer.byteLength(line) <= LINE_LIMIT) return true
        this.degraded = true
        return false
      })
      const value = lines.join('')
      const size = Buffer.byteLength(value)
      if (!size) continue
      if (this.bytes + size > DATA_BUDGET) await this.pruneRuns(DATA_BUDGET - size)
      if (this.bytes + size > DATA_BUDGET) { this.shortened = true; continue }
      const file = join(this.runDir, `${resolution}.jsonl`)
      await this.repairTail(file)
      try {
        await this.withDirectory(file, () => appendFile(file, value, { encoding: 'utf8', mode: 0o600 }))
      } catch (error) {
        // ENOSPC/EIO can leave part of a line on disk. Forget that this tail
        // was verified so the next append truncates back to the last newline
        // instead of fusing a new record onto the fragment.
        this.repairedTails.delete(file)
        throw error
      }
      const entry = this.index.get(file) ?? { run: this.runId, resolution, points: 0, bytes: 0, oldestAt: null, newestAt: null }
      entry.bytes += size
      for (const point of rows) this.notePoint(entry, point)
      this.index.set(file, entry)
      this.bytes += size
    }
  }

  /** A helper killed mid-append can leave an unterminated JSON fragment. The
   * next append would fuse it with a valid line, corrupting both, and every
   * later read would report the file as degraded. Truncate to the last newline
   * once, before this process first appends to the file. */
  private async repairTail(file: string): Promise<void> {
    if (this.repairedTails.has(file)) return
    this.repairedTails.add(file)
    const handle = await open(file, 'r+').catch(() => null)
    if (!handle) return
    try {
      const size = (await handle.stat()).size
      let end = size
      while (end > 0) {
        const length = Math.min(64 * 1024, end)
        const buffer = Buffer.alloc(length)
        await handle.read(buffer, 0, length, end - length)
        if (end === size && buffer[length - 1] === 0x0a) return
        const newline = buffer.lastIndexOf(0x0a)
        if (newline >= 0) { end = end - length + newline + 1; break }
        end -= length
      }
      await handle.truncate(end)
      const entry = this.index.get(file)
      if (entry) entry.bytes = end
      this.bytes = Math.max(0, this.bytes - (size - end))
    } finally { await handle.close().catch(() => {}) }
  }

  /** Recreate a run directory removed underneath the running helper (a Clear
   * History that failed after deleting it, or a user removing the folder).
   * Only startup and a successful clear created it, so every later write
   * failed with ENOENT until the next launch. */
  private async withDirectory<T>(file: string, write: () => Promise<T>): Promise<T> {
    try {
      return await write()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await mkdir(dirname(file), { recursive: true })
      return await write()
    }
  }

  private async replaceBounded(file: string, value: string, limit: number): Promise<void> {
    const size = Buffer.byteLength(value)
    if (size > limit) { this.shortened = true; return }
    const old = await stat(file).then(result => result.size, () => 0)
    // Keep the operational set below 64 MiB so an atomic temporary copy plus
    // the live files can never cross the public 128 MiB hard ceiling.
    if (this.bytes - old + size * 2 > HARD_BUDGET || this.bytes - old + size > DATA_BUDGET) {
      await this.pruneRuns(Math.max(0, DATA_BUDGET - size))
    }
    if (this.bytes - old + size > DATA_BUDGET) { this.shortened = true; return }
    const temp = `${file}.${process.pid}.tmp`
    try {
      await this.withDirectory(temp, () => writeFile(temp, value, { encoding: 'utf8', mode: 0o600 }))
      await moveArtifact(temp, file)
    } finally { await rm(temp, { force: true }).catch(() => {}) }
    this.bytes = Math.max(0, this.bytes - old + size)
  }

  private async maintain(now: number): Promise<void> {
    for (const [file, entry] of [...this.index]) {
      const cutoff = now - RETENTION[entry.resolution]
      if (entry.newestAt === null || entry.newestAt < cutoff) {
        // Fully expired: delete instead of rewriting an empty file forever.
        await rm(file, { force: true })
        this.index.delete(file)
        this.repairedTails.delete(file)
        continue
      }
      if (entry.oldestAt === null || entry.oldestAt >= cutoff) continue
      // WHY a 25% threshold: the rolling 1 s tier always has a minute of
      // expired points at each pass, and rewriting ~900 lines per tier per
      // minute was constant disk work for no user-visible benefit. Points are
      // roughly uniform in time, so the expired share of the span estimates
      // the expired share of the file without reading it.
      const expired = (cutoff - entry.oldestAt) / Math.max(1, entry.newestAt - entry.oldestAt)
      if (expired >= 0.25) await this.compact(file, entry, cutoff)
    }
    const incidentCutoff = now - RETENTION['1m']
    for (const [run, rows] of [...this.incidentRuns]) {
      const kept = rows.filter(incident => incident.at >= incidentCutoff)
      if (kept.length !== rows.length) await this.writeRunIncidents(run, kept)
    }
    // Expired runs used to live until the byte budget forced them out. A run
    // with no remaining points or incidents holds only an unattributable
    // operations snapshot, so it is retention-expired, not capacity-pruned.
    if (this.indexed) for (const run of await this.runNames()) {
      if (run === this.runId || this.incidentRuns.has(run) || this.unindexedRuns.has(run) || [...this.index.values()].some(entry => entry.run === run)) continue
      await rm(join(this.root, RUNS_DIR, run), { recursive: true, force: true })
    }
    this.bytes = await this.diskBytes()
    await this.pruneRuns(DATA_BUDGET)
  }

  private async compact(file: string, entry: FileStat, cutoff: number): Promise<void> {
    const kept: string[] = []
    const next: FileStat = { ...entry, points: 0, oldestAt: null, newestAt: null }
    const failure = { failed: false }
    for await (const line of this.lines(file, failure)) {
      const point = this.parseLine(line)
      if (!point || point.at < cutoff) continue
      kept.push(JSON.stringify(point))
      this.notePoint(next, point)
    }
    // A read error mid-file yields only a prefix. Rewriting from it would
    // replace unexpired history with a truncated copy, so skip this pass.
    if (failure.failed) return
    if (!kept.length) {
      await rm(file, { force: true })
      this.index.delete(file)
      return
    }
    const value = `${kept.join('\n')}\n`
    await this.replaceBounded(file, value, DATA_BUDGET)
    next.bytes = Buffer.byteLength(value)
    this.index.set(file, next)
  }

  private async writeRunIncidents(run: string, rows: MonitorIncident[]): Promise<void> {
    const file = join(this.root, RUNS_DIR, run, 'incidents.json')
    if (rows.length) {
      await this.replaceBounded(file, JSON.stringify(rows), INCIDENT_BUDGET)
      this.incidentRuns.set(run, rows)
    } else {
      await rm(file, { force: true })
      this.incidentRuns.delete(run)
    }
  }

  /** Fifty incidents across all retained runs, newest first. */
  private async enforceIncidentLimit(): Promise<void> {
    const all = [...this.incidentRuns].flatMap(([run, rows]) => rows.map(incident => ({ run, incident })))
    if (all.length <= INCIDENT_LIMIT) return
    all.sort((a, b) => a.incident.at - b.incident.at)
    const evicted = new Set(all.slice(0, all.length - INCIDENT_LIMIT).map(row => row.incident))
    for (const [run, rows] of [...this.incidentRuns]) {
      const kept = rows.filter(incident => !evicted.has(incident))
      if (kept.length !== rows.length) await this.writeRunIncidents(run, kept)
    }
  }

  private incidentsIn(from: number, to: number): MonitorIncident[] {
    return [...this.incidentRuns.values()].flat()
      .filter(incident => incident.at >= from && incident.at <= to)
      .sort((a, b) => a.at - b.at).slice(-INCIDENT_LIMIT)
  }

  private parseLine(line: string): MonitorHistoryPoint | null {
    if (Buffer.byteLength(line) > LINE_LIMIT) { this.degraded = true; return null }
    try { const point = parseMonitorHistoryPoint(JSON.parse(line)); if (!point) this.degraded = true; return point }
    catch { this.degraded = true; return null }
  }

  private async *lines(file: string, failure?: { failed: boolean }): AsyncGenerator<string> {
    const input = createReadStream(file, { encoding: 'utf8' })
    input.on('error', () => { this.degraded = true; if (failure) failure.failed = true })
    try {
      const reader = createInterface({ input, crlfDelay: Infinity })
      for await (const line of reader) if (line) yield line
    } catch { this.degraded = true; if (failure) failure.failed = true }
  }

  /** Stored points in range, then the still-open rollup bucket for "now". */
  private async *points(resolution: MonitorHistoryResolution, from: number, to: number): AsyncGenerator<MonitorHistoryPoint> {
    const files = [...this.index].filter(([, entry]) => entry.resolution === resolution && entry.oldestAt !== null
      && entry.newestAt !== null && entry.oldestAt <= to && entry.newestAt >= from)
      .sort((a, b) => a[1].oldestAt! - b[1].oldestAt!)
    for (const [file] of files) {
      for await (const line of this.lines(file)) {
        const point = this.parseLine(line)
        if (point && point.at >= from && point.at <= to) yield point
      }
    }
    const open = this.rollups[resolution].peek()
    if (open && open.at >= from && open.at <= to) yield open
  }

  private coverage(resolution: MonitorHistoryResolution, from: number, to: number): number {
    let oldest = Infinity
    let newest = -Infinity
    for (const entry of this.index.values()) {
      if (entry.resolution !== resolution || entry.oldestAt === null || entry.newestAt === null) continue
      oldest = Math.min(oldest, entry.oldestAt); newest = Math.max(newest, entry.newestAt)
    }
    const open = this.rollups[resolution].peek()
    if (open) { oldest = Math.min(oldest, open.at); newest = Math.max(newest, open.at) }
    if (newest < from || oldest > to) return 0
    if (to <= from) return 1
    return Math.max(0, Math.min(newest, to) - Math.max(oldest, from)) / (to - from)
  }

  /** WHY by data age and coverage rather than duration alone: a 15-minute
   * report whose range began more than 15 minutes ago selected the 1 s tier,
   * whose points had already been compacted away, and exported nothing while
   * the 10 s tier still held the whole interval. Prefer the finest tier that
   * both retains the range start and covers nearly as much as the best tier. */
  private resolution(from: number, to: number): MonitorHistoryResolution {
    const now = this.now()
    const scored = TIERS.map(tier => ({ tier, eligible: now - from <= RETENTION[tier] + INTERVAL[tier], coverage: this.coverage(tier, from, to) }))
    const best = Math.max(...scored.map(row => row.coverage))
    if (best <= 0) return scored.find(row => row.eligible)?.tier ?? '1m'
    const good = scored.filter(row => row.coverage >= best * 0.9)
    return (good.find(row => row.eligible) ?? good[0]!).tier
  }

  private runsOverlapping(from: number, to: number): Array<{ name: string; oldestAt: number; newestAt: number }> {
    const spans = new Map<string, { name: string; oldestAt: number; newestAt: number }>()
    for (const entry of this.index.values()) {
      if (entry.oldestAt === null || entry.newestAt === null) continue
      const span = spans.get(entry.run) ?? { name: entry.run, oldestAt: entry.oldestAt, newestAt: entry.newestAt }
      span.oldestAt = Math.min(span.oldestAt, entry.oldestAt); span.newestAt = Math.max(span.newestAt, entry.newestAt)
      spans.set(entry.run, span)
    }
    const open = this.rollups['1s'].peek()
    if (open) {
      const span = spans.get(this.runId) ?? { name: this.runId, oldestAt: open.at, newestAt: open.at }
      span.oldestAt = Math.min(span.oldestAt, open.at); span.newestAt = Math.max(span.newestAt, open.at)
      spans.set(this.runId, span)
    }
    return [...spans.values()].filter(span => span.oldestAt <= to && span.newestAt >= from).sort((a, b) => a.oldestAt - b.oldestAt)
  }

  private async readOperations(run: string): Promise<string | null> {
    try {
      const file = join(this.root, RUNS_DIR, run, 'operations.json')
      if ((await stat(file)).size > OPERATIONS_BUDGET) return null
      const operations: unknown = JSON.parse(await readFile(file, 'utf8'))
      const parsed = parseMonitorSnapshot({ schemaVersion: 1, sampledAt: 0, main: null, windows: [], operations, recent: [], workerRss: 0 })
      return parsed ? JSON.stringify(parsed.operations) : null
    } catch { return null }
  }

  private async readIncidentFile(file: string): Promise<MonitorIncident[]> {
    try {
      if ((await stat(file)).size > INCIDENT_BUDGET) { this.degraded = true; return [] }
      const value: unknown = JSON.parse(await readFile(file, 'utf8'))
      if (!Array.isArray(value) || value.length > INCIDENT_LIMIT) { this.degraded = true; return [] }
      const parsed = value.map(parseMonitorIncident)
      if (parsed.some(incident => incident === null)) { this.degraded = true; return [] }
      return parsed as MonitorIncident[]
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.degraded = true
      return []
    }
  }

  private async runNames(): Promise<string[]> {
    const runs = await readdir(join(this.root, RUNS_DIR), { withFileTypes: true }).catch(() => [])
    return runs.filter(entry => entry.isDirectory()).map(entry => entry.name)
  }

  private async cleanupTemps(): Promise<void> {
    for (const run of await this.runNames()) {
      const dir = join(this.root, RUNS_DIR, run)
      for (const file of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        if (file.isFile() && file.name.endsWith('.tmp')) await rm(join(dir, file.name), { force: true }).catch(() => {})
      }
    }
  }

  private async runBytes(run: string): Promise<number> {
    const dir = join(this.root, RUNS_DIR, run)
    let total = 0
    for (const file of await readdir(dir, { withFileTypes: true }).catch(() => [])) if (file.isFile()) total += await stat(join(dir, file.name)).then(value => value.size, () => 0)
    return total
  }

  private async diskBytes(): Promise<number> {
    let total = 0
    for (const run of await this.runNames()) total += await this.runBytes(run)
    return total
  }

  private async pruneRuns(target: number): Promise<void> {
    let total = await this.diskBytes()
    // Oldest evidence first, by indexed newest point rather than directory
    // name: run IDs are opaque and must not be assumed to sort by time.
    const newest = (run: string): number => Math.max(-Infinity, ...[...this.index.values()].filter(entry => entry.run === run).map(entry => entry.newestAt ?? -Infinity),
      ...(this.incidentRuns.get(run) ?? []).map(incident => incident.at))
    const runs = (await this.runNames()).filter(run => run !== this.runId).sort((a, b) => newest(a) - newest(b) || a.localeCompare(b))
    for (const run of runs) {
      if (total <= target) break
      const size = await this.runBytes(run)
      await rm(join(this.root, RUNS_DIR, run), { recursive: true, force: true })
      for (const [file, entry] of [...this.index]) if (entry.run === run) { this.index.delete(file); this.repairedTails.delete(file) }
      this.incidentRuns.delete(run)
      this.unindexedRuns.delete(run)
      total = Math.max(0, total - size); this.shortened = true
    }
    this.bytes = total
  }
}
