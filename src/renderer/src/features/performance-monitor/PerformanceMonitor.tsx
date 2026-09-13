import { Timeline } from './Timeline'
import { useEffect, useMemo, useState } from 'react'
import type { PerformancePanelRequest } from '@renderer/app-state/uiShell/types'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@renderer/components/ui/dialog'
import { Button } from '@renderer/components/ui/button'
import type { MonitorMainSample, MonitorSnapshot } from '@shared/performance/monitorSnapshot.js'
import type { MonitorReportPreview, MonitorTraceMode, MonitorTraceStatus } from '@shared/performance/monitorHistory.js'
import type { MonitorProcessPage } from '@shared/performance/processSnapshot.js'
import { latencyQuantile } from '@shared/performance/latencyHistogram.js'
import { useMonitor } from './useMonitor'

const bytes = (value: number | null | undefined) => value == null ? '—' : value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(2)} GiB` : `${(value / 1024 ** 2).toFixed(1)} MiB`
const number = (value: number | null | undefined, suffix = '') => value == null ? '—' : `${value.toFixed(1)}${suffix}`
type View = 'overview' | 'timeline' | 'processes' | 'operations' | 'recordings'
// Module scope, not a ref: StrictMode and a close/reopen both remount the
// component, and a replayed request would open a second native dialog.
let lastHandledRequest = 0

export function PerformanceMonitor({ onClose, request = null, onRequestHandled }: { onClose: () => void; request?: PerformancePanelRequest | null; onRequestHandled?: (id: number) => void }) {
  const { snapshot, error } = useMonitor()
  const [view, setView] = useState<View>(request?.view ?? 'overview')
  useEffect(() => { if (request) setView(request.view) }, [request])
  return <Dialog open onOpenChange={open => { if (!open) onClose() }}>
    <DialogContent className="w-[min(1040px,94vw)] max-h-[90vh] grid-rows-[auto_auto_minmax(0,1fr)]" showCloseButton>
      <DialogHeader>
        <DialogTitle>Performance Monitor</DialogTitle>
        <DialogDescription>Live health and local performance evidence for Agent Code and your agents.</DialogDescription>
        <div className="mt-3 flex flex-wrap items-center gap-3 text-[11px] text-muted">
          <span className={snapshot?.collector === 'healthy' && !error ? 'text-accent' : ''}>
            {error ? 'Readings delayed' : snapshot ? snapshot.collector === 'healthy' ? 'Collecting locally' : `Collector ${snapshot.collector}` : 'Connecting…'}
          </span>
          <span>Always on · no automatic uploads</span>
          {snapshot && <span>{snapshot.droppedRecords.toLocaleString()} dropped records · {snapshot.restarts} collector restarts</span>}
        </div>
      </DialogHeader>
      <nav aria-label="Performance views" className="flex gap-2 border-b border-border px-4 py-2">
        {(['overview', 'timeline', 'processes', 'operations', 'recordings'] as const).map(tab => <Button key={tab} size="sm" variant={view === tab ? 'default' : 'ghost'} aria-pressed={view === tab} onClick={() => setView(tab)}>
          {tab[0].toUpperCase() + tab.slice(1)}
        </Button>)}
      </nav>
      <div className="overflow-auto p-4 text-[12px] min-h-[min(400px,50vh)]">
        {!snapshot ? <p className="text-muted" role="status">{error ? 'Performance readings are unavailable. Collection will reconnect automatically.' : 'Waiting for the first sample…'}</p>
          : view === 'overview' ? <Overview snapshot={snapshot} />
            : view === 'timeline' ? <Timeline incidents={snapshot.incidents ?? []} />
              : view === 'processes' ? <Processes /> : view === 'recordings' ? <Recordings snapshot={snapshot} request={request} onRequestHandled={onRequestHandled} /> : <Operations snapshot={snapshot} />}
      </div>
    </DialogContent>
  </Dialog>
}

function Recordings({ snapshot, request, onRequestHandled }: { snapshot: MonitorSnapshot; request: PerformancePanelRequest | null; onRequestHandled?: (id: number) => void }) {
  const [range, setRange] = useState(15 * 60_000)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  // The last file this tab saved. Reports and heap snapshots are written to a
  // user-chosen path, so the result must say where and offer Reveal.
  const [artifact, setArtifact] = useState<string | null>(null)
  const [preview, setPreview] = useState<MonitorReportPreview | null>(null)
  const [trace, setTrace] = useState<MonitorTraceStatus | null>(null)
  // A preview estimates the selected range and data classes; it does not need
  // to chase the worker's one-second newestAt value. Re-querying on every live
  // sample would make an idle Recordings tab create constant disk work.
  useEffect(() => {
    let disposed = false
    const end = Date.now()
    void window.api.previewMonitorReport(Math.max(0, end - range), end).then(value => { if (!disposed) setPreview(value) }).catch(() => {})
    return () => { disposed = true }
  }, [range])
  useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const read = async () => {
      try { const value = await window.api.getMonitorTraceStatus(); if (!disposed) setTrace(value) }
      catch { /* Live monitoring remains available when profiling is unsupported. */ }
      finally { if (!disposed) timer = setTimeout(read, trace?.state === 'recording' ? 1000 : 3000) }
    }
    void read()
    return () => { disposed = true; clearTimeout(timer) }
  }, [trace?.state])
  const save = async () => {
    setBusy(true); setMessage(null); setArtifact(null)
    try {
      const result = await window.api.saveMonitorReport(Math.max(0, Date.now() - range), Date.now())
      if (result.ok) setArtifact(result.path)
      setMessage(result.ok ? `Saved ${(result.bytes / 1024).toFixed(1)} KiB with ${result.points.toLocaleString()} metric points and ${result.incidents} incidents to ${result.path}.`
        : result.code === 'cancelled' ? 'Save cancelled.' : `Report was not saved (${result.code}).`)
    } catch { setMessage('Report was not saved.') }
    finally { setBusy(false) }
  }
  const clear = async () => {
    setBusy(true); setMessage(null)
    try {
      const result = await window.api.clearMonitorHistory()
      setMessage(result.outcome === 'cleared' ? 'Local performance history and incident evidence were deleted.'
        : result.outcome === 'cancelled' ? null
          : result.outcome === 'busy' ? 'A report is being saved. Nothing was deleted; try again when it finishes.'
            : result.outcome === 'unavailable' ? 'History is temporarily unavailable. Nothing was deleted.'
              : result.outcome === 'unknown' ? 'The monitor did not confirm the clear. Some history may already be deleted; check again shortly.'
                : 'History could not be fully deleted. Some local files may remain.')
    } catch { setMessage('History could not be cleared.') }
    finally { setBusy(false) }
  }
  const startTrace = async (mode: MonitorTraceMode) => {
    setBusy(true); setMessage(null)
    try { const status = await window.api.startMonitorTrace(mode, 30_000); setTrace(status); if (status?.state === 'failed') setMessage(status.message) }
    catch { setMessage('Recording could not start.') }
    finally { setBusy(false) }
  }
  const stopTrace = async (cancel: boolean) => {
    setBusy(true)
    try { const status = await window.api.stopMonitorTrace(cancel); setTrace(status); setMessage(status?.message ?? null) }
    catch { setMessage('Recording could not stop cleanly.') }
    finally { setBusy(false) }
  }
  useEffect(() => {
    if (!request || request.id <= lastHandledRequest) return
    lastHandledRequest = request.id
    onRequestHandled?.(request.id)
    if (request.action === 'save-report') void save()
    else void startTrace('chromium')
    // Keyed by the request identity only; the handlers read current state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request?.id])
  const heap = async () => {
    setBusy(true); setMessage(null); setArtifact(null)
    try {
      const result = await window.api.writeHeapSnapshot()
      if (result.ok) setArtifact(result.path)
      setMessage(result.ok ? `Heap snapshot saved to ${result.path}.` : result.error)
    }
    catch { setMessage('Heap snapshot could not be captured.') }
    finally { setBusy(false) }
  }
  return <div className="space-y-5">
    <section className="rounded-slab border border-border bg-canvas p-4 space-y-3"><h2 className="font-medium">Local performance report</h2><p className="text-[11px] leading-5 text-muted">Includes bounded metric rollups, operation histograms, incidents, coverage and build metadata. It contains no prompts, transcript text, paths, DOM, audio, environment variables or stacks. Nothing is uploaded.</p>
      <label className="text-muted">Range <select className="ml-2 rounded-control border border-border bg-canvas p-1 text-ink" value={range} onChange={event => setRange(Number(event.target.value))}><option value={15 * 60_000}>15 minutes</option><option value={24 * 60 * 60_000}>24 hours</option><option value={7 * 24 * 60 * 60_000}>7 days</option></select></label>
      <div className="flex flex-wrap gap-2"><Button size="sm" disabled={busy} onClick={() => void save()}>Save Performance Report</Button><Button size="sm" variant="destructive-outline" disabled={busy || snapshot.history?.exporting} onClick={() => void clear()}>Clear Local History</Button></div>
      <p className="text-[11px] text-muted">{preview ? `${preview.dataClasses.join(', ')} · estimated ${(preview.estimatedBytes / 1024).toFixed(1)} KiB · local file only` : 'Preparing report preview…'}</p>
      <p className="text-[11px] text-muted">{snapshot.history ? `${(snapshot.history.bytes / 1024 / 1024).toFixed(1)} MiB stored · ${snapshot.history.state}${snapshot.history.shortened ? ' · shortened' : ''}` : 'History is warming up.'}</p>
      {message && <p role="status" className="text-[11px] break-all">{message}</p>}
      {artifact && <Button size="sm" variant="ghost" onClick={() => void window.api.revealPath(artifact)}>Reveal Saved File</Button>}
    </section>
    <section className="rounded-slab border border-border p-4 space-y-3"><h2 className="font-medium">Advanced recordings</h2><p className="text-[11px] leading-5 text-muted">Recordings are explicit, app-wide and limited to 30 seconds by default with a 60-second hard maximum and a 64 MiB artifact cap. Chromium traces use argument filtering. CPU profiles and heap snapshots can contain source paths or sensitive application memory; keep them local unless you inspect them first.</p>
      <div className="flex flex-wrap gap-2">{trace?.state === 'recording' || trace?.state === 'starting' || trace?.state === 'stopping' ? <><Button size="sm" disabled={busy || trace.state !== 'recording' || trace.ownerWindowId === null} onClick={() => void stopTrace(false)}>Stop and Save</Button><Button size="sm" variant="destructive-outline" disabled={busy || trace.state === 'stopping' || trace.ownerWindowId === null} onClick={() => void stopTrace(true)}>Cancel Recording</Button></> : <><Button size="sm" disabled={busy} onClick={() => void startTrace('chromium')}>Record Chromium Trace</Button><Button size="sm" variant="outline" disabled={busy} onClick={() => void startTrace('main-cpu')}>Record Main CPU Profile</Button></>}
        <Button size="sm" variant="outline" disabled={busy || trace?.state === 'recording'} onClick={() => void heap()}>Capture Heap Snapshot…</Button>
        {trace?.path && <Button size="sm" variant="ghost" onClick={() => void window.api.revealPath(trace.path!)}>Reveal Recording</Button>}
      </div>
      <p className="text-[11px] text-muted">{trace ? `${trace.mode ?? 'Profiler'} · ${trace.state}${['starting', 'recording', 'stopping'].includes(trace.state) && trace.ownerWindowId === null ? ' · controlled from another window' : ''}${trace.state === 'recording' && trace.endsAt ? ` · up to ${Math.max(0, Math.ceil((trace.endsAt - Date.now()) / 1000))} s remaining` : ''}${trace.bytes !== null ? ` · ${(trace.bytes / 1024 / 1024).toFixed(1)} MiB` : ''}${trace.message ? ` · ${trace.message}` : ''}` : 'Checking profiler capability…'}</p>
    </section>
  </div>
}

function Stat({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <div className="rounded-slab border border-border bg-canvas p-4">
    <div className="text-[11px] text-muted">{label}</div><div className="my-2 text-[23px] font-code tabular-nums text-ink">{value}</div>
    <div className="text-[10px] leading-4 text-muted">{detail}</div>
  </div>
}
function Overview({ snapshot }: { snapshot: MonitorSnapshot }) {
  const main = snapshot.main
  return <div className="space-y-5">
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Stat label="Application CPU" value={number(snapshot.processes?.cpuPercent, '%')} detail="100% means one logical CPU core." />
      <Stat label="Application memory" value={bytes(snapshot.processes?.memoryBytes)} detail="Approximate sum of process RSS; shared pages can be counted more than once." />
      <Stat label="Main event-loop p99" value={number(main?.loopP99Ms, ' ms')} detail="Last completed window; the probe resolution is 20 ms." />
      <Stat label="Main JavaScript heap" value={bytes(main?.heapUsed)} detail={`Heap limit ${bytes(main?.heapLimit)}. Heap is part of process memory.`} />
    </div>
    <div className="grid gap-3 md:grid-cols-2">
      <Series title="Main CPU" points={snapshot.recent} metric="cpuPercent" unit="%" />
      <Series title="Main event-loop peak" points={snapshot.recent} metric="loopMaxMs" unit="ms" />
    </div>
    <section className="rounded-slab border border-border">
      <h2 className="border-b border-border px-3 py-2 font-medium">Windows</h2>
      <div className="overflow-auto"><table className="w-full text-left text-[11px] tabular-nums">
        <thead className="text-muted"><tr>{['Window', 'Visibility', 'Heartbeat age', 'Scheduler lag', 'Long tasks', 'Slow input peak', 'Heap'].map(label => <th className="px-3 py-2 font-normal" key={label}>{label}</th>)}</tr></thead>
        <tbody>{snapshot.windows.map(window => <tr key={window.windowId} className="border-t border-border">
          <td className="px-3 py-2">{window.windowId}</td><td>{window.visibility}</td>
          <td>{number(Math.max(0, Date.now() - window.receivedAt) / 1000, ' s')}</td><td>{number(window.lagMs, ' ms')}</td>
          <td>{window.longTasksSupported ? window.longTaskCount : 'Unsupported'}</td>
          <td>{window.inputSupported ? number(window.inputMaxMs, ' ms') : 'Unsupported'}</td><td>{bytes(window.heapUsedBytes)}</td>
        </tr>)}</tbody>
      </table></div>
      {!snapshot.windows.length && <p className="p-3 text-muted">Waiting for window heartbeats.</p>}
    </section>
    <p className="text-[11px] leading-5 text-muted">Input timing includes browser events above 16 ms, so it is a slow-input indicator. Hidden windows may be throttled. CPU and memory coverage: {snapshot.processes?.quality ?? 'warming-up'} · {snapshot.processes?.count ?? 0} processes · {snapshot.processes?.sessionCount ?? 0} managed sessions. Monitor helper RSS: {bytes(snapshot.workerRss)}.</p>
  </div>
}

function Series({ title, points, metric, unit }: { title: string; points: MonitorMainSample[]; metric: 'cpuPercent' | 'loopMaxMs'; unit: string }) {
  const valid = points.filter(point => point[metric] !== null && !point.sleepGap)
  const peak = valid.length ? Math.max(...valid.map(point => point[metric]!)) : null
  const scale = Math.max(1, peak ?? 0)
  const firstAt = points[0]?.at ?? 0
  const duration = Math.max(1, (points[points.length - 1]?.at ?? firstAt) - firstAt)
  // Separate path segments preserve missing/sleep gaps; connecting across
  // those gaps would imply observations we never collected.
  let penDown = false
  let path = ''
  points.forEach((point, index) => {
    const value = point[metric]
    if (value === null || point.sleepGap) { penDown = false; return }
    if (index > 0 && (point.at - points[index - 1].at > 2500 || point.at < points[index - 1].at)) penDown = false
    path += `${penDown ? 'L' : 'M'}${Math.max(0, Math.min(600, (point.at - firstAt) / duration * 600))},${100 - value / scale * 90} `
    penDown = true
  })
  return <section className="rounded-slab border border-border bg-canvas p-3">
    <div className="flex justify-between"><h2>{title}</h2><span className="text-muted">Peak {number(peak, ` ${unit}`)}</span></div>
    <svg viewBox="0 0 600 112" className="my-2 h-28 w-full text-accent" role="img" aria-label={`${title}, ${valid.length} available samples, peak ${number(peak, unit)}`}>
      <path d="M0 100H600" stroke="currentColor" opacity="0.15" /><path d={path} stroke="currentColor" strokeWidth="2" fill="none" vectorEffect="non-scaling-stroke" />
    </svg>
    <div className="flex justify-between text-[10px] text-muted"><span>{points[0] ? new Date(points[0].at).toLocaleTimeString() : 'Waiting for samples'}</span><span>{points.length ? new Date(points[points.length - 1].at).toLocaleTimeString() : ''}</span></div>
  </section>
}

function Processes() {
  const [page, setPage] = useState<MonitorProcessPage | null>(null)
  const [offset, setOffset] = useState(0)
  const [sort, setSort] = useState<'cpu' | 'memory'>('cpu')
  const [error, setError] = useState(false)
  useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const read = async () => {
      try { const result = await window.api.getMonitorProcesses(offset, sort); if (!disposed) {
        if (result && offset >= result.total && offset > 0) setOffset(Math.max(0, Math.floor((result.total - 1) / 50) * 50))
        setPage(result); setError(result === null)
      } }
      catch { if (!disposed) setError(true) }
      finally { if (!disposed) timer = setTimeout(read, 2000) }
    }
    void read()
    return () => { disposed = true; clearTimeout(timer) }
  }, [offset, sort])
  return <section className="space-y-4">
    <div className="flex items-center justify-between gap-3"><div><h2 className="font-medium">All managed processes</h2><p className="mt-1 text-[11px] text-muted">Includes background and detached agents. Shared helpers are counted once in application totals.</p></div>
      <label className="text-muted">Sort <select className="ml-2 rounded-control border border-border bg-canvas p-1 text-ink" value={sort} onChange={event => { setSort(event.target.value as 'cpu' | 'memory'); setOffset(0) }}><option value="cpu">CPU</option><option value="memory">Memory</option></select></label>
    </div>
    {error && <p role="status" className="text-muted">Process readings delayed.</p>}
    <div className="overflow-auto rounded-slab border border-border"><table className="w-full text-left text-[11px] tabular-nums">
      <thead className="bg-canvas text-muted"><tr>{['Process', 'PID', 'Agent / session', 'CPU', 'Memory (RSS)', 'Coverage'].map(label => <th className="px-3 py-2 font-normal" key={label}>{label}</th>)}</tr></thead>
      <tbody>{page?.rows.map(row => <tr key={row.identity} className="border-t border-border"><td className="px-3 py-2 capitalize">{row.provider ?? row.type}</td><td>{row.pid ?? '—'}</td>
        <td title={row.sessionIds.join(', ')}>{row.sharedSessionCount > 1 ? `Shared by ${row.sharedSessionCount} sessions` : row.sessionIds[0]?.slice(0, 12) ?? 'Application'}</td>
        <td>{number(row.cpuPercent, '%')}</td><td>{bytes(row.memoryBytes)}</td><td>{row.quality}</td></tr>)}</tbody>
    </table></div>
    {!page?.rows.length && <p className="text-muted">Waiting for process discovery. A new process needs two samples for CPU.</p>}
    <div className="flex items-center justify-between text-[11px] text-muted"><span>{page?.summary.quality ?? 'warming-up'} · {page?.total ?? 0} entries · {page?.summary.missingRoots ?? 0} unavailable roots{page?.summary.truncated ? ' · capacity reached' : ''}</span><div className="flex items-center gap-3"><Button size="sm" variant="ghost" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 50))}>Previous</Button><span>{page?.total ? offset + 1 : 0}–{Math.min(offset + 50, page?.total ?? 0)}</span><Button size="sm" variant="ghost" disabled={offset + 50 >= (page?.total ?? 0)} onClick={() => setOffset(offset + 50)}>Next</Button></div></div>
  </section>
}

function Operations({ snapshot }: { snapshot: MonitorSnapshot }) {
  const rows = useMemo(() => [...snapshot.operations].sort((a, b) => b.histogram.maxMs - a.histogram.maxMs), [snapshot.operations])
  return <section className="space-y-3"><h2 className="font-medium">Operation latency</h2><p className="text-[11px] text-muted">Percentiles are histogram bucket upper bounds. Sample counts and outcomes keep slow failures visible. Provider and first-output durations include waiting; transcript.commit ends at React layout commit, before paint.</p>
    {!rows.length ? <p className="text-muted">No operations recorded in this run.</p> : <table className="w-full text-left text-[11px] tabular-nums"><thead className="text-muted"><tr>{['Operation', 'Outcome', 'Count', 'p50', 'p95', 'p99', 'Maximum'].map(label => <th className="py-2 font-normal" key={label}>{label}</th>)}</tr></thead><tbody>{rows.map(row => <tr className="border-t border-border" key={`${row.name}:${row.outcome}`}><td className="py-2">{row.name}</td><td>{row.outcome}</td><td>{row.histogram.count.toLocaleString()}</td>{[0.5, 0.95, 0.99].map(q => { const value = latencyQuantile(row.histogram, q); return <td key={q}>{value?.overflow ? '>60 s' : number(value?.upperBoundMs, ' ms')}</td> })}<td>{number(row.histogram.maxMs, ' ms')}</td></tr>)}</tbody></table>}
  </section>
}
