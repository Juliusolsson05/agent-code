import type { ReactNode } from 'react'
import type { MonitorAgentUsage } from '@shared/performance/agentUsage.js'
import type { MonitorSnapshot } from '@shared/performance/monitorSnapshot.js'
import type { AgentIdentity } from '../agentIdentity'
import { formatByteDelta, formatBytes, formatCpu, formatMs } from '../format'

export type Tone = 'ok' | 'warning' | 'danger' | 'neutral'
const TONE_BAR: Record<Tone, string> = { ok: 'bg-success', warning: 'bg-warning', danger: 'bg-danger', neutral: 'bg-border-hi' }
const TONE_TEXT: Record<Tone, string> = { ok: 'text-ink', warning: 'text-warning-fg', danger: 'text-danger-fg', neutral: 'text-ink' }

function Tile({ label, value, detail, tone = 'neutral', children }: { label: string; value: string; detail: ReactNode; tone?: Tone; children?: ReactNode }) {
  return (
    <div className="relative overflow-hidden rounded-slab border border-border bg-surface px-3 py-2.5">
      {/* A tone stripe, not a colored card: eight fully tinted tiles would
          read as eight alarms. The stripe lets a warning stand out while the
          healthy tiles stay quiet. */}
      <span className={`absolute inset-y-0 left-0 w-[3px] ${TONE_BAR[tone]}`} aria-hidden="true" />
      <div className="text-[10px] uppercase tracking-wider text-muted">{label}</div>
      <div className={`mt-0.5 text-[20px] font-semibold leading-tight tabular-nums ${TONE_TEXT[tone]}`}>{value}</div>
      <div className="mt-0.5 truncate text-[10px] text-muted">{detail}</div>
      {children}
    </div>
  )
}

/**
 * The answers someone opens the monitor for, in reading order: is the app
 * heavy, who is heaviest, is it getting worse, and is the UI responsive.
 *
 * Thresholds come from what the incident engine already treats as abnormal
 * (100 ms slow loop, 1 s stall, 70% heap), so a tile turning amber means the
 * same thing as an incident being recorded, never a second arbitrary rule.
 */
export function HealthTiles({ snapshot, usage, identities }: { snapshot: MonitorSnapshot; usage: MonitorAgentUsage | null; identities: Map<string, AgentIdentity> }) {
  const composition = usage?.composition ?? []
  const latest = composition.at(-1)
  const first = composition[0]
  const memory = latest?.total.memoryBytes ?? snapshot.processes?.memoryBytes ?? null
  const share = memory !== null && usage?.systemMemoryBytes ? memory / usage.systemMemoryBytes : null
  const change = latest && first && latest !== first ? formatByteDelta(latest.total.memoryBytes - first.total.memoryBytes) : null
  const minutes = latest && first ? Math.max(1, Math.round((latest.at - first.at) / 60_000)) : 0
  const cpu = latest?.total.cpuPercent ?? snapshot.processes?.cpuPercent ?? null
  const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || null : null

  const heaviest = usage?.sessions.find(session => session.memoryBytes !== null) ?? null
  const heaviestIdentity = heaviest ? identities.get(heaviest.sessionId) : undefined
  const agents = usage?.sessions.filter(session => session.kind === 'agent').length ?? 0
  const terminals = usage?.sessions.filter(session => session.kind === 'terminal').length ?? 0

  const loop = snapshot.main?.loopP99Ms ?? null
  const worstLag = snapshot.windows.reduce<number | null>((max, window) => Math.max(max ?? 0, window.lagMs), null)
  const responsiveness = Math.max(loop ?? 0, worstLag ?? 0)
  const heapRatio = snapshot.main && snapshot.main.heapLimit > 0 ? snapshot.main.heapUsed / snapshot.main.heapLimit : null
  const hourAgo = Date.now() - 3_600_000
  const recentIncidents = (snapshot.incidents ?? []).filter(incident => incident.at >= hourAgo)
  const incidentTone: Tone = recentIncidents.some(incident => incident.severity === 'error') ? 'danger' : recentIncidents.length ? 'warning' : 'ok'

  return (
    <div className="grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-7">
      <Tile label="App memory" value={formatBytes(memory)} tone={share === null ? 'neutral' : share >= 0.75 ? 'danger' : share >= 0.5 ? 'warning' : 'ok'}
        detail={<>{share === null ? 'All Agent Code processes' : `${(share * 100).toFixed(0)}% of ${formatBytes(usage!.systemMemoryBytes)} RAM`}{change ? <> · <span className={change.tone === 'up' ? 'text-warning-fg' : ''}>{change.text}</span> in {minutes} min</> : null}</>} />
      <Tile label="App CPU" value={formatCpu(cpu)} tone={cpu === null ? 'neutral' : cores && cpu >= cores * 80 ? 'danger' : cores && cpu >= cores * 50 ? 'warning' : 'ok'}
        detail={cores ? `100% = one core · ${cores} cores` : '100% = one core'} />
      <Tile label="Heaviest agent" value={heaviest ? formatBytes(heaviest.memoryBytes) : '—'}
        tone={heaviest && memory ? (heaviest.memoryBytes! / memory >= 0.5 ? 'warning' : 'neutral') : 'neutral'}
        detail={heaviest ? `${heaviestIdentity?.label ?? '—'} · ${heaviestIdentity?.title ?? 'Unknown agent'}` : 'Waiting for process samples'} />
      <Tile label="Running" value={`${agents}`} detail={`agents${terminals ? ` · ${terminals} terminals` : ''} · ${snapshot.processes?.count ?? 0} processes`} />
      <Tile label="UI responsiveness" value={formatMs(loop === null && worstLag === null ? null : responsiveness)}
        tone={loop === null && worstLag === null ? 'neutral' : responsiveness >= 1000 ? 'danger' : responsiveness >= 100 ? 'warning' : 'ok'}
        detail={`main p99 ${formatMs(loop)} · worst window ${formatMs(worstLag)}`} />
      <Tile label="Main JS heap" value={heapRatio === null ? '—' : `${(heapRatio * 100).toFixed(0)}%`}
        tone={heapRatio === null ? 'neutral' : heapRatio >= 0.85 ? 'danger' : heapRatio >= 0.7 ? 'warning' : 'ok'}
        detail={`${formatBytes(snapshot.main?.heapUsed)} of ${formatBytes(snapshot.main?.heapLimit)}`} />
      <Tile label="Incidents" value={`${recentIncidents.length}`} tone={incidentTone}
        detail={recentIncidents.length ? `last hour · latest ${recentIncidents.at(-1)!.rule.replace(/-/g, ' ')}` : 'none in the last hour'} />
    </div>
  )
}
