import { appendFile, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { SystemSuspension } from '@shared/types/systemSuspension.js'

// Durable agent working-time history (#964, decomposition Stage 4).
//
// Kept forever by decision (§6 Q8), so the format is built to stay small:
//
//   <dir>/YYYY-MM.jsonl   one month of closed working intervals. The agent's
//                         context (who, which tab, which repository) is written
//                         ONCE per distinct context as a `c` line; each interval
//                         is a short `i` line pointing at it. A heavy day of a few
//                         hundred turns is a few tens of kilobytes.
//   <dir>/suspensions.jsonl  machine suspensions, subtracted at summary time.
//   <dir>/open.json       intervals still open, rewritten on change and touched
//                         periodically, so a crash loses at most one touch period.
//
// WHY intervals are stored as observed and suspensions separately: the summary
// subtracts sleep with the same rule as the in-feed counter (workingSeconds.ts).
// Baking the subtraction in at record time would freeze today's sleep detection
// into history forever.
//
// WHY months are keyed by UTC: the file an interval lands in only has to be
// deterministic; reads widen by one month so an interval that starts near a
// boundary is never missed. Local calendar days are a summary concern.
//
// No prompt text or agent output is ever written — only labels the user already
// sees on screen, paths and timestamps.

export type ActivityContext = {
  /** agentNameId when names are on, else the session id. */
  agentKey: string
  label: string
  role: 'user' | 'orchestration'
  provider: string
  tabId: string | null
  tabTitle: string | null
  repoRoot: string
  cwd: string
}

export type RecordedInterval = {
  context: ActivityContext
  startedAt: number
  endedAt: number
}

export type OpenInterval = {
  sessionId: string
  context: ActivityContext
  startedAt: number
}

type ContextLine = { t: 'c'; c: number } & ActivityContext
type IntervalLine = { t: 'i'; c: number; s: number; e: number }

const MONTH_FILE = /^(\d{4})-(\d{2})\.jsonl$/

function monthKey(ms: number): string {
  const date = new Date(ms)
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
}

function contextKey(context: ActivityContext): string {
  return JSON.stringify([
    context.agentKey, context.label, context.role, context.provider,
    context.tabId, context.tabTitle, context.repoRoot, context.cwd,
  ])
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function parseContext(line: Record<string, unknown>): ActivityContext | null {
  if (typeof line.agentKey !== 'string' || typeof line.label !== 'string') return null
  if (line.role !== 'user' && line.role !== 'orchestration') return null
  return {
    agentKey: line.agentKey,
    label: line.label,
    role: line.role,
    provider: typeof line.provider === 'string' ? line.provider : 'unknown',
    tabId: typeof line.tabId === 'string' ? line.tabId : null,
    tabTitle: typeof line.tabTitle === 'string' ? line.tabTitle : null,
    repoRoot: typeof line.repoRoot === 'string' ? line.repoRoot : '',
    cwd: typeof line.cwd === 'string' ? line.cwd : '',
  }
}

function parseJsonLines(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue
    try {
      const value: unknown = JSON.parse(raw)
      if (value && typeof value === 'object') out.push(value as Record<string, unknown>)
    } catch {
      // A torn final line after a crash is expected in an append-only file; skip
      // it rather than losing the month.
    }
  }
  return out
}

export class AgentActivityStore {
  private tail: Promise<void> = Promise.resolve()
  /** Context ids already written to each month file this process has touched. */
  private readonly monthContexts = new Map<string, Map<string, number>>()

  constructor(private readonly dir: string) {}

  /** Serialize every write: two closes in the same tick must not interleave a
   *  context line and an interval line that points at it. */
  private enqueue(work: () => Promise<void>): Promise<void> {
    const run = this.tail.then(work)
    this.tail = run.catch(error => {
      console.warn('[agent-activity] write failed:', error)
    })
    return run
  }

  private async contextsFor(month: string): Promise<Map<string, number>> {
    const known = this.monthContexts.get(month)
    if (known) return known
    const ids = new Map<string, number>()
    try {
      for (const line of parseJsonLines(await readFile(join(this.dir, `${month}.jsonl`), 'utf8'))) {
        if (line.t !== 'c' || !isNumber(line.c)) continue
        const context = parseContext(line)
        if (context) ids.set(contextKey(context), line.c)
      }
    } catch {
      // No file yet for this month.
    }
    this.monthContexts.set(month, ids)
    return ids
  }

  appendInterval(interval: RecordedInterval): Promise<void> {
    if (!(interval.endedAt > interval.startedAt)) return Promise.resolve()
    return this.enqueue(async () => {
      await mkdir(this.dir, { recursive: true })
      const month = monthKey(interval.startedAt)
      const ids = await this.contextsFor(month)
      const key = contextKey(interval.context)
      const lines: string[] = []
      let id = ids.get(key)
      if (id === undefined) {
        id = ids.size + 1
        ids.set(key, id)
        const contextLine: ContextLine = { t: 'c', c: id, ...interval.context }
        lines.push(JSON.stringify(contextLine))
      }
      const intervalLine: IntervalLine = { t: 'i', c: id, s: interval.startedAt, e: interval.endedAt }
      lines.push(JSON.stringify(intervalLine))
      await appendFile(join(this.dir, `${month}.jsonl`), `${lines.join('\n')}\n`)
    })
  }

  appendSuspension(suspension: SystemSuspension): Promise<void> {
    return this.enqueue(async () => {
      await mkdir(this.dir, { recursive: true })
      await appendFile(
        join(this.dir, 'suspensions.jsonl'),
        `${JSON.stringify({ s: suspension.suspendedAt, r: suspension.resumedAt })}\n`,
      )
    })
  }

  /** Replace the open-interval file atomically (write + rename), so a crash mid
   *  write leaves the previous version rather than a truncated one. */
  writeOpen(open: readonly OpenInterval[], aliveAt: number): Promise<void> {
    return this.enqueue(async () => {
      await mkdir(this.dir, { recursive: true })
      const path = join(this.dir, 'open.json')
      const temp = `${path}.${process.pid}.tmp`
      await writeFile(temp, JSON.stringify({ aliveAt, open }))
      await rename(temp, path)
    })
  }

  /** Close every interval a previous run left open at that run's last touch.
   *  An unclean shutdown therefore contributes at most one touch period of time
   *  that was not observed, never the hours until the next launch. */
  async recoverOpenIntervals(now: number): Promise<number> {
    let recovered = 0
    try {
      const json: unknown = JSON.parse(await readFile(join(this.dir, 'open.json'), 'utf8'))
      const record = json && typeof json === 'object' ? (json as Record<string, unknown>) : {}
      const aliveAt = isNumber(record.aliveAt) ? record.aliveAt : null
      for (const raw of Array.isArray(record.open) ? record.open : []) {
        if (!raw || typeof raw !== 'object') continue
        const entry = raw as Record<string, unknown>
        const context = entry.context && typeof entry.context === 'object'
          ? parseContext(entry.context as Record<string, unknown>)
          : null
        if (!context || !isNumber(entry.startedAt) || aliveAt === null) continue
        if (aliveAt > entry.startedAt) {
          await this.appendInterval({ context, startedAt: entry.startedAt, endedAt: aliveAt })
          recovered += 1
        }
      }
    } catch {
      // No open file: a clean first run.
    }
    await this.writeOpen([], now)
    return recovered
  }

  private async monthFiles(): Promise<string[]> {
    try {
      return (await readdir(this.dir)).filter(name => MONTH_FILE.test(name)).sort()
    } catch {
      return []
    }
  }

  /** Intervals that overlap [from, to). */
  async readIntervals(from: number, to: number): Promise<RecordedInterval[]> {
    await this.tail
    // One extra month before `from`: an interval is filed under its START month.
    const firstMonth = monthKey(Date.UTC(new Date(from).getUTCFullYear(), new Date(from).getUTCMonth() - 1, 1))
    const lastMonth = monthKey(to)
    const out: RecordedInterval[] = []
    for (const name of await this.monthFiles()) {
      const month = name.slice(0, 7)
      if (month < firstMonth || month > lastMonth) continue
      const contexts = new Map<number, ActivityContext>()
      for (const line of parseJsonLines(await readFile(join(this.dir, name), 'utf8'))) {
        if (line.t === 'c' && isNumber(line.c)) {
          const context = parseContext(line)
          if (context) contexts.set(line.c, context)
        } else if (line.t === 'i' && isNumber(line.c) && isNumber(line.s) && isNumber(line.e)) {
          const context = contexts.get(line.c)
          if (context && line.e > from && line.s < to) out.push({ context, startedAt: line.s, endedAt: line.e })
        }
      }
    }
    return out
  }

  async readSuspensions(): Promise<Array<Pick<SystemSuspension, 'suspendedAt' | 'resumedAt'>>> {
    await this.tail
    try {
      return parseJsonLines(await readFile(join(this.dir, 'suspensions.jsonl'), 'utf8'))
        .filter(line => isNumber(line.s) && isNumber(line.r) && (line.r as number) > (line.s as number))
        .map(line => ({ suspendedAt: line.s as number, resumedAt: line.r as number }))
    } catch {
      return []
    }
  }

  /** Start of the earliest recorded interval, or null if nothing was recorded. */
  async firstRecordedAt(): Promise<number | null> {
    await this.tail
    const [first] = await this.monthFiles()
    if (!first) return null
    let earliest: number | null = null
    for (const line of parseJsonLines(await readFile(join(this.dir, first), 'utf8'))) {
      if (line.t === 'i' && isNumber(line.s) && (earliest === null || line.s < earliest)) earliest = line.s
    }
    return earliest
  }
}
