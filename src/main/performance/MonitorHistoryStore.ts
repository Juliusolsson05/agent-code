import { createReadStream, createWriteStream } from 'node:fs'
import { appendFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
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

const RUNS_DIR = 'runs'
const DATA_BUDGET = 64 * 1024 * 1024
const HARD_BUDGET = 128 * 1024 * 1024
const INCIDENT_BUDGET = 8 * 1024 * 1024
const REPORT_BUDGET = 8 * 1024 * 1024
const LINE_LIMIT = 16 * 1024
// A valid point filled with MAX_SAFE_INTEGER values serializes to roughly 652
// bytes. Three hundred points leave more than 60 KiB inside the shared 256 KiB
// response ceiling for framing, status and fifty incident summaries.
const QUERY_POINT_LIMIT = MONITOR_POLICY.historyPagePoints
const RETENTION: Record<MonitorHistoryResolution, number> = {
  '1s': 15 * 60_000,
  '10s': 24 * 60 * 60_000,
  '1m': 7 * 24 * 60 * 60_000,
}
const INTERVAL: Record<MonitorHistoryResolution, number> = { '1s': 1000, '10s': 10_000, '1m': 60_000 }

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER

function pointFrom(snapshot: MonitorWorkerSnapshot, processes: MonitorProcessSummary | null, resolution: MonitorHistoryResolution, droppedRecords: number, restarts: number): MonitorHistoryPoint {
  const visible = snapshot.windows.filter(window => window.visibility === 'visible')
  return {
    schemaVersion: 1, at: snapshot.sampledAt, resolution,
    main: snapshot.main && {
      cpuPercent: snapshot.main.cpuPercent, rss: snapshot.main.rss, heapUsed: snapshot.main.heapUsed,
      heapLimit: snapshot.main.heapLimit, loopP99Ms: snapshot.main.loopP99Ms, loopMaxMs: snapshot.main.loopMaxMs,
      sleepGap: snapshot.main.sleepGap,
    },
    processes: processes && {
      cpuPercent: processes.cpuPercent, memoryBytes: processes.memoryBytes, count: processes.count,
      sessionCount: processes.sessionCount, quality: processes.quality,
    },
    windows: {
      count: snapshot.windows.length, visible: visible.length,
      maxLagMs: snapshot.windows.reduce((max, window) => Math.max(max, window.lagMs), 0),
      longTaskMs: snapshot.windows.reduce((sum, window) => sum + (window.longTasksSupported ? window.longTaskTotalMs : 0), 0),
      maxInputMs: snapshot.windows.reduce((max, window) => Math.max(max, window.inputSupported ? window.inputMaxMs : 0), 0),
    },
    workerRss: snapshot.workerRss, droppedRecords, restarts,
  }
}

/** Utility-process-owned durable history. The main and renderer paths only
 * exchange bounded records and query pages; slow disks cannot delay prompts,
 * input, painting, or the event-loop probe that diagnoses those paths. */
export class MonitorHistoryStore {
  private readonly runDir: string
  private queue: Promise<void> = Promise.resolve()
  private ready: Promise<void>
  private bytes = 0
  private points = 0
  private oldestAt: number | null = null
  private newestAt: number | null = null
  private incidentCount = 0
  private degraded = false
  private shortened = false
  private exporting = false
  private lastAt: Record<MonitorHistoryResolution, number> = { '1s': -Infinity, '10s': -Infinity, '1m': -Infinity }
  private lastMaintenanceAt = -Infinity
  private incidentFingerprint = ''
  private operationFingerprint = ''
  private storedIncidents: MonitorIncident[] = []

  constructor(private readonly root: string, private readonly runId: string, private readonly now: () => number = () => Date.now()) {
    this.runDir = join(root, RUNS_DIR, runId)
    this.ready = this.initialize()
    // Every append/query is ordered after startup pruning. Letting the first
    // record race initialization can undercount existing bytes and exceed the
    // disk ceiling before the first maintenance pass notices.
    this.queue = this.ready
  }

  status(): MonitorHistoryStatus {
    return {
      state: this.degraded ? 'degraded' : 'healthy', bytes: this.bytes,
      oldestAt: this.oldestAt, newestAt: this.newestAt, points: this.points,
      incidents: this.incidentCount, exporting: this.exporting, shortened: this.shortened,
    }
  }

  record(snapshot: MonitorWorkerSnapshot, processes: MonitorProcessSummary | null, incidents: MonitorIncident[], droppedRecords: number, restarts: number): void {
    const at = snapshot.sampledAt
    for (const resolution of ['1s', '10s', '1m'] as const) {
      if (at - this.lastAt[resolution] < INTERVAL[resolution]) continue
      this.lastAt[resolution] = at
      const point = pointFrom(snapshot, processes, resolution, droppedRecords, restarts)
      this.enqueue(async () => this.appendPoint(point))
    }
    const incidentJson = JSON.stringify(incidents.slice(-50))
    if (incidentJson !== this.incidentFingerprint) {
      this.incidentFingerprint = incidentJson
      this.enqueue(async () => this.persistIncidents(incidents))
    }
    const operationJson = JSON.stringify(snapshot.operations.slice(0, 100))
    if (operationJson !== this.operationFingerprint) {
      this.operationFingerprint = operationJson
      this.enqueue(async () => this.replaceBounded(join(this.runDir, 'operations.json'), operationJson, 1024 * 1024))
    }
    if (at - this.lastMaintenanceAt >= 60_000) {
      this.lastMaintenanceAt = at
      this.enqueue(async () => this.maintain(at))
    }
  }

  async query(from: number, to: number, cursor: string | undefined, limit: number): Promise<MonitorHistoryPage> {
    await this.settled()
    const resolution = this.resolution(from, to)
    const incidentSummaries = (await this.incidents(from, to)).map(({ evidence, ...summary }) => ({
      ...summary,
      evidenceCount: evidence.length,
    }))
    const skip = /^\d+$/.test(cursor ?? '') ? Math.min(1_000_000, Number(cursor)) : 0
    const overview = cursor === undefined && Math.floor(limit) >= 1000
    const boundedLimit = Math.max(1, Math.min(QUERY_POINT_LIMIT, Math.floor(limit)))
    if (overview) {
      // The timeline asks for the maximum bounded page because it needs an
      // overview, not raw backward pagination. Time buckets cover the entire
      // selected interval in one response, so "7 days" cannot silently become
      // "the latest 16 hours" when the minute tier contains 10,080 points.
      // Keeping the newest valid point in each bucket also preserves current
      // state while staying inside the stricter serialized response budget.
      const bucketMs = Math.max(INTERVAL[resolution], Math.ceil((to - from + 1) / boundedLimit))
      const buckets = new Map<number, MonitorHistoryPoint>()
      for (const file of await this.files(resolution)) {
        for await (const line of this.lines(file)) {
          const point = this.parseLine(line)
          if (!point || point.at < from || point.at > to) continue
          buckets.set(Math.floor((point.at - from) / bucketMs), point)
        }
      }
      const points = [...buckets.values()].sort((a, b) => a.at - b.at)
      return { resolution, from, to, points, incidents: incidentSummaries, nextCursor: null, complete: true, status: this.status() }
    }
    const ring: MonitorHistoryPoint[] = []
    let eligible = 0
    for (const file of await this.files(resolution)) {
      for await (const line of this.lines(file)) {
        const point = this.parseLine(line)
        if (!point || point.at < from || point.at > to) continue
        eligible++
        ring.push(point)
        if (ring.length > skip + boundedLimit) ring.shift()
      }
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
    return (await this.incidents(at, at)).find(incident => incident.id === id && incident.at === at) ?? null
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
    const tempDestination = `${destination}.agent-code-${process.pid}.tmp`
    try {
      await mkdir(dirname(destination), { recursive: true })
      // A process crash can strand this exact private scratch suffix. Remove
      // it before opening with `wx`; the user-selected destination remains
      // untouched until a complete report is atomically renamed over it.
      await rm(tempDestination, { force: true })
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
      const resolution = this.resolution(from, to)
      for (const file of await this.files(resolution)) for await (const line of this.lines(file)) {
        const point = this.parseLine(line)
        if (!point || point.at < from || point.at > to) continue
        await write(`${pointCount ? ',' : ''}${JSON.stringify(point)}`); pointCount++
      }
      await write('],"operations":')
      await write(await this.latestBoundedJson('operations.json', 1024 * 1024, '[]'))
      await write(',"incidents":[')
      const incidents = await this.incidents(from, to)
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
      await rename(tempDestination, destination)
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
    try {
      await rm(join(this.root, RUNS_DIR), { recursive: true, force: true })
      await mkdir(this.runDir, { recursive: true })
      this.bytes = 0; this.points = 0; this.oldestAt = null; this.newestAt = null; this.incidentCount = 0
      this.incidentFingerprint = ''; this.operationFingerprint = ''; this.storedIncidents = []; this.shortened = false
      this.lastAt = { '1s': -Infinity, '10s': -Infinity, '1m': -Infinity }
      this.lastMaintenanceAt = -Infinity
      this.degraded = false
    } catch { this.degraded = true }
    return this.status()
  }

  async settled(): Promise<void> { await this.ready; await this.queue }

  private enqueue(work: () => Promise<void>): void {
    this.queue = this.queue.then(work, work).catch(() => { this.degraded = true })
  }

  private async initialize(): Promise<void> {
    try {
      await mkdir(this.runDir, { recursive: true })
      await this.cleanupTemps()
      this.bytes = await this.diskBytes()
      await this.pruneRuns(DATA_BUDGET)
      for (const resolution of ['1s', '10s', '1m'] as const) for (const file of await this.files(resolution)) {
        for await (const line of this.lines(file)) {
          const point = this.parseLine(line)
          if (!point) continue
          this.points++
          this.oldestAt = this.oldestAt === null ? point.at : Math.min(this.oldestAt, point.at)
          this.newestAt = this.newestAt === null ? point.at : Math.max(this.newestAt, point.at)
        }
      }
      this.storedIncidents = await this.readIncidentFile(join(this.runDir, 'incidents.json'))
      const interrupted = this.storedIncidents.map(incident => incident.state === 'capturing'
        ? { ...incident, state: 'interrupted' as const }
        : incident)
      if (interrupted.some((incident, index) => incident !== this.storedIncidents[index])) {
        this.storedIncidents = interrupted
        await this.replaceBounded(join(this.runDir, 'incidents.json'), JSON.stringify(interrupted), INCIDENT_BUDGET)
      }
      this.incidentCount = (await this.incidents(0, Number.MAX_SAFE_INTEGER)).length
    } catch { this.degraded = true }
  }

  private async persistIncidents(current: MonitorIncident[]): Promise<void> {
    // A helper restart keeps the same canonical appRunId but constructs a new
    // IncidentEngine. Replacing the file with that engine's initially empty
    // list erased the pre-crash evidence. Merge by wall-time + run-local ID so
    // current captures can update in place while earlier generations survive.
    const merged = new Map(this.storedIncidents.map(incident => [`${incident.at}:${incident.id}`, incident]))
    for (const incident of current) merged.set(`${incident.at}:${incident.id}`, incident)
    this.storedIncidents = [...merged.values()].sort((a, b) => a.at - b.at).slice(-50)
    await this.replaceBounded(join(this.runDir, 'incidents.json'), JSON.stringify(this.storedIncidents), INCIDENT_BUDGET)
    this.incidentCount = (await this.incidents(0, Number.MAX_SAFE_INTEGER)).length
  }

  private async appendPoint(point: MonitorHistoryPoint): Promise<void> {
    const line = `${JSON.stringify(point)}\n`
    const size = Buffer.byteLength(line)
    if (size > LINE_LIMIT) { this.degraded = true; return }
    if (this.bytes + size > DATA_BUDGET) await this.pruneRuns(DATA_BUDGET - size)
    if (this.bytes + size > DATA_BUDGET) { this.shortened = true; return }
    await appendFile(join(this.runDir, `${point.resolution}.jsonl`), line, { encoding: 'utf8', mode: 0o600 })
    this.bytes += size; this.points++; this.oldestAt ??= point.at; this.newestAt = point.at
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
      await writeFile(temp, value, { encoding: 'utf8', mode: 0o600 })
      await rename(temp, file)
    } finally { await rm(temp, { force: true }).catch(() => {}) }
    this.bytes = Math.max(0, this.bytes - old + size)
  }

  private async maintain(now: number): Promise<void> {
    for (const resolution of ['1s', '10s', '1m'] as const) {
      for (const file of await this.files(resolution)) await this.compact(file, now - RETENTION[resolution])
    }
    await this.pruneIncidents()
    this.incidentCount = (await this.incidents(0, Number.MAX_SAFE_INTEGER)).length
    this.bytes = await this.diskBytes()
    await this.pruneRuns(DATA_BUDGET)
  }

  private async compact(file: string, cutoff: number): Promise<void> {
    const kept: string[] = []
    for await (const line of this.lines(file)) {
      const point = this.parseLine(line)
      if (point && point.at >= cutoff) kept.push(JSON.stringify(point))
    }
    const value = kept.length ? `${kept.join('\n')}\n` : ''
    await this.replaceBounded(file, value, DATA_BUDGET)
  }

  private parseLine(line: string): MonitorHistoryPoint | null {
    if (Buffer.byteLength(line) > LINE_LIMIT) { this.degraded = true; return null }
    try { const point = parseMonitorHistoryPoint(JSON.parse(line)); if (!point) this.degraded = true; return point }
    catch { this.degraded = true; return null }
  }

  private async *lines(file: string): AsyncGenerator<string> {
    const input = createReadStream(file, { encoding: 'utf8' })
    input.on('error', () => { this.degraded = true })
    try {
      const reader = createInterface({ input, crlfDelay: Infinity })
      for await (const line of reader) if (line) yield line
    } catch { this.degraded = true }
  }

  private resolution(from: number, to: number): MonitorHistoryResolution {
    const range = Math.max(0, to - from)
    return range <= RETENTION['1s'] ? '1s' : range <= RETENTION['10s'] ? '10s' : '1m'
  }

  private async files(resolution: MonitorHistoryResolution): Promise<string[]> {
    const runs = await readdir(join(this.root, RUNS_DIR), { withFileTypes: true }).catch(() => [])
    const candidates = runs.filter(entry => entry.isDirectory()).map(entry => join(this.root, RUNS_DIR, entry.name, `${resolution}.jsonl`)).sort()
    const exists = await Promise.all(candidates.map(file => stat(file).then(() => true, () => false)))
    return candidates.filter((_, index) => exists[index])
  }

  private async incidents(from: number, to: number): Promise<MonitorIncident[]> {
    const rows: MonitorIncident[] = []
    const runs = await readdir(join(this.root, RUNS_DIR), { withFileTypes: true }).catch(() => [])
    for (const entry of runs.filter(item => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = join(this.root, RUNS_DIR, entry.name, 'incidents.json')
      try {
        if ((await stat(file)).size > INCIDENT_BUDGET) { this.degraded = true; continue }
        const value: unknown = JSON.parse(await readFile(file, 'utf8'))
        if (!Array.isArray(value) || value.length > 50) { this.degraded = true; continue }
        for (const candidate of value) {
          const incident = parseMonitorIncident(candidate)
          if (incident && incident.at >= from && incident.at <= to) rows.push(incident)
        }
      } catch { /* Missing/corrupt prior runs become coverage gaps. */ }
    }
    return rows.sort((a, b) => a.at - b.at).slice(-50)
  }

  private async readIncidentFile(file: string): Promise<MonitorIncident[]> {
    try {
      if ((await stat(file)).size > INCIDENT_BUDGET) { this.degraded = true; return [] }
      const text = await readFile(file, 'utf8')
      const value: unknown = JSON.parse(text)
      if (!Array.isArray(value) || value.length > 50) { this.degraded = true; return [] }
      const parsed = value.map(parseMonitorIncident)
      if (parsed.some(incident => incident === null)) { this.degraded = true; return [] }
      return parsed as MonitorIncident[]
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.degraded = true
      return []
    }
  }

  private async latestBoundedJson(name: string, limit: number, fallback: string): Promise<string> {
    const runs = await readdir(join(this.root, RUNS_DIR), { withFileTypes: true }).catch(() => [])
    for (const entry of runs.filter(item => item.isDirectory()).sort((a, b) => b.name.localeCompare(a.name))) {
      try {
        const file = join(this.root, RUNS_DIR, entry.name, name)
        if ((await stat(file)).size > limit) continue
        const value = await readFile(file, 'utf8')
        const operations: unknown = JSON.parse(value)
        const parsed = parseMonitorSnapshot({ schemaVersion: 1, sampledAt: 0, main: null, windows: [], operations, recent: [], workerRss: 0 })
        if (parsed) return JSON.stringify(parsed.operations)
      } catch { /* Continue to an older valid run. */ }
    }
    return fallback
  }

  private async pruneIncidents(): Promise<void> {
    const runs = await readdir(join(this.root, RUNS_DIR), { withFileTypes: true }).catch(() => [])
    let remaining = 50
    for (const entry of runs.filter(item => item.isDirectory()).sort((a, b) => b.name.localeCompare(a.name))) {
      const file = join(this.root, RUNS_DIR, entry.name, 'incidents.json')
      let valid: MonitorIncident[] = []
      try {
        if ((await stat(file)).size > INCIDENT_BUDGET) { this.degraded = true; continue }
        const value: unknown = JSON.parse(await readFile(file, 'utf8'))
        if (Array.isArray(value) && value.length <= 50) valid = value.map(parseMonitorIncident).filter((row): row is MonitorIncident => row !== null)
      } catch { continue }
      const keep = remaining > 0 ? valid.slice(-remaining) : []
      remaining = Math.max(0, remaining - keep.length)
      if (keep.length !== valid.length) await this.replaceBounded(file, JSON.stringify(keep), INCIDENT_BUDGET)
    }
  }

  private async cleanupTemps(): Promise<void> {
    const runs = await readdir(join(this.root, RUNS_DIR), { withFileTypes: true }).catch(() => [])
    for (const entry of runs.filter(item => item.isDirectory())) {
      const dir = join(this.root, RUNS_DIR, entry.name)
      for (const file of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        if (file.isFile() && file.name.endsWith('.tmp')) await rm(join(dir, file.name), { force: true }).catch(() => {})
      }
    }
  }

  private async diskBytes(): Promise<number> {
    let total = 0
    const runs = await readdir(join(this.root, RUNS_DIR), { withFileTypes: true }).catch(() => [])
    for (const entry of runs.filter(item => item.isDirectory())) {
      const dir = join(this.root, RUNS_DIR, entry.name)
      for (const file of await readdir(dir, { withFileTypes: true }).catch(() => [])) if (file.isFile()) total += await stat(join(dir, file.name)).then(value => value.size, () => 0)
    }
    return total
  }

  private async pruneRuns(target: number): Promise<void> {
    let total = await this.diskBytes()
    const runs = await readdir(join(this.root, RUNS_DIR), { withFileTypes: true }).catch(() => [])
    for (const entry of runs.filter(item => item.isDirectory() && item.name !== this.runId).sort((a, b) => a.name.localeCompare(b.name))) {
      if (total <= target) break
      const dir = join(this.root, RUNS_DIR, entry.name)
      let size = 0
      for (const file of await readdir(dir, { withFileTypes: true }).catch(() => [])) if (file.isFile()) size += await stat(join(dir, file.name)).then(value => value.size, () => 0)
      await rm(dir, { recursive: true, force: true })
      total = Math.max(0, total - size); this.shortened = true
    }
    this.bytes = total
  }
}
