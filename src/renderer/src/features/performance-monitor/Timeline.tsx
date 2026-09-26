import { useCallback, useEffect, useMemo, useState } from 'react'
import { SegmentedControl } from '@renderer/components/ui/segmented-control'
import type { ReactNode } from 'react'
import { Button } from '@renderer/components/ui/button'
import type { MonitorHistoryPage, MonitorHistoryPoint } from '@shared/performance/monitorHistory.js'
import { TimeSeriesChart } from '@renderer/components/charts/TimeSeriesChart'
import { formatBytes, formatCpu, formatMs } from './format'
import type { MonitorIncidentSummary } from '@shared/performance/monitorIncidents.js'
import { Incidents } from './Incidents'

const ranges = [{ label: '15 min', ms: 15 * 60_000 }, { label: '1 hour', ms: 60 * 60_000 }, { label: '6 hours', ms: 6 * 60 * 60_000 }, { label: '24 hours', ms: 24 * 60 * 60_000 }, { label: '7 days', ms: 7 * 24 * 60 * 60_000 }] as const

export function Timeline({ incidents }: { incidents: MonitorIncidentSummary[] }) {
  const [range, setRange] = useState<(typeof ranges)[number]>(ranges[0])
  const [page, setPage] = useState<MonitorHistoryPage | null>(null)
  const [live, setLive] = useState(true)
  const [to, setTo] = useState(() => Date.now())
  const [revision, setRevision] = useState(0)
  const [error, setError] = useState(false)
  useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const read = async () => {
      const end = live ? Date.now() : to
      const from = Math.max(0, end - range.ms)
      let ok = false
      try {
        const result = await window.api.getMonitorHistory(from, end, undefined, 1000)
        ok = result !== null
        // WHY keep the previous page on null: the helper answers null while
        // busy, restarting or shedding a concurrent query. Replacing a valid
        // chart with "unavailable" on every transient miss made the timeline
        // flicker; the status line below still says the reading is delayed.
        // Only a page for the SAME range may stand in, though: after a range
        // change a stale 15-minute chart under a "7 days" label is wrong data,
        // not a delayed view. Live pages slide, so they match by duration.
        const sameRange = (previous: MonitorHistoryPage) => live
          ? previous.to - previous.from === end - from
          : previous.from === from && previous.to === end
        if (!disposed) { setPage(previous => result ?? (previous && sameRange(previous) ? previous : null)); setError(!ok) }
      } catch { if (!disposed) setError(true) }
      // A paused timeline has no polling loop, so a failed read must schedule
      // its own retry or the view stays "unavailable" until the user acts.
      finally { if (!disposed && (live || !ok)) timer = setTimeout(read, live ? 10_000 : 5000) }
    }
    void read()
    return () => { disposed = true; clearTimeout(timer) }
  }, [live, range, revision, to])

  const [hoverAt, setHoverAt] = useState<number | null>(null)
  const [incidentFocus, setIncidentFocus] = useState<{ key: string; nonce: number } | null>(null)
  // Three lanes on one time axis with one crosshair. WHY lanes instead of one
  // chart with every series: memory, CPU and delay have different units, and
  // a shared y-axis would flatten two of them into the floor.
  const lanes = useMemo(() => {
    const points = page?.points ?? []
    const series = (id: string, label: string, colorClass: string, read: (point: MonitorHistoryPoint) => number | null | undefined) => ({
      id, label, colorClass, points: points.map(point => ({ at: point.at, value: read(point) ?? null })),
    })
    return {
      memory: [
        series('app', 'App memory', 'text-accent', point => point.processes?.memoryBytes),
        series('heap', 'Main JS heap', 'text-info', point => point.main?.heapUsed),
      ],
      cpu: [
        series('app', 'App CPU', 'text-accent', point => point.processes?.cpuPercent),
        series('main', 'Main process', 'text-info', point => point.main?.cpuPercent),
      ],
      // A sleep-gap sample's loop delay is the suspension itself; hide it so
      // every lid close does not draw a stall.
      delay: [
        series('loop', 'Main loop peak', 'text-warning', point => point.main?.sleepGap ? null : point.main?.loopMaxMs),
        series('lag', 'Worst renderer lag', 'text-accent', point => point.windows.maxLagMs),
        series('input', 'Slowest input', 'text-info', point => point.windows.maxInputMs || null),
      ],
    }
  }, [page])
  const shownIncidents = useMemo(() => {
    const merged = new Map<string, MonitorIncidentSummary>()
    for (const incident of page?.incidents ?? []) merged.set(`${incident.at}:${incident.id}`, incident)
    for (const incident of incidents) if (!page || (incident.at >= page.from && incident.at <= page.to)) {
      merged.set(`${incident.at}:${incident.id}`, incident)
    }
    return [...merged.values()].sort((a, b) => a.at - b.at).slice(-50)
  }, [incidents, page])
  const liveSignature = incidents.map(incident => `${incident.at}:${incident.id}`).join('|')
  const readIncident = useCallback((incident: MonitorIncidentSummary) => {
    // Current-run captures keep changing during their 15-second post window,
    // so ask the live engine for those. Older persisted summaries use their
    // wall-time plus run-local ID to disambiguate IDs reused after restart.
    const key = `${incident.at}:${incident.id}`
    return liveSignature.split('|').includes(key)
      ? window.api.getMonitorIncident(incident.id)
      : window.api.getMonitorHistoryIncident(incident.at, incident.id)
  }, [liveSignature])

  // Panning moves a paused window by half its width. WHY half: consecutive
  // views overlap, so an event near an edge is never split out of sight.
  const pan = (direction: -1 | 1) => {
    const base = live ? Date.now() : to
    setTo(Math.min(Date.now(), base + direction * range.ms / 2))
    setLive(false)
  }
  const markers = shownIncidents.map(incident => ({
    key: `${incident.at}:${incident.id}`, at: incident.at,
    label: `${incident.rule.replace(/-/g, ' ')} · ${new Date(incident.at).toLocaleTimeString()}`,
    tone: incident.severity === 'error' ? 'danger' as const : 'warning' as const,
    onSelect: () => setIncidentFocus(current => ({ key: `${incident.at}:${incident.id}`, nonce: (current?.nonce ?? 0) + 1 })),
  }))
  const lane = (title: string, subtitle: string, chart: ReactNode) => (
    <section className="rounded-slab border border-border bg-surface px-3 pb-1 pt-2" aria-label={title}>
      <div className="flex items-baseline justify-between gap-2"><h3 className="text-[12px] font-semibold text-ink">{title}</h3><span className="text-[10px] text-muted">{subtitle}</span></div>
      {chart}
    </section>
  )

  return <div className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h2 className="font-medium">History</h2><p className="mt-1 text-[11px] text-muted">{page ? `${new Date(page.from).toLocaleString()} – ${live ? 'now' : new Date(page.to).toLocaleString()} · ${page.resolution} samples, peak per bucket` : 'Local rollups kept for up to 7 days.'}</p></div>
      <div className="flex flex-wrap items-center gap-1">
        {/* The shared SegmentedControl (ledger G-37): a single choice drawn as
            loose secondary/ghost Buttons was the only range picker in the app
            not using it. `pressed` semantics, because each range change reads
            history from disk, and arrow-to-select would fire one read per step. */}
        {/* h-7: level with the sm Buttons (Earlier / Later / Pause) in the
            same toolbar; the group's segments stretch to it. */}
        <SegmentedControl
          className="h-7"
          label="History range"
          value={range.label}
          onChange={label => { setRange(ranges.find(option => option.label === label) ?? ranges[0]); setRevision(value => value + 1) }}
          options={ranges.map(option => ({ value: option.label, label: option.label }))}
        />
        <span className="mx-1 h-4 w-px bg-border" aria-hidden="true" />
        <Button size="sm" variant="outline" onClick={() => pan(-1)} aria-label="Show earlier">← Earlier</Button>
        <Button size="sm" variant="outline" disabled={live} onClick={() => pan(1)} aria-label="Show later">Later →</Button>
        <Button size="sm" variant={live ? 'secondary' : 'default'} onClick={() => { if (live) { setTo(Date.now()); setLive(false) } else { setLive(true); setRevision(value => value + 1) } }}>{live ? 'Pause' : 'Back to Live'}</Button>
      </div>
    </div>
    {!page ? <p role="status" className="text-muted">{error ? 'History is temporarily unavailable. Live monitoring continues.' : 'Loading local history…'}</p> : <>
      {error && <p role="status" className="text-[11px] text-muted">History reading delayed; showing the last loaded view.</p>}
      {lane('Memory', 'Resident memory of all Agent Code processes', <TimeSeriesChart label="Memory history" series={lanes.memory} from={page.from} to={page.to} formatValue={formatBytes} minCeiling={512 * 1024 ** 2} markers={markers} hoverAt={hoverAt} onHoverAt={setHoverAt} emptyLabel="No retained data in this range" />)}
      {lane('CPU', '100% = one core', <TimeSeriesChart label="CPU history" series={lanes.cpu} from={page.from} to={page.to} formatValue={formatCpu} minCeiling={100} markers={markers} hoverAt={hoverAt} onHoverAt={setHoverAt} emptyLabel="No retained data in this range" />)}
      {lane('Responsiveness', 'Peak delay per bucket', <TimeSeriesChart label="Responsiveness history" series={lanes.delay} from={page.from} to={page.to} formatValue={formatMs} minCeiling={50} markers={markers} hoverAt={hoverAt} onHoverAt={setHoverAt}
        thresholds={[{ value: 100, label: 'Slow · 100 ms', tone: 'warning' }, { value: 1000, label: 'Stall · 1 s', tone: 'danger' }]} emptyLabel="No retained data in this range" />)}
      <p className="text-[10px] text-muted">{formatBytes(page.status.bytes)} stored · {page.status.points.toLocaleString()} tiered points · {page.status.state}{page.status.shortened ? ' · retention shortened by capacity' : ''} · click a marker to open its incident</p>
    </>}
    <section className="space-y-3"><h2 className="font-medium">Detected incidents</h2><Incidents incidents={shownIncidents} readIncident={readIncident} focus={incidentFocus} /></section>
  </div>
}
