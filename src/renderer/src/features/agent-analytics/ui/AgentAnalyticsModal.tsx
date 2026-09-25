import { useEffect, useRef, useState } from 'react'
import { Alert } from '@renderer/components/ui/alert'

import { Button } from '@renderer/components/ui/button'
import { BarChart } from '@renderer/components/charts/BarChart'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { sectionCycleTarget } from '@renderer/lib/sectionCycle'
import { formatAgentTime, formatDayLabel } from '@renderer/features/agent-analytics/model/formatAgentTime'
import type {
  AgentActivityDay,
  AgentActivityProjectRow,
  AgentActivityRange,
  AgentActivitySummary,
  AgentCounts,
} from '@shared/agentActivity/summaryTypes'

// Agent Analytics (#964): where the agents' working time went.
//
// Purpose, in the user's words: "me as a founder to see what I have spent time on,
// so that I can make sure I do not waste any of my time." Every section therefore
// answers "what did the time go to": which tab (project), which repository and
// worktree, and which agents — by the name the user knows them by.
//
// WHY this component only paints: main computes the whole summary (intervals,
// sleep subtraction, grouping by tab title, agent-hours vs wall-clock). A window
// that re-derived any of it would disagree with another window about the same
// data, so the view never adds, merges or filters rows itself.

type Props = {
  open: boolean
  onClose: () => void
}

const RANGES: ReadonlyArray<{ id: AgentActivityRange; label: string }> = [
  { id: '24h', label: '24 hours' },
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
  { id: 'all', label: 'All Time' },
]

function totalAgents(counts: AgentCounts): number {
  return counts.user + counts.orchestration
}

function agentsBreakdown(counts: AgentCounts): string {
  const parts = [`${counts.user} yours`]
  if (counts.orchestration > 0) parts.push(`${counts.orchestration} orchestration`)
  return parts.join(' · ')
}

function Stat({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="rounded-slab border border-border bg-surface px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-muted">{label}</div>
      {/* The one stat size (UI pass, G-17): 18px semibold tabular, shared
          with Performance's health tiles and Dictation's history stats,
          which were 20px and 15px for the same "big number" idea. */}
      <div className="mt-1 text-[18px] font-semibold tabular-nums text-ink">{value}</div>
      {detail ? <div className="mt-0.5 text-[10px] text-muted">{detail}</div> : null}
    </div>
  )
}

const DAY_SERIES = [
  { id: 'agent', label: 'Agent-hours', colorClass: 'text-accent' },
  { id: 'wall', label: 'Wall-clock', colorClass: 'text-info' },
]

function shortDay(date: string): string {
  // YYYY-MM-DD is a LOCAL calendar date. `new Date('2026-09-10')` would parse
  // it as UTC midnight and print the previous day west of Greenwich.
  const [year, month, day] = date.split('-').map(Number)
  return new Date(year!, month! - 1, day!).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/**
 * Agent-hours per day with wall-clock drawn inside each bar.
 *
 * WHY nested rather than side by side: agent-hours always contain their
 * wall-clock union (three agents in one hour = 3 h agent, 1 h wall), so one
 * bar shows both and the gap between them is the parallelism, which is the
 * part a founder cares about. Hover or arrow keys read both figures.
 */
function DayChart({ days }: { days: readonly AgentActivityDay[] }) {
  if (days.length === 0) return null
  return (
    <section className="rounded-slab border border-border bg-surface px-3 pb-1 pt-2" aria-label="Working time per day">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-[12px] font-semibold text-ink">Working time per day</h2>
        <span className="flex items-center gap-3 text-[10px] text-muted">
          {DAY_SERIES.map(series => <span key={series.id} className="flex items-center gap-1"><span className={`inline-block size-2 rounded-full bg-current ${series.colorClass}`} />{series.label}</span>)}
        </span>
      </div>
      <BarChart
        label="Agent-hours and wall-clock per day"
        series={DAY_SERIES}
        bars={days.map(day => ({ key: day.date, heading: formatDayLabel(day.date), tick: shortDay(day.date), values: [day.agentMs, day.wallMs] }))}
        formatValue={value => (value === 0 ? '0' : formatAgentTime(value))}
      />
    </section>
  )
}

function ProjectRow({ project, totalMs }: { project: AgentActivityProjectRow; totalMs: number }) {
  // Collapsed by default: the per-project totals and agent names answer the
  // founder's question; repository and worktree detail is there on demand.
  const [expanded, setExpanded] = useState(false)
  return (
    <section className="rounded-slab border border-border bg-surface" aria-label={`Project ${project.title}`}>
      <button
        type="button"
        onClick={() => setExpanded(value => !value)}
        aria-expanded={expanded}
        className="flex w-full items-start justify-between gap-3 px-3 py-2 text-left outline-none hover:bg-row-hover-bg focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-focus-ring"
      >
        <div className="min-w-0">
          <div className="truncate text-[12px] font-semibold text-ink">
            {project.title}
            {project.open ? null : <span className="ml-2 text-[10px] font-normal text-muted">closed</span>}
          </div>
          <div className="mt-0.5 text-[10px] text-muted">
            {totalAgents(project.agents)} agents · {agentsBreakdown(project.agents)}
          </div>
          {/* Share of all agent-hours in the range: the ranking alone says
              which project was first, not whether it took 90% or 30%. */}
          <div className="mt-1.5 flex items-center gap-2" aria-label={`${Math.round(totalMs > 0 ? project.agentMs / totalMs * 100 : 0)}% of agent-hours`}>
            <span className="h-1.5 w-40 overflow-hidden rounded-full bg-surface-hi" aria-hidden="true">
              <span className="block h-full rounded-full bg-accent" style={{ width: `${Math.max(1, totalMs > 0 ? project.agentMs / totalMs * 100 : 0)}%` }} />
            </span>
            <span className="text-[10px] tabular-nums text-muted" aria-hidden="true">{Math.round(totalMs > 0 ? project.agentMs / totalMs * 100 : 0)}%</span>
          </div>
        </div>
        <div className="flex flex-shrink-0 gap-4 text-right tabular-nums">
          <div>
            <div className="text-[12px] text-ink">{formatAgentTime(project.agentMs)}</div>
            <div className="text-[10px] text-muted">agent-hours</div>
          </div>
          <div>
            <div className="text-[12px] text-ink">{formatAgentTime(project.wallMs)}</div>
            <div className="text-[10px] text-muted">wall-clock</div>
          </div>
        </div>
      </button>

      {project.topAgents.length > 0 ? (
        <ul className="border-t border-border px-3 py-2" aria-label={`Agents in ${project.title}`}>
          {project.topAgents.map(agent => (
            <li key={agent.agentKey} className="flex items-center justify-between gap-3 py-0.5 text-[11px]">
              <span className="min-w-0 truncate text-ink">
                {agent.label}
                <span className="ml-2 text-[10px] text-muted">
                  {agent.provider}{agent.role === 'orchestration' ? ' · orchestration' : ''}
                </span>
              </span>
              <span className="flex-shrink-0 tabular-nums text-ink-dim">{formatAgentTime(agent.agentMs)}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {expanded ? (
        <div className="border-t border-border px-3 py-2">
          {project.repositories.map(repository => (
            <div key={repository.repoRoot} className="py-1">
              <div className="flex items-center justify-between gap-3 text-[11px]">
                <span className="min-w-0 truncate text-ink" title={repository.repoRoot}>{repository.label}</span>
                <span className="flex-shrink-0 tabular-nums text-ink-dim">
                  {formatAgentTime(repository.agentMs)} agent-hours · {formatAgentTime(repository.wallMs)} wall-clock · {totalAgents(repository.agents)} agents
                </span>
              </div>
              <ul className="mt-0.5 pl-3">
                {repository.worktrees.map(worktree => (
                  <li key={worktree.cwd} className="flex items-center justify-between gap-3 text-[10px] text-muted">
                    <span className="min-w-0 truncate" title={worktree.cwd}>{worktree.label}</span>
                    <span className="flex-shrink-0 tabular-nums">
                      {formatAgentTime(worktree.agentMs)} · {totalAgents(worktree.agents)} agents
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  )
}

export function AgentAnalyticsModal({ open, onClose }: Props) {
  const [range, setRange] = useState<AgentActivityRange>('7d')
  const [summary, setSummary] = useState<AgentActivitySummary | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // WHY a request counter: switching 7 days → 30 days → All time quickly starts
  // three summaries, and the all-time one is the slowest. Only the newest request
  // may write state, or a late answer for a range the user already left would
  // overwrite the range they are looking at.
  const latestRequest = useRef(0)

  useEffect(() => {
    if (!open) return
    const request = ++latestRequest.current
    setLoading(true)
    setError(null)
    window.api.getAgentActivitySummary(range)
      .then(result => {
        if (latestRequest.current === request) setSummary(result)
      })
      .catch((err: unknown) => {
        if (latestRequest.current === request) {
          setError(err instanceof Error ? err.message : 'Could not load agent analytics.')
        }
      })
      .finally(() => {
        if (latestRequest.current === request) setLoading(false)
      })
  }, [open, range])

  const showing = summary?.range === range ? summary : null

  return (
    <Dialog
      open={open}
      onOpenChange={nextOpen => {
        if (!nextOpen) onClose()
      }}
    >
      <DialogContent
        size="xl"
        className="flex max-h-[86vh] flex-col"
        // No footer: the corner `× ⎋` is the exit (plan H5), replacing the
        // header's lowercase "close" button.
        showCloseButton
        onKeyDown={event => {
          // ⌘[ / ⌘] step through the time ranges from anywhere (plan D5).
          const index = RANGES.findIndex(option => option.id === range)
          const next = sectionCycleTarget(event, Math.max(0, index), RANGES.length)
          if (next === null) return
          event.preventDefault()
          setRange(RANGES[next]!.id)
        }}
      >
        <DialogHeader>
          <div>
            <DialogTitle>Agent Analytics</DialogTitle>
            <DialogDescription className="mt-0.5">
              Where your agents&apos; working time went. Time asleep and time waiting on you are not counted.
            </DialogDescription>
            {showing?.recordingSince != null ? (
              <div className="mt-1 text-[10px] text-muted">
                Recording since {new Date(showing.recordingSince).toLocaleDateString()}
              </div>
            ) : null}
          </div>
        </DialogHeader>

        <nav aria-label="Time range" className="flex flex-wrap gap-2 border-b border-border px-4 py-2">
          {RANGES.map(option => (
            <Button
              key={option.id}
              type="button"
              size="sm"
              variant={range === option.id ? 'default' : 'ghost'}
              aria-pressed={range === option.id}
              onClick={() => setRange(option.id)}
            >
              {option.label}
            </Button>
          ))}
        </nav>

        <div className="overflow-auto px-4 py-3">
          {error ? (
            <Alert className="mb-3">{error}</Alert>
          ) : null}

          {!showing ? (
            <p className="text-[11px] text-muted" role="status">{loading ? 'Loading…' : null}</p>
          ) : showing.projects.length === 0 ? (
            <div className="px-2 py-10 text-center text-[12px] text-muted" role="status">
              No agent working time recorded in this range.
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                <Stat label="Agent-hours" value={formatAgentTime(showing.totals.agentMs)} detail="summed across agents" />
                <Stat label="Wall-clock" value={formatAgentTime(showing.totals.wallMs)} detail="time any agent was working" />
                <Stat
                  label="Agents"
                  value={String(totalAgents(showing.totals.agents))}
                  detail={agentsBreakdown(showing.totals.agents)}
                />
                {/* Parallelism is the figure that explains the other two: 9 h
                    of agent time in 5 h of wall-clock means ~1.8 agents were
                    working at once on average. */}
                <Stat
                  label="Parallelism"
                  value={showing.totals.wallMs > 0 ? `${(showing.totals.agentMs / showing.totals.wallMs).toFixed(1)}×` : '—'}
                  detail="agents working at once, on average"
                />
              </div>
              <DayChart days={showing.days} />
              {showing.projects.map(project => (
                <ProjectRow key={project.projectKey} project={project} totalMs={showing.totals.agentMs} />
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
