import { useMemo, useState } from 'react'
import { Button } from '@renderer/components/ui/button'
import { Sparkline } from '@renderer/components/charts/Sparkline'
import { providerLabel } from '@renderer/workspace/tile-tree/TileLeaf/labels'
import type { MonitorAgentUsage, MonitorSessionUsage } from '@shared/performance/agentUsage.js'
import type { AgentIdentity } from '../agentIdentity'
import { formatByteDelta, formatBytes, formatCpu } from '../format'

type Sort = 'memory' | 'cpu' | 'growth'
const COLLAPSED_ROWS = 10

function growth(session: MonitorSessionUsage): number | null {
  const readings = session.history.filter(point => point[1] !== null)
  if (readings.length < 2) return null
  return readings.at(-1)![1]! - readings[0]![1]!
}

/**
 * Every running agent and terminal, ranked, under the label the user already
 * sees in the workspace.
 *
 * WHY growth is a sort and not just a column: "which agent is using the most
 * memory" and "which agent is leaking" are different questions. A 3 GB agent
 * that has been flat for fifteen minutes is expected; a 600 MB agent that grew
 * 500 MB in the same window is the one to look at, and it would sit far down a
 * memory-only ranking.
 */
export function TopConsumers({ usage, identities, onOpenAgent }: {
  usage: MonitorAgentUsage | null
  identities: Map<string, AgentIdentity>
  onOpenAgent: (sessionId: string) => void
}) {
  const [sort, setSort] = useState<Sort>('memory')
  const [expanded, setExpanded] = useState(false)
  const latest = usage?.composition.at(-1)
  const from = usage?.composition[0]?.at ?? 0
  const to = usage?.sampledAt ?? 0
  const total = latest?.total.memoryBytes ?? 0

  // The history window starts at launch, so right after start the delta
  // covers less than 15 minutes. Label what was actually measured rather
  // than promising a window the data does not have yet.
  const firstReadingAt = usage?.composition[0]?.at
  const windowMinutes = firstReadingAt && latest ? Math.max(1, Math.round((latest.at - firstReadingAt) / 60_000)) : null

  const rows = useMemo(() => {
    const sessions = [...(usage?.sessions ?? [])]
    const key = (session: MonitorSessionUsage) => sort === 'memory' ? session.memoryBytes ?? -1 : sort === 'cpu' ? session.cpuPercent ?? -1 : growth(session) ?? -Infinity
    return sessions.sort((a, b) => key(b) - key(a))
  }, [sort, usage])
  // One ceiling for every sparkline, so trend heights compare across rows.
  const ceiling = useMemo(() => Math.max(0, ...rows.flatMap(row => row.history.map(point => point[1] ?? 0))), [rows])
  const shown = expanded ? rows : rows.slice(0, COLLAPSED_ROWS)

  return (
    <section className="flex min-h-0 flex-col rounded-slab border border-border bg-surface" aria-label="Agents by resource use">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div>
          <h2 className="text-[12px] font-semibold text-ink">Agents by resource use</h2>
          <p className="text-[10px] text-muted">Each agent includes the processes it started. Helpers shared between agents are counted once, separately.</p>
        </div>
        <div className="flex gap-1" role="group" aria-label="Sort agents">
          {(['memory', 'cpu', 'growth'] as const).map(option => (
            <Button key={option} size="xs" variant={sort === option ? 'secondary' : 'ghost'} aria-pressed={sort === option} onClick={() => setSort(option)}>
              {option === 'memory' ? 'Memory' : option === 'cpu' ? 'CPU' : 'Growth'}
            </Button>
          ))}
        </div>
      </header>
      {!usage ? <p className="px-3 py-6 text-center text-[11px] text-muted" role="status">Waiting for the first process sample…</p>
        : !rows.length ? <p className="px-3 py-6 text-center text-[11px] text-muted" role="status">No agents are running.</p> : (
          <div className="min-h-0 overflow-auto">
            <table className="w-full text-left text-[11px] tabular-nums">
              <thead className="sticky top-0 bg-surface text-[10px] text-muted">
                <tr>
                  <th className="px-3 py-1.5 font-normal">Agent</th>
                  <th className="px-2 py-1.5 font-normal">Memory</th>
                  <th className="px-2 py-1.5 text-right font-normal">{windowMinutes === null ? 'Δ' : `${windowMinutes} min`}</th>
                  <th className="px-2 py-1.5 text-right font-normal">CPU</th>
                  <th className="px-2 py-1.5 text-right font-normal">Procs</th>
                  <th className="px-2 py-1.5 font-normal">Trend</th>
                  <th className="px-3 py-1.5"><span className="sr-only">Open</span></th>
                </tr>
              </thead>
              <tbody>
                {shown.map(session => {
                  const identity = identities.get(session.sessionId)
                  const change = formatByteDelta(growth(session))
                  const shareOfApp = total > 0 && session.memoryBytes !== null ? session.memoryBytes / total : 0
                  const name = identity?.title ?? `${providerLabel(session.provider)} session`
                  return (
                    <tr key={session.sessionId} className="group border-t border-border hover:bg-row-hover-bg">
                      <td className="max-w-0 px-3 py-1.5">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className={`flex-shrink-0 rounded-chip border px-1 text-[10px] font-semibold leading-[14px] ${identity?.label ? 'border-current/30 text-ink' : 'border-border text-muted'}`}
                            title={identity?.label ? undefined : 'Not placed in this window'}>{identity?.label ?? '—'}</span>
                          <div className="min-w-0">
                            <div className="truncate text-ink" title={name}>{name}</div>
                            <div className="truncate text-[10px] text-muted">{providerLabel(session.provider)}{identity?.tabTitle ? ` · ${identity.tabTitle}` : ''}</div>
                          </div>
                        </div>
                      </td>
                      <td className="w-[26%] px-2 py-1.5">
                        <div className="flex items-center gap-2">
                          <span className="w-[62px] flex-shrink-0 text-ink" title={session.complete ? undefined : 'Some processes had no reading yet; this is a lower bound.'}>
                            {session.complete || session.memoryBytes === null ? '' : '≥'}{formatBytes(session.memoryBytes)}
                          </span>
                          {/* Share of the whole app, not of the top row: the
                              bar should say "this agent is 40% of Agent Code". */}
                          <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-hi" aria-hidden="true">
                            {/* A 0-measured row keeps an empty track: Math.max(1, …) painted a 1% sliver that read as almost-none instead of nothing. */}
                            <span className={`block h-full rounded-full ${shareOfApp >= 0.5 ? 'bg-warning' : 'bg-accent'}`} style={{ width: `${shareOfApp > 0 ? Math.max(1, shareOfApp * 100) : 0}%` }} />
                          </span>
                          <span className="w-[30px] flex-shrink-0 text-right text-[10px] text-muted">{(shareOfApp * 100).toFixed(0)}%</span>
                        </div>
                      </td>
                      <td className={`px-2 py-1.5 text-right ${change.tone === 'up' ? 'text-warning-fg' : change.tone === 'down' ? 'text-success-fg' : 'text-muted'}`}>{change.text}</td>
                      <td className="px-2 py-1.5 text-right text-ink-dim">{formatCpu(session.cpuPercent)}</td>
                      <td className="px-2 py-1.5 text-right text-ink-dim">{session.processCount}</td>
                      <td className="px-2 py-1.5">
                        <Sparkline points={session.history.map(point => ({ at: point[0], value: point[1] }))} from={from} to={to} ceiling={ceiling}
                          colorClass={change.tone === 'up' ? 'text-warning' : 'text-accent'} title={`${name}: ${formatBytes(session.memoryBytes)} now, ${change.text} over the window`} />
                      </td>
                      <td className="px-3 py-1.5 text-right">
                        {identity?.label ? (
                          <Button size="xs" variant="ghost" className="opacity-60 group-hover:opacity-100 focus-visible:opacity-100" onClick={() => onOpenAgent(session.sessionId)} aria-label={`Go to ${identity.label} ${name}`}>
                            Go to
                          </Button>
                        ) : null}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            {rows.length > COLLAPSED_ROWS ? (
              <div className="border-t border-border px-3 py-1.5">
                <Button size="xs" variant="ghost" onClick={() => setExpanded(value => !value)}>{expanded ? 'Show top 10' : `Show all ${rows.length}`}</Button>
              </div>
            ) : null}
          </div>
        )}
    </section>
  )
}
