import { useEffect, useRef, useState } from 'react'

import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
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
  { id: 'all', label: 'All time' },
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
      <div className="mt-1 text-[18px] font-semibold tabular-nums text-ink">{value}</div>
      {detail ? <div className="mt-0.5 text-[10px] text-muted">{detail}</div> : null}
    </div>
  )
}

/**
 * Agent-hours per day as plain SVG bars.
 *
 * WHY hand-rolled: there is no chart library in the app, and one bar series does
 * not justify adding one. Each bar carries a <title> so hovering names the day and
 * both hour figures without a tooltip component.
 */
function DayBars({ days }: { days: readonly AgentActivityDay[] }) {
  if (days.length === 0) return null
  const width = 600
  const height = 72
  const gap = 2
  const max = Math.max(...days.map(day => day.agentMs), 1)
  const barWidth = Math.max(1, width / days.length - gap)
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="h-[72px] w-full"
      role="img"
      aria-label="Agent-hours per day"
    >
      {days.map((day, index) => {
        const barHeight = Math.max(1, Math.round((day.agentMs / max) * (height - 4)))
        return (
          <rect
            key={day.date}
            x={index * (barWidth + gap)}
            y={height - barHeight}
            width={barWidth}
            height={barHeight}
            className="fill-accent"
            rx={1}
          >
            <title>
              {`${formatDayLabel(day.date)}: ${formatAgentTime(day.agentMs)} agent-hours, ${formatAgentTime(day.wallMs)} wall-clock`}
            </title>
          </rect>
        )
      })}
    </svg>
  )
}

function ProjectRow({ project }: { project: AgentActivityProjectRow }) {
  // Collapsed by default: the per-project totals and agent names answer the
  // founder's question; repository and worktree detail is there on demand.
  const [expanded, setExpanded] = useState(false)
  return (
    <section className="rounded-slab border border-border bg-surface" aria-label={`Project ${project.title}`}>
      <button
        type="button"
        onClick={() => setExpanded(value => !value)}
        aria-expanded={expanded}
        className="flex w-full items-start justify-between gap-3 px-3 py-2 text-left hover:bg-surface-hi"
      >
        <div className="min-w-0">
          <div className="truncate text-[12px] font-semibold text-ink">
            {project.title}
            {project.open ? null : <span className="ml-2 text-[10px] font-normal text-muted">closed</span>}
          </div>
          <div className="mt-0.5 text-[10px] text-muted">
            {totalAgents(project.agents)} agents · {agentsBreakdown(project.agents)}
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
      <DialogContent className="flex max-h-[88vh] w-[min(820px,calc(100vw-2rem))] flex-col">
        <DialogHeader className="flex-row items-start justify-between gap-4">
          <div>
            <DialogTitle className="font-semibold">Agent Analytics</DialogTitle>
            <DialogDescription className="mt-0.5 text-[10px]">
              Where your agents&apos; working time went. Time asleep and time waiting on you are not counted.
            </DialogDescription>
            {showing?.recordingSince != null ? (
              <div className="mt-1 text-[10px] text-muted">
                Recording since {new Date(showing.recordingSince).toLocaleDateString()}
              </div>
            ) : null}
          </div>
          <DialogClose asChild>
            <Button type="button" variant="secondary" size="sm">
              close
            </Button>
          </DialogClose>
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

        <div className="overflow-auto p-4">
          {error ? (
            <div className="rounded-slab mb-3 border border-danger bg-danger/10 px-3 py-2 text-[11px] text-danger" role="alert">
              {error}
            </div>
          ) : null}

          {!showing ? (
            <p className="text-[11px] text-muted" role="status">{loading ? 'Loading…' : null}</p>
          ) : showing.projects.length === 0 ? (
            <div className="px-2 py-10 text-center text-[12px] text-muted" role="status">
              No agent working time recorded in this range.
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <div className="grid grid-cols-3 gap-2">
                <Stat label="Agent-hours" value={formatAgentTime(showing.totals.agentMs)} detail="summed across agents" />
                <Stat label="Wall-clock" value={formatAgentTime(showing.totals.wallMs)} detail="time any agent was working" />
                <Stat
                  label="Agents"
                  value={String(totalAgents(showing.totals.agents))}
                  detail={agentsBreakdown(showing.totals.agents)}
                />
              </div>
              <DayBars days={showing.days} />
              {showing.projects.map(project => (
                <ProjectRow key={project.projectKey} project={project} />
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
