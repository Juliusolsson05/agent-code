import { appendFile, mkdir, open, readFile, readdir, rename, writeFile } from 'node:fs/promises'
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
//   <dir>/aliases.jsonl   `{f, t}` lines: agent key `f` is the same agent as `t`
//                         (#1302). Resolved at read time; see appendAliases.
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
  /** agentNameId, else tldrIdentity, else the session id, as known when the
   *  interval closed. A session-id key is provisional: aliases.jsonl can later
   *  join it to the identity (see appendAliases). */
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
  /** aliases.jsonl in memory, loaded on first use. */
  private aliases: Map<string, string> | null = null
  /** Files whose tail this process has checked or written (appendLines). */
  private readonly cleanTails = new Set<string>()
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
      await this.appendLines(join(this.dir, `${month}.jsonl`), lines)
    })
  }

  private async loadAliases(): Promise<Map<string, string>> {
    if (this.aliases) return this.aliases
    const aliases = new Map<string, string>()
    try {
      for (const line of parseJsonLines(await readFile(join(this.dir, 'aliases.jsonl'), 'utf8'))) {
        if (typeof line.f === 'string' && typeof line.t === 'string' && line.f && line.t && line.f !== line.t) {
          aliases.set(line.f, line.t)
        }
      }
    } catch {
      // No aliases yet.
    }
    this.aliases = aliases
    return aliases
  }

  /**
   * Record that agent key `from` is the same agent as `to` (#1302).
   *
   * WHY an alias rather than choosing the right key up front: an interval's
   * context is resolved at CLOSE time from the workspace projection, and the
   * projection reaches main only through the renderer's debounced autosave. A
   * replacement's successor can finish a turn (or the app can crash) before
   * its row is saved, so that interval is keyed by its bare session id, and
   * the log is append-only. Rows written before this key existed are keyed by
   * session id too. Once the projection shows which identity a session id
   * belongs to, this edge joins every interval ever written under it, at read
   * time. Rewriting the month files instead would put history at risk for a
   * summary concern.
   *
   * Idempotent and small: an edge is written once per (from, to), and there
   * is at most one per session id that ever had an identity.
   */
  appendAliases(edges: ReadonlyArray<readonly [string, string]>): Promise<void> {
    if (edges.length === 0) return Promise.resolve()
    return this.enqueue(async () => {
      const aliases = await this.loadAliases()
      const fresh = edges.filter(([from, to]) => from && to && from !== to && aliases.get(from) !== to)
      if (fresh.length === 0) return
      await mkdir(this.dir, { recursive: true })
      await this.appendLines(join(this.dir, 'aliases.jsonl'), fresh.map(([from, to]) => JSON.stringify({ f: from, t: to })))
      // Only after the append: the in-memory map is what later calls dedupe
      // against, so an edge set before a failed write would never be retried
      // (steering q63).
      for (const [from, to] of fresh) aliases.set(from, to)
    })
  }

  /**
   * Append whole lines, first ending a torn last line if a crash left one.
   *
   * WHY (#1342 review b and c): the readers skip a torn final line, but the
   * next append used to continue it, so the torn bytes and the first new
   * record parsed as one bad line and BOTH were lost. For aliases.jsonl that
   * silently un-joined an agent; the month files had the same flaw. Only the
   * first write to each file in a process can meet a torn tail, so the check
   * runs once per file.
   */
  private async appendLines(path: string, lines: readonly string[]): Promise<void> {
    let text = `${lines.join('\n')}\n`
    if (!this.cleanTails.has(path)) {
      try {
        const handle = await open(path, 'r')
        try {
          const { size } = await handle.stat()
          if (size > 0) {
            const last = Buffer.alloc(1)
            await handle.read(last, 0, 1, size - 1)
            if (last[0] !== 0x0a) text = `\n${text}`
          }
        } finally {
          await handle.close()
        }
      } catch {
        // No file yet: nothing to repair.
      }
    }
    await appendFile(path, text)
    this.cleanTails.add(path)
  }

  /**
   * One representative key per group of keys the aliases join.
   *
   * WHY groups rather than following each edge's direction (#1342 review b
   * and c): edges come from separate projections and can point both ways. A
   * session that got a name after the fact is the common case: `child ->
   * tldr-x` while names were off, then `tldr-x -> child` once the name
   * reconciler gave the pane its own session id as its name. Following
   * directions stopped at that cycle with a different answer per starting
   * key, splitting one agent in two. Every edge states "the same agent", so
   * the keys it connects form one group whatever the direction; the smallest
   * key represents the group, which only needs to be stable and shared.
   */
  private groupKeys(aliases: ReadonlyMap<string, string>): Map<string, string> {
    const parent = new Map<string, string>()
    const find = (key: string): string => {
      let root = key
      while (parent.has(root) && parent.get(root) !== root) root = parent.get(root)!
      // Path compression keeps repeated lookups flat.
      let current = key
      while (current !== root) {
        const next = parent.get(current)!
        parent.set(current, root)
        current = next
      }
      return root
    }
    for (const [from, to] of aliases) {
      if (!parent.has(from)) parent.set(from, from)
      if (!parent.has(to)) parent.set(to, to)
      const a = find(from)
      const b = find(to)
      if (a !== b) parent.set(a < b ? b : a, a < b ? a : b)
    }
    const representative = new Map<string, string>()
    for (const key of parent.keys()) representative.set(key, find(key))
    return representative
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
    const groups = this.groupKeys(await this.loadAliases())
    for (const name of await this.monthFiles()) {
      const month = name.slice(0, 7)
      if (month < firstMonth || month > lastMonth) continue
      const contexts = new Map<number, ActivityContext>()
      for (const line of parseJsonLines(await readFile(join(this.dir, name), 'utf8'))) {
        if (line.t === 'c' && isNumber(line.c)) {
          const context = parseContext(line)
          if (context) contexts.set(line.c, { ...context, agentKey: groups.get(context.agentKey) ?? context.agentKey })
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
