import { basename } from 'node:path'

import type {
  AgentActivityAgentRow,
  AgentActivityDay,
  AgentActivityProjectRow,
  AgentActivityRange,
  AgentActivityRepositoryRow,
  AgentActivitySummary,
  AgentActivityWorktreeRow,
  AgentCounts,
} from '@shared/agentActivity/summaryTypes.js'
import { suspendedMsWithin } from '@shared/agentActivity/workingSeconds.js'
import type { SystemSuspension } from '@shared/types/systemSuspension.js'

import type { ActivityContext, RecordedInterval } from './AgentActivityStore.js'

// The Agent Analytics summary, as a pure function (#964, decomposition Stage 5).
//
// Two figures, both always computed (§6 Q3 "both is kind of the point"):
//   agent-hours      the SUM of each agent's working time — three agents working
//                    for an hour count 3 h. It answers "how much agent work ran".
//   wall-clock hours the UNION of working time — the same hour counts once. It
//                    answers "how much of my day had agents running".
// Machine suspensions are subtracted from both with the counter's own rule.
//
// Projects are tabs grouped by title (§6 Q10 default), repositories and worktrees
// beneath, and each project names the agents that did the work — the founder's
// "what did my time go to".
//
// WHY one pure function owns grouping and overlap: presentation must not arbitrate
// them, and a pure function is exactly testable against recorded intervals.

const HOUR = 3_600_000
const DAY = 24 * HOUR
const RANGE_MS: Record<Exclude<AgentActivityRange, 'all'>, number> = {
  '24h': DAY,
  '7d': 7 * DAY,
  '30d': 30 * DAY,
}

const NO_TAB = 'No tab'

type Span = Pick<SystemSuspension, 'suspendedAt' | 'resumedAt'>
type Segment = { start: number; end: number; context: ActivityContext }

export function rangeBounds(
  range: AgentActivityRange,
  now: number,
  recordingSince: number | null,
): { from: number; to: number } {
  if (range === 'all') return { from: Math.min(recordingSince ?? now, now), to: now }
  return { from: now - RANGE_MS[range], to: now }
}

function workingMs(start: number, end: number, suspensions: readonly Span[]): number {
  return Math.max(0, end - start - suspendedMsWithin(suspensions, start, end))
}

function unionWorkingMs(segments: readonly { start: number; end: number }[], suspensions: readonly Span[]): number {
  const sorted = [...segments].sort((a, b) => a.start - b.start)
  let total = 0
  let current: { start: number; end: number } | null = null
  for (const segment of sorted) {
    if (current && segment.start <= current.end) {
      current.end = Math.max(current.end, segment.end)
      continue
    }
    if (current) total += workingMs(current.start, current.end, suspensions)
    current = { start: segment.start, end: segment.end }
  }
  if (current) total += workingMs(current.start, current.end, suspensions)
  return total
}

function localDayKey(ms: number): string {
  const date = new Date(ms)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function nextLocalMidnight(ms: number): number {
  const date = new Date(ms)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime()
}

/** A bucket collects the segments that belong to one row of the tree. */
class Bucket {
  readonly segments: Segment[] = []
  readonly agents = new Map<string, ActivityContext['role']>()
  agentMs = 0

  add(segment: Segment, suspensions: readonly Span[]): void {
    const ms = workingMs(segment.start, segment.end, suspensions)
    if (ms <= 0) return
    this.segments.push(segment)
    this.agentMs += ms
    this.agents.set(segment.context.agentKey, segment.context.role)
  }

  counts(): AgentCounts {
    let user = 0
    let orchestration = 0
    for (const role of this.agents.values()) {
      if (role === 'orchestration') orchestration += 1
      else user += 1
    }
    return { user, orchestration }
  }

  wallMs(suspensions: readonly Span[]): number {
    return unionWorkingMs(this.segments, suspensions)
  }
}

function getOrCreate<K, V>(map: Map<K, V>, key: K, create: () => V): V {
  let value = map.get(key)
  if (value === undefined) {
    value = create()
    map.set(key, value)
  }
  return value
}

function labelFor(path: string): string {
  return basename(path) || path || 'Unknown'
}

export function summarizeAgentActivity(input: {
  intervals: readonly RecordedInterval[]
  range: AgentActivityRange
  now: number
  suspensions: readonly Span[]
  openTabTitles: ReadonlySet<string>
  recordingSince: number | null
}): AgentActivitySummary {
  const { from, to } = rangeBounds(input.range, input.now, input.recordingSince)
  const suspensions = input.suspensions

  const totals = new Bucket()
  const projects = new Map<string, {
    bucket: Bucket
    repositories: Map<string, { bucket: Bucket; worktrees: Map<string, Bucket> }>
    agents: Map<string, { context: ActivityContext; ms: number }>
  }>()
  const days = new Map<string, Bucket>()

  for (const interval of input.intervals) {
    const start = Math.max(interval.startedAt, from)
    const end = Math.min(interval.endedAt, to)
    if (!(end > start)) continue
    const segment: Segment = { start, end, context: interval.context }
    const ms = workingMs(start, end, suspensions)
    if (ms <= 0) continue

    totals.add(segment, suspensions)

    const title = interval.context.tabTitle ?? NO_TAB
    const project = getOrCreate(projects, title, () => ({ bucket: new Bucket(), repositories: new Map(), agents: new Map() }))
    project.bucket.add(segment, suspensions)
    const repository = getOrCreate(project.repositories, interval.context.repoRoot, () => ({ bucket: new Bucket(), worktrees: new Map() }))
    repository.bucket.add(segment, suspensions)
    getOrCreate(repository.worktrees, interval.context.cwd, () => new Bucket()).add(segment, suspensions)
    const agent = getOrCreate(project.agents, interval.context.agentKey, () => ({ context: interval.context, ms: 0 }))
    agent.ms += ms
    // The latest recorded label wins: a pane renamed mid-range shows its current name.
    agent.context = interval.context

    // Split across local midnights so each calendar day gets its own share.
    for (let cursor = start; cursor < end;) {
      const boundary = Math.min(nextLocalMidnight(cursor), end)
      getOrCreate(days, localDayKey(cursor), () => new Bucket()).add({ start: cursor, end: boundary, context: interval.context }, suspensions)
      cursor = boundary
    }
  }

  const projectRows: AgentActivityProjectRow[] = [...projects.entries()].map(([title, project]) => {
    const repositories: AgentActivityRepositoryRow[] = [...project.repositories.entries()].map(([repoRoot, repository]) => {
      const worktrees: AgentActivityWorktreeRow[] = [...repository.worktrees.entries()]
        .map(([cwd, bucket]) => ({ cwd, label: labelFor(cwd), agentMs: bucket.agentMs, agents: bucket.counts() }))
        .sort((a, b) => b.agentMs - a.agentMs)
      return {
        repoRoot,
        label: labelFor(repoRoot),
        agentMs: repository.bucket.agentMs,
        wallMs: repository.bucket.wallMs(suspensions),
        agents: repository.bucket.counts(),
        worktrees,
      }
    }).sort((a, b) => b.agentMs - a.agentMs)
    const topAgents: AgentActivityAgentRow[] = [...project.agents.values()]
      .map(({ context, ms }) => ({
        agentKey: context.agentKey,
        label: context.label,
        role: context.role,
        provider: context.provider,
        agentMs: ms,
      }))
      .sort((a, b) => b.agentMs - a.agentMs)
    return {
      projectKey: title,
      title,
      open: input.openTabTitles.has(title),
      agentMs: project.bucket.agentMs,
      wallMs: project.bucket.wallMs(suspensions),
      agents: project.bucket.counts(),
      repositories,
      topAgents,
    }
  }).sort((a, b) => b.agentMs - a.agentMs)

  // Every calendar day in the range gets a row, worked or not: a bar chart with
  // idle days squeezed out would put Monday next to Thursday and hide exactly the
  // gaps someone reviewing their week wants to see.
  for (let cursor = from; cursor < to; cursor = nextLocalMidnight(cursor)) {
    getOrCreate(days, localDayKey(cursor), () => new Bucket())
  }

  const dayRows: AgentActivityDay[] = [...days.entries()]
    .map(([date, bucket]) => ({ date, agentMs: bucket.agentMs, wallMs: bucket.wallMs(suspensions) }))
    .sort((a, b) => a.date.localeCompare(b.date))

  return {
    range: input.range,
    from,
    to,
    recordingSince: input.recordingSince,
    totals: { agentMs: totals.agentMs, wallMs: totals.wallMs(suspensions), agents: totals.counts() },
    projects: projectRows,
    days: dayRows,
  }
}
