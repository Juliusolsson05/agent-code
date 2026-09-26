import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { TimeSeriesChart } from '@renderer/components/charts/TimeSeriesChart'
import type { TimeSeries } from '@renderer/components/charts/TimeSeriesChart'
import type { MonitorAgentUsage, MonitorCompositionSample } from '@shared/performance/agentUsage.js'
import type { MonitorSnapshot } from '@shared/performance/monitorSnapshot.js'
import { formatBytes, formatCpu, formatMs } from '../format'

// Order is stacking order, bottom to top: the app's own footprint is the
// baseline everything else sits on, and agents (usually the largest and most
// actionable slice) sit directly above it.
const SLICES: Array<{ id: keyof Omit<MonitorCompositionSample, 'at' | 'total'>; label: string; colorClass: string }> = [
  { id: 'app', label: 'Agent Code', colorClass: 'text-info' },
  { id: 'agents', label: 'Agents', colorClass: 'text-accent' },
  { id: 'terminals', label: 'Terminals', colorClass: 'text-success' },
  { id: 'shared', label: 'Shared helpers', colorClass: 'text-warning' },
  { id: 'other', label: 'Other', colorClass: 'text-muted' },
]

function Card({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <section className="rounded-slab border border-border bg-surface px-3 pb-1 pt-2" aria-label={title}>
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-[12px] font-semibold text-ink">{title}</h2>
        <span className="truncate text-[10px] text-muted">{subtitle}</span>
      </div>
      {children}
    </section>
  )
}

/**
 * Memory and CPU over the last fifteen minutes, split by who used them, plus
 * main-thread responsiveness.
 *
 * WHY memory and CPU share one crosshair: the usual investigation is "memory
 * jumped here, was something also burning CPU at that moment?" Two independent
 * hovers make that comparison a squint across two charts.
 */
export function UsageCharts({ snapshot, usage }: { snapshot: MonitorSnapshot; usage: MonitorAgentUsage | null }) {
  const [hoverAt, setHoverAt] = useState<number | null>(null)
  const composition = usage?.composition ?? []
  const to = usage?.sampledAt || snapshot.sampledAt
  const from = to - 15 * 60_000

  const memorySeries = useMemo<TimeSeries[]>(() => SLICES.map(slice => ({
    id: slice.id, label: slice.label, colorClass: slice.colorClass,
    points: composition.map(sample => ({ at: sample.at, value: sample[slice.id].memoryBytes })),
  })).filter(series => series.id !== 'other' || series.points.some(point => (point.value ?? 0) > 0)), [composition])
  const cpuSeries = useMemo<TimeSeries[]>(() => SLICES.map(slice => ({
    id: slice.id, label: slice.label, colorClass: slice.colorClass,
    points: composition.map(sample => ({ at: sample.at, value: sample[slice.id].cpuPercent })),
  })).filter(series => series.id !== 'other' || series.points.some(point => (point.value ?? 0) > 0)), [composition])

  const latest = composition.at(-1)

  return (
    <div className="grid gap-2 lg:grid-cols-2">
      <Card title="Memory" subtitle={latest ? `${formatBytes(latest.total.memoryBytes)} now · last 15 min` : 'Collecting…'}>
        <TimeSeriesChart label="Memory by owner" series={memorySeries} mode="stacked" from={from} to={to} formatValue={formatBytes}
          minCeiling={512 * 1024 ** 2} hoverAt={hoverAt} onHoverAt={setHoverAt} emptyLabel="Waiting for process samples" />
      </Card>
      <Card title="CPU" subtitle={latest ? `${formatCpu(latest.total.cpuPercent)} now · 100% = one core` : 'Collecting…'}>
        <TimeSeriesChart label="CPU by owner" series={cpuSeries} mode="stacked" from={from} to={to} formatValue={formatCpu}
          minCeiling={100} hoverAt={hoverAt} onHoverAt={setHoverAt} emptyLabel="Waiting for process samples" />
      </Card>
    </div>
  )
}

/** Is the UI itself keeping up: main event-loop delay against the incident
 * thresholds, and per-window renderer lag. */
export function ResponsivenessCards({ snapshot }: { snapshot: MonitorSnapshot }) {
  // Sleep-gap samples measure the suspension itself, not the app; charting
  // them would draw a multi-second "stall" for every lid close.
  const loopSeries = useMemo<TimeSeries[]>(() => {
    const recent = snapshot.recent.filter(sample => !sample.sleepGap)
    return [
      { id: 'peak', label: 'Loop peak', colorClass: 'text-warning', points: recent.map(sample => ({ at: sample.at, value: sample.loopMaxMs })) },
      { id: 'p99', label: 'Loop p99', colorClass: 'text-accent', points: recent.map(sample => ({ at: sample.at, value: sample.loopP99Ms })) },
    ]
  }, [snapshot.recent])
  const loopFrom = snapshot.recent[0]?.at ?? snapshot.sampledAt - 120_000
  const markers = (snapshot.incidents ?? []).filter(incident => incident.scope === 0 && incident.at >= loopFrom).map(incident => ({
    key: `${incident.at}:${incident.id}`, at: incident.at, label: incident.rule.replace(/-/g, ' '), tone: incident.severity === 'error' ? 'danger' as const : 'warning' as const,
  }))

  return (
    <div className="grid gap-2 lg:grid-cols-2">
      <Card title="Main thread responsiveness" subtitle={`p99 ${formatMs(snapshot.main?.loopP99Ms)} · last ${Math.max(1, Math.round((snapshot.sampledAt - loopFrom) / 60_000))} min`}>
        <TimeSeriesChart label="Main event-loop delay" series={loopSeries} from={loopFrom} to={snapshot.sampledAt} formatValue={formatMs} height={130}
          minCeiling={50} markers={markers} thresholds={[{ value: 100, label: 'Slow · 100 ms', tone: 'warning' }, { value: 1000, label: 'Stall · 1 s', tone: 'danger' }]} />
      </Card>
      <Card title="Windows" subtitle="Renderer scheduler lag per window">
        <div className="max-h-[130px] overflow-auto py-1">
          {!snapshot.windows.length ? <p className="py-4 text-center text-[11px] text-muted">Waiting for window heartbeats.</p> : (
            <table className="w-full text-left text-[11px] tabular-nums">
              <thead className="text-[10px] text-muted"><tr><th className="py-1 font-normal">Window</th><th className="font-normal">State</th><th className="text-right font-normal">Lag</th><th className="text-right font-normal">Long tasks</th><th className="text-right font-normal">Slow input</th><th className="text-right font-normal">Heap</th></tr></thead>
              <tbody>
                {snapshot.windows.map((window, index) => (
                  <tr key={window.windowId} className="border-t border-border">
                    <td className="py-1 text-ink">Window {index + 1}</td>
                    <td className="capitalize text-muted">{window.visibility}</td>
                    <td className={`text-right ${window.lagMs >= 1000 ? 'text-danger' : window.lagMs >= 100 ? 'text-warning' : 'text-ink-dim'}`}>{formatMs(window.lagMs)}</td>
                    <td className="text-right text-ink-dim">{window.longTasksSupported ? window.longTaskCount : '—'}</td>
                    <td className="text-right text-ink-dim">{window.inputSupported ? formatMs(window.inputMaxMs) : '—'}</td>
                    <td className="text-right text-ink-dim">{formatBytes(window.heapUsedBytes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </Card>
    </div>
  )
}
