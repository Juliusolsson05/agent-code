import { describe, expect, it } from 'vitest'

import type { ActivityContext, RecordedInterval } from '@main/agentActivity/AgentActivityStore.js'
import { summarizeAgentActivity } from '@main/agentActivity/summarize.js'
import type { AgentActivityRange } from '@shared/agentActivity/summaryTypes.js'

// The Agent Analytics numbers (#964). Times are built from LOCAL dates so the
// day rows are the same in every time zone the suite runs in.

const HOUR = 3_600_000
const MINUTE = 60_000
const local = (day: number, hour: number, minute = 0): number => new Date(2026, 8, day, hour, minute).getTime()
const NOW = local(11, 12)

function ctx(overrides: Partial<ActivityContext> = {}): ActivityContext {
  return {
    agentKey: 'ada',
    label: 'Ada',
    role: 'user',
    provider: 'claude',
    tabId: 'tab-1',
    tabTitle: 'agent-code',
    repoRoot: '/dev/agent-code',
    cwd: '/dev/agent-code',
    ...overrides,
  }
}

const span = (context: ActivityContext, startedAt: number, endedAt: number): RecordedInterval => ({ context, startedAt, endedAt })

function summarize(
  intervals: RecordedInterval[],
  options: {
    range?: AgentActivityRange
    suspensions?: Array<{ suspendedAt: number; resumedAt: number }>
    openTabTitles?: string[]
    recordingSince?: number | null
  } = {},
) {
  return summarizeAgentActivity({
    intervals,
    range: options.range ?? '7d',
    now: NOW,
    suspensions: options.suspensions ?? [],
    openTabTitles: new Set(options.openTabTitles ?? ['agent-code']),
    recordingSince: options.recordingSince ?? null,
  })
}

const reviewer = ctx({ agentKey: 'reviewer', label: 'Reviewer', role: 'orchestration', provider: 'codex' })

describe('summarizeAgentActivity', () => {
  it('sums agent-hours across parallel agents and counts overlapping time once for wall-clock', () => {
    const summary = summarize([
      span(ctx(), local(10, 9), local(10, 11)),
      span(reviewer, local(10, 10), local(10, 12, 30)),
    ])

    expect(summary.totals).toEqual({ agentMs: 4.5 * HOUR, wallMs: 3.5 * HOUR, agents: { user: 1, orchestration: 1 } })
    const [project] = summary.projects
    expect(project).toMatchObject({ title: 'agent-code', open: true, agentMs: 4.5 * HOUR, wallMs: 3.5 * HOUR })
    expect(project.topAgents.map(agent => [agent.label, agent.agentMs, agent.role])).toEqual([
      ['Reviewer', 2.5 * HOUR, 'orchestration'],
      ['Ada', 2 * HOUR, 'user'],
    ])
  })

  it('never counts time the machine was asleep, in either figure', () => {
    const summary = summarize(
      [span(ctx(), local(10, 9), local(10, 11)), span(reviewer, local(10, 10), local(10, 12, 30))],
      { suspensions: [{ suspendedAt: local(10, 10, 30), resumedAt: local(10, 11, 30) }] },
    )
    expect(summary.totals.agentMs).toBe(3 * HOUR)
    expect(summary.totals.wallMs).toBe(2.5 * HOUR)
  })

  it('cuts intervals at the start of the range and drops ones entirely before it', () => {
    const summary = summarize(
      [span(ctx(), local(10, 9), local(10, 13)), span(ctx(), local(1, 9), local(1, 17))],
      { range: '24h' },
    )
    expect(summary.from).toBe(NOW - 24 * HOUR)
    expect(summary.totals.agentMs).toBe(HOUR)
  })

  it('groups by tab title with repositories and their worktrees beneath, and marks closed tabs', () => {
    const summary = summarize([
      span(ctx(), local(10, 9), local(10, 10)),
      // Another window's tab with the same title is the same project.
      span(ctx({ agentKey: 'grace', label: 'Grace', tabId: 'tab-other-window', cwd: '/dev/agent-code/.worktrees/fix' }), local(10, 9), local(10, 11)),
      span(ctx({ agentKey: 'lin', label: 'Lin', tabId: 'tab-3', tabTitle: 'bringdown', repoRoot: '/dev/bringdown', cwd: '/dev/bringdown' }), local(10, 9), local(10, 9, 30)),
      span(ctx({ agentKey: 'orphan', label: 'Orphan', tabId: null, tabTitle: null }), local(10, 9), local(10, 9, 10)),
    ])

    expect(summary.projects.map(project => [project.title, project.open, project.agentMs])).toEqual([
      ['agent-code', true, 3 * HOUR],
      ['bringdown', false, 30 * MINUTE],
      ['No tab', false, 10 * MINUTE],
    ])
    const [agentCode] = summary.projects
    expect(agentCode.agents).toEqual({ user: 2, orchestration: 0 })
    expect(agentCode.repositories).toHaveLength(1)
    expect(agentCode.repositories[0].worktrees.map(worktree => [worktree.label, worktree.agentMs])).toEqual([
      ['fix', 2 * HOUR],
      ['agent-code', HOUR],
    ])
  })

  it("shows an agent under its latest label when it was renamed during the range", () => {
    const summary = summarize([
      span(ctx({ label: 'Old name' }), local(10, 9), local(10, 10)),
      span(ctx({ label: 'New name' }), local(10, 10, 30), local(10, 11)),
    ])
    expect(summary.projects[0].topAgents).toEqual([
      expect.objectContaining({ label: 'New name', agentMs: 1.5 * HOUR }),
    ])
  })

  it('splits work across local midnight and gives every day in the range a row', () => {
    const summary = summarize([span(ctx(), local(10, 23), local(11, 1))])

    expect(summary.days).toHaveLength(8)
    expect(summary.days[0].date).toBe('2026-09-04')
    expect(summary.days.at(-1)?.date).toBe('2026-09-11')
    expect(summary.days.find(day => day.date === '2026-09-10')?.agentMs).toBe(HOUR)
    expect(summary.days.find(day => day.date === '2026-09-11')?.agentMs).toBe(HOUR)
    expect(summary.days.find(day => day.date === '2026-09-05')?.agentMs).toBe(0)
  })

  it('reads all time from the first recorded moment', () => {
    const recordingSince = local(1, 9)
    const summary = summarize([span(ctx(), local(1, 9), local(1, 10))], { range: 'all', recordingSince })
    expect(summary.from).toBe(recordingSince)
    expect(summary.recordingSince).toBe(recordingSince)
    expect(summary.totals.agentMs).toBe(HOUR)
  })
})
