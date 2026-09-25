import { createHash, randomUUID } from 'node:crypto'
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
/** Write `bytes` once, atomically, to `<prefix>-<digest>.json`; an existing
 *  copy counts only if its bytes match (a crash can leave a partial file under
 *  the final name). Same contract as src/main/storage/preserveInvalidBytes.ts
 *  (#1260), duplicated until both land, then consolidated. */
async function preserveBytes(prefix: string, bytes: string): Promise<string> {
  const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 16)
  let copy = `${prefix}-${digest}.json`
  const existing = await readFile(copy, 'utf8').catch(() => null)
  if (existing === bytes) return copy
  if (existing !== null) copy = `${prefix}-${digest}-${randomUUID()}.json`
  const temporary = `${copy}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' })
    await rename(temporary, copy)
  } finally {
    await unlink(temporary).catch(() => {})
  }
  return copy
}

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

  /**
   * Set while the live file holds data that no preserved copy protects: a
   * set-aside loop whose copy could not be written, or a malformed file that
   * could not be moved to its quarantine. Every write is refused until a read
   * succeeds, because the service answers a failed read by starting empty and
   * persisting at once (#1258 review A, steering q18), which would replace the
   * only copy.
   */
  private writesRefused: string | null = null

  read(): Promise<Record<string, GoalLoopState>> {
    return this.serialize(async () => {
      let source: string
      let valid: Record<string, GoalLoopState>
      let setAside = 0
      // Named in the warning (#1258 review B): a count alone left the user
      // hand-diffing the preserved copy to learn WHICH loop vanished.
      const setAsideIds: string[] = []
      try {
        if ((await stat(this.file)).size > MAX_FILE_BYTES) throw new Error('Goal Loop storage exceeds its size limit.')
        source = await readFile(this.file, 'utf8')
        const document = JSON.parse(source)
        const loops: unknown = document?.loops
        if (document?.version !== 1 || !loops || typeof loops !== 'object' || Array.isArray(loops)) {
          throw new Error(`Goal Loop storage is invalid; the original file has been moved to ${this.quarantineFile}.`)
        }
        // WHY one unreadable loop is set aside instead of failing the file
        // (#1248): a newer build's phase or reason, met after a downgrade,
        // used to move the WHOLE document aside, and the service's next write
        // made every other loop's loss permanent. A malformed container above
        // still moves aside and throws: nothing in it can be trusted as a loop.
        valid = {}
        for (const [sessionId, loop] of Object.entries(loops)) {
          if (validLoop(loop)) valid[sessionId] = loop
          else setAsideIds.push(sessionId)
        }
        setAside = setAsideIds.length
        // The limit counts READABLE loops (#1258 review A): 200 good loops and
        // one this build cannot read are not an untrustworthy document.
        if (Object.keys(valid).length > GOAL_LOOP_STORE_LIMIT) {
          throw new Error(`Goal Loop storage is invalid; the original file has been moved to ${this.quarantineFile}.`)
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          this.writesRefused = null
          return {}
        }
        // WHY move it aside instead of just throwing, as TldrStore does:
        // TldrStore keeps its promise because a failed load fails every later
        // write too, so nothing ever replaces the bad file. This store cannot
        // work that way — the service must start (it catches this error and
        // runs empty) and then rewrites the whole document on its very next
        // state change. If even the move fails, the file stays where it is and
        // writes are refused instead, so that rewrite cannot replace it.
        await rename(this.file, this.quarantineFile).catch(moveError => {
          this.writesRefused = `the unreadable file could not be moved to ${this.quarantineFile} (${String(moveError)})`
        })
        throw error
      }
      // Preservation runs OUTSIDE the catch above (#1258 review A): a failed
      // copy is not an unreadable document, and handling it as one moved the
      // live file away and let the service persist an empty map. The copy is
      // digest-named and atomic, never the `.corrupt` name, so it cannot
      // replace an older quarantine either.
      if (setAside > 0) {
        let copy: string
        try {
          copy = await preserveBytes(`${this.file}.invalid`, source)
        } catch (copyError) {
          this.writesRefused = `${setAside} unreadable loop(s) could not be preserved (${String(copyError)})`
          throw new Error(`Goal Loop storage has unreadable loops that could not be preserved; writes are refused until it is fixed: ${String(copyError)}`)
        }
        console.warn(`[goal-loop] set aside ${setAside} unreadable loop(s) (${setAsideIds.join(', ')}); original preserved at ${copy}`)
      }
      this.writesRefused = null
      return valid
    })
  }

  async write(states: Record<string, GoalLoopState>): Promise<void> {
    return this.serialize(async () => {
      if (this.writesRefused) throw new Error(`Goal Loop storage is protected: ${this.writesRefused}`)
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
