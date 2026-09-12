import { useEffect, useMemo, useState } from 'react'
import { Button } from '@renderer/components/ui/button'
import type { MonitorHistoryPage } from '@shared/performance/monitorHistory.js'
import type { MonitorIncidentSummary } from '@shared/performance/monitorIncidents.js'
import { Incidents } from './Incidents'

const ranges = [{ label: '15 min', ms: 15 * 60_000 }, { label: '24 hours', ms: 24 * 60 * 60_000 }, { label: '7 days', ms: 7 * 24 * 60 * 60_000 }] as const

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
      try {
        const result = await window.api.getMonitorHistory(Math.max(0, end - range.ms), end, undefined, 1000)
        if (!disposed) { setPage(result); setError(result === null) }
      } catch { if (!disposed) setError(true) }
      finally { if (!disposed && live) timer = setTimeout(read, 10_000) }
    }
    void read()
    return () => { disposed = true; clearTimeout(timer) }
  }, [live, range, revision, to])

  const path = useMemo(() => {
    const points = page?.points.filter(point => point.main?.loopMaxMs !== null) ?? []
    if (!points.length) return ''
    const first = points[0]!.at
    const duration = Math.max(1, points.at(-1)!.at - first)
    const peak = Math.max(1, ...points.map(point => point.main?.loopMaxMs ?? 0))
    return points.map((point, index) => `${index ? 'L' : 'M'}${(point.at - first) / duration * 600},${100 - (point.main?.loopMaxMs ?? 0) / peak * 90}`).join(' ')
  }, [page])

  return <div className="space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h2 className="font-medium">Responsiveness timeline</h2><p className="mt-1 text-[11px] text-muted">Local rollups; gaps and shortened retention remain visible in coverage.</p></div>
      <div className="flex flex-wrap gap-2">{ranges.map(option => <Button key={option.label} size="sm" variant={range === option ? 'default' : 'ghost'} onClick={() => { setRange(option); setRevision(value => value + 1) }}>{option.label}</Button>)}
        <Button size="sm" variant="outline" onClick={() => { if (live) { setTo(Date.now()); setLive(false) } else { setLive(true); setRevision(value => value + 1) } }}>{live ? 'Pause timeline' : 'Resume live'}</Button>
      </div>
    </div>
    {error ? <p role="status" className="text-muted">History is temporarily unavailable. Live monitoring continues.</p> : !page ? <p role="status" className="text-muted">Loading local history…</p> : <>
      <section className="rounded-slab border border-border bg-canvas p-3">
        <div className="flex justify-between text-[11px]"><span>Main event-loop peak</span><span className="text-muted">{page.resolution} resolution · latest {page.points.length.toLocaleString()} points</span></div>
        <svg viewBox="0 0 600 112" className="my-2 h-28 w-full text-accent" role="img" aria-label={`Main event-loop peak over ${range.label}; ${page.points.length} local points`}>
          <path d="M0 100H600" stroke="currentColor" opacity="0.15" /><path d={path} stroke="currentColor" strokeWidth="2" fill="none" vectorEffect="non-scaling-stroke" />
        </svg>
        <div className="flex justify-between text-[10px] text-muted"><span>{page.points[0] ? new Date(page.points[0].at).toLocaleString() : 'No retained data'}</span><span>{page.points.at(-1) ? new Date(page.points.at(-1)!.at).toLocaleString() : ''}</span></div>
      </section>
      <p className="text-[11px] text-muted">{(page.status.bytes / 1024 / 1024).toFixed(1)} MiB stored · {page.status.points.toLocaleString()} tiered points · {page.status.state}{page.status.shortened ? ' · retention shortened by capacity' : ''}{page.nextCursor ? ' · older points available outside this bounded view' : ''}</p>
    </>}
    <section className="space-y-3"><h2 className="font-medium">Detected incidents</h2><Incidents incidents={incidents} /></section>
  </div>
}
