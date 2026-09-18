import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { GoalLoopState } from '@shared/types/goalLoop.js'

const MAX_FILE_BYTES = 8 * 1024 * 1024
export const GOAL_LOOP_STORE_LIMIT = 200

const PHASES = new Set(['active', 'paused', 'ended'])
const PAUSE_REASONS = new Set(['cap', 'error', 'user', 'interrupted'])
const END_REASONS = new Set(['done', 'blocked', 'cancelled'])

function iso(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function validLoop(raw: unknown): raw is GoalLoopState {
  const loop = raw as GoalLoopState
  return Boolean(loop) && typeof loop.sessionId === 'string' && loop.sessionId.length > 0
    && typeof loop.goal === 'string' && typeof loop.loopPrompt === 'string'
    && typeof loop.phase === 'string' && PHASES.has(loop.phase)
    && (loop.pauseReason === null || (typeof loop.pauseReason === 'string' && PAUSE_REASONS.has(loop.pauseReason)))
    && (loop.endReason === null || (typeof loop.endReason === 'string' && END_REASONS.has(loop.endReason)))
    && (loop.completionSummary === null || typeof loop.completionSummary === 'string')
    && Number.isSafeInteger(loop.maxContinuations) && loop.maxContinuations >= 1
    && Number.isSafeInteger(loop.continuationsDelivered) && loop.continuationsDelivered >= 0
    && Number.isSafeInteger(loop.consecutiveDeliveryFailures) && loop.consecutiveDeliveryFailures >= 0
    && iso(loop.startedAt) && iso(loop.updatedAt)
}

/** WHY a whole-file atomic rewrite instead of TldrStore's per-identity files:
 * at most one loop exists per session and the service rewrites on every state
 * change, so the document stays tiny; per-identity files would add eviction
 * machinery for a map the service already bounds (ended loops beyond
 * GOAL_LOOP_STORE_LIMIT are dropped before writing). Corrupt storage is
 * never silently reset — read() moves it aside (see there for why that, and
 * not TldrStore's refuse-to-write, is how this store keeps that promise).
 *
 * WHY no EventEmitter here: the service owns eventing and validation; the
 * store stays a dumb durable map so there is exactly one place that decides
 * what a "changed" loop means. */
export class GoalLoopStore {
  private tail: Promise<unknown> = Promise.resolve()
  constructor(private readonly file: string) {}

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation)
    this.tail = result.catch(() => {})
    return result
  }

  /** Where unreadable storage is moved. One fixed name, newest wins: the
   * point is that the bytes survive for a human to look at, not an archive,
   * and a timestamped name would be an unbounded directory of its own. */
  get quarantineFile(): string { return `${this.file}.corrupt` }

  read(): Promise<Record<string, GoalLoopState>> {
    return this.serialize(async () => {
      try {
        if ((await stat(this.file)).size > MAX_FILE_BYTES) throw new Error('Goal Loop storage exceeds its size limit.')
        const document = JSON.parse(await readFile(this.file, 'utf8'))
        const loops: unknown = document?.loops
        if (document?.version !== 1 || !loops || typeof loops !== 'object' || Array.isArray(loops)
          || Object.keys(loops).length > GOAL_LOOP_STORE_LIMIT
          || !Object.values(loops).every(validLoop)) {
          throw new Error(`Goal Loop storage is invalid; the original file has been moved to ${this.quarantineFile}.`)
        }
        return loops as Record<string, GoalLoopState>
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
        // WHY move it aside instead of just throwing, as TldrStore does:
        // TldrStore keeps its promise because a failed load fails every later
        // write too, so nothing ever replaces the bad file. This store cannot
        // work that way — the service must start (it catches this error and
        // runs empty) and then rewrites the whole document on its very next
        // state change. The first version threw "the original file has been
        // preserved" and start() overwrote that file a few lines later.
        // Best-effort: if the rename itself fails there is nothing better to
        // do, and the caller still learns the read failed.
        await rename(this.file, this.quarantineFile).catch(() => {})
        throw error
      }
    })
  }

  async write(states: Record<string, GoalLoopState>): Promise<void> {
    return this.serialize(async () => {
      const temporary = `${this.file}.${randomUUID()}.tmp`
      await mkdir(dirname(this.file), { recursive: true })
      try {
        await writeFile(temporary, JSON.stringify({ version: 1, loops: states }), { mode: 0o600, flag: 'wx' })
        await rename(temporary, this.file)
      } finally {
        await unlink(temporary).catch(() => {})
      }
    })
  }
}
