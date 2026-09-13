import { contentTracing } from 'electron'
import { Session as InspectorSession } from 'node:inspector'
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import type { MonitorTraceMode, MonitorTraceStatus } from '@shared/performance/monitorHistory.js'
import { MONITOR_POLICY } from '@shared/performance/monitorPolicy.js'
import { mainOperations } from './operations.js'
import { moveArtifact } from './moveArtifact.js'
import { PERFORMANCE_CAPTURE_TEMP_DIR } from '@main/storage/paths.js'
import type { OperationEnd } from '@shared/performance/operationTimers.js'

const TRACE_LIMIT = MONITOR_POLICY.traceBytes
const CHROMIUM_CATEGORIES = ['electron', 'toplevel', 'disabled-by-default-toplevel.flow', 'renderer.scheduler', 'cc', 'gpu', 'viz', 'input']
type Active = {
  ownerWindowId: number; mode: MonitorTraceMode; destination: string; temporary: string
  startedAt: number; startedMono: number; endsAt: number; timer: ReturnType<typeof setTimeout>
  inspector: InspectorSession | null; finishOperation: OperationEnd
}

const initial = (): MonitorTraceStatus => ({ state: 'idle', mode: null, ownerWindowId: null, startedAt: null, endsAt: null, path: null, bytes: null, truncated: false, message: null })

function post(session: InspectorSession, method: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => session.post(method, (error, result) => error ? reject(error) : resolve((result ?? {}) as Record<string, unknown>)))
}

/** Explicit, app-wide profiler ownership. Baseline monitoring never calls this
 * controller, and every start has a visible owner, a monotonic deadline and a
 * user-selected destination before expensive capture begins. */
export class PerformanceTraceController {
  private active: Active | null = null
  private current = initial()
  private cancelledOwners = new Set<number>()

  constructor(private readonly tempDir: string = PERFORMANCE_CAPTURE_TEMP_DIR) {}

  status(): MonitorTraceStatus { return { ...this.current } }

  async start(ownerWindowId: number, mode: MonitorTraceMode, destination: string, durationMs: number = MONITOR_POLICY.profileMs): Promise<MonitorTraceStatus> {
    if (this.active || this.current.state === 'starting' || this.current.state === 'stopping') return this.status()
    if (!Number.isSafeInteger(ownerWindowId) || ownerWindowId < 1 || !['chromium', 'main-cpu'].includes(mode)
      || !destination || destination.length > 4096) return { ...initial(), state: 'failed', message: 'Invalid recording request.' }
    const duration = Math.max(1000, Math.min(MONITOR_POLICY.maxProfileMs, Math.floor(durationMs)))
    const startedAt = Date.now()
    const startedMono = performance.now()
    // Scratch lives in the app-owned capture root (see paths.ts), never beside
    // the user's destination, so a quit or crash cannot strand it there.
    const temporary = join(this.tempDir, `${mode}-${process.pid}-${startedAt}.tmp`)
    const finishOperation = mainOperations.begin(mode === 'chromium' ? 'profile.chromium' : 'profile.main-cpu')
    this.cancelledOwners.delete(ownerWindowId)
    this.current = { state: 'starting', mode, ownerWindowId, startedAt, endsAt: startedAt + duration, path: null, bytes: null, truncated: false, message: null }
    let inspector: InspectorSession | null = null
    try {
      await mkdir(this.tempDir, { recursive: true, mode: 0o700 })
      if (mode === 'chromium') {
        const available = new Set(await contentTracing.getCategories())
        const included = CHROMIUM_CATEGORIES.filter(category => available.has(category))
        if (!included.length) throw new Error('Tracing categories are unavailable in this Electron build.')
        await contentTracing.startRecording({
          included_categories: included,
          enable_argument_filter: true,
          recording_mode: 'record-until-full',
          // Chromium defaults to 100 MiB, already above the product cap. A
          // 60 MiB source buffer leaves space for JSON framing while the final
          // artifact still receives an independent 64 MiB filesystem check.
          trace_buffer_size_in_kb: 60 * 1024,
        })
      } else {
        inspector = new InspectorSession()
        inspector.connect()
        await post(inspector, 'Profiler.enable')
        await post(inspector, 'Profiler.start')
      }
      const timer = setTimeout(() => { void this.stop(ownerWindowId, false) }, duration)
      timer.unref()
      this.active = { ownerWindowId, mode, destination, temporary, startedAt, startedMono, endsAt: startedMono + duration, timer, inspector, finishOperation }
      this.current = { ...this.current, state: 'recording' }
      if (this.cancelledOwners.delete(ownerWindowId)) await this.stop(ownerWindowId, true)
    } catch (error) {
      this.cancelledOwners.delete(ownerWindowId)
      try { inspector?.disconnect() } catch { /* Partial inspector starts are disposable. */ }
      finishOperation('error')
      this.current = { ...this.current, state: 'failed', message: error instanceof Error && error.message.startsWith('Tracing categories') ? error.message : 'Recording could not start in this build.' }
    }
    return this.status()
  }

  async stop(ownerWindowId: number, cancel: boolean): Promise<MonitorTraceStatus> {
    const active = this.active
    if (!active || active.ownerWindowId !== ownerWindowId) return this.status()
    this.active = null
    clearTimeout(active.timer)
    this.current = { ...this.current, state: 'stopping' }
    try {
      let artifact = active.temporary
      if (active.mode === 'chromium') {
        artifact = await contentTracing.stopRecording(active.temporary)
      } else {
        const result = await post(active.inspector!, 'Profiler.stop')
        active.inspector!.disconnect()
        // DevTools expects the CDP CPUProfile object at the document root.
        // Wrapping it in Agent Code metadata creates valid JSON that Chrome
        // cannot import, defeating the purpose of the explicit recording.
        const json = JSON.stringify(result.profile)
        if (Buffer.byteLength(json) > TRACE_LIMIT) throw new Error('trace-budget')
        await writeFile(active.temporary, json, { encoding: 'utf8', mode: 0o600 })
      }
      const size = await stat(artifact).then(value => value.size, () => 0)
      if (cancel) {
        await rm(artifact, { force: true })
        active.finishOperation('cancelled')
        this.current = { ...initial(), state: 'cancelled', mode: active.mode, ownerWindowId: active.ownerWindowId, message: 'Recording cancelled.' }
      } else if (size <= 0 || size > TRACE_LIMIT) {
        await rm(artifact, { force: true })
        active.finishOperation('error')
        this.current = { ...initial(), state: 'failed', mode: active.mode, ownerWindowId: active.ownerWindowId, bytes: size, truncated: size > TRACE_LIMIT, message: size > TRACE_LIMIT ? 'Recording exceeded the 64 MiB artifact limit and was removed.' : 'Recording produced no artifact.' }
      } else {
        await moveArtifact(artifact, active.destination)
        active.finishOperation()
        this.current = { ...initial(), state: 'complete', mode: active.mode, ownerWindowId: active.ownerWindowId, path: active.destination, bytes: size, message: 'Recording saved locally.' }
      }
    } catch (error) {
      try { active.inspector?.disconnect() } catch { /* Stop owns final cleanup. */ }
      await rm(active.temporary, { force: true }).catch(() => {})
      active.finishOperation(cancel ? 'cancelled' : 'error')
      this.current = { ...initial(), state: cancel ? 'cancelled' : 'failed', mode: active.mode, ownerWindowId: active.ownerWindowId,
        message: cancel ? 'Recording cancelled.' : error instanceof Error && error.message === 'trace-budget'
          ? 'Recording exceeded the 64 MiB artifact limit and was removed.' : 'Recording could not be saved.' }
    }
    return this.status()
  }

  async cancelOwner(ownerWindowId: number): Promise<void> {
    if (this.current.state === 'starting' && this.current.ownerWindowId === ownerWindowId) this.cancelledOwners.add(ownerWindowId)
    if (this.active?.ownerWindowId === ownerWindowId) await this.stop(ownerWindowId, true)
  }
  /** Startup cleanup for scratch left by a previous crash or forced quit. Runs
   * only while idle so it can never delete a capture this process is writing. */
  async sweep(): Promise<void> {
    if (this.active || this.current.state === 'starting' || this.current.state === 'stopping') return
    for (const entry of await readdir(this.tempDir, { withFileTypes: true }).catch(() => [])) {
      if (entry.isFile()) await rm(join(this.tempDir, entry.name), { force: true }).catch(() => {})
    }
  }
  async shutdown(): Promise<void> {
    // A tracing backend can still be inside its asynchronous start when quit
    // arrives. Remember the owner exactly like a closed window so completion
    // immediately tears the backend down instead of arming its full timer.
    if (this.current.state === 'starting' && this.current.ownerWindowId !== null) this.cancelledOwners.add(this.current.ownerWindowId)
    if (this.active) await this.stop(this.active.ownerWindowId, true)
  }
}

export const performanceTraceController = new PerformanceTraceController()
