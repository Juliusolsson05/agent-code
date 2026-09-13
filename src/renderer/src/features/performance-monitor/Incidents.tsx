import { useEffect, useState } from 'react'
import { Button } from '@renderer/components/ui/button'
import type { MonitorIncident, MonitorIncidentSummary } from '@shared/performance/monitorIncidents.js'
import { INCIDENT_EXPLANATIONS } from '@shared/performance/monitorIncidents.js'

const readLiveIncident = (incident: MonitorIncidentSummary): Promise<MonitorIncident | null> => window.api.getMonitorIncident(incident.id)

export function Incidents({ incidents, readIncident = readLiveIncident }: {
  incidents: MonitorIncidentSummary[]
  readIncident?: (incident: MonitorIncidentSummary) => Promise<MonitorIncident | null>
}) {
  const [selected, setSelected] = useState<MonitorIncidentSummary | null>(null)
  const [detail, setDetail] = useState<MonitorIncident | null>(null)
  const [loading, setLoading] = useState(false)
  const [revision, setRevision] = useState(0)
  const [offset, setOffset] = useState(0)
  useEffect(() => {
    if (selected && !incidents.some(incident => incident.id === selected.id && incident.at === selected.at)) {
      setSelected(null)
      setDetail(null)
    }
  }, [incidents, selected])
  useEffect(() => {
    if (selected === null) return
    let disposed = false
    setLoading(true); setDetail(null); setOffset(0)
    void readIncident(selected).then(result => { if (!disposed) setDetail(result) })
      .catch(() => {}).finally(() => { if (!disposed) setLoading(false) })
    return () => { disposed = true }
  }, [readIncident, revision, selected])
  if (!incidents.length) return <p className="text-muted">No incidents detected in the available history. Missing or dropped samples may limit coverage.</p>
  return <div className="grid gap-4 md:grid-cols-[260px_minmax(0,1fr)]">
    <div className="space-y-2" aria-label="Detected incidents">{[...incidents].reverse().map(incident => <button key={`${incident.at}:${incident.id}`} className={`block w-full rounded-slab border p-3 text-left ${selected?.at === incident.at && selected.id === incident.id ? 'border-accent bg-accent/5' : 'border-border bg-canvas'}`} onClick={() => setSelected(incident)}>
      <div className="font-medium capitalize">{incident.rule.replace(/-/g, ' ')}</div>
      <div className="mt-1 text-[11px] text-muted">{new Date(incident.at).toLocaleTimeString()} · {incident.severity} · {incident.scope ? `Window ${incident.scope}` : 'Application'}</div>
      <div className="mt-1 text-[10px] text-muted">{incident.state}{incident.truncated ? ' · partial evidence' : ''}</div>
    </button>)}</div>
    <div className="min-w-0 space-y-3">{loading ? <p role="status">Loading evidence…</p> : !detail ? <p className="text-muted">{selected ? 'Evidence is unavailable or another query is active.' : 'Select an incident to inspect its evidence.'}</p> : <>
      <h2 className="font-medium capitalize">{detail.rule.replace(/-/g, ' ')}</h2>
      <p className="leading-5">{INCIDENT_EXPLANATIONS[detail.rule]}</p>
      <p className="text-[11px] text-muted">Rule v{detail.ruleVersion} · observed {detail.observed.toFixed(2)} · threshold {detail.threshold}{detail.rule === 'memory-pressure' ? ' of heap limit' : detail.rule === 'monitoring-loss' ? ' record' : ' ms'}{detail.operation ? ` · ${detail.operation}` : ''}</p>
      <p className="text-[11px] text-muted">Up to 60 seconds before and 15 seconds after detection. {detail.state === 'capturing' ? 'Post-event evidence is still collecting.' : detail.state === 'interrupted' ? 'Capture ended before the post-event interval completed.' : 'Capture completed.'}{detail.truncated ? ' Capacity limited the retained context.' : ''} No stack or content was captured.</p>
      <div className="overflow-auto rounded-slab border border-border"><table className="w-full text-left text-[11px] tabular-nums"><thead className="text-muted"><tr>{['Time', 'Source', 'Delay (ms)', 'CPU (%)', 'Heap (%)'].map(label => <th key={label} className="p-2 font-normal">{label}</th>)}</tr></thead><tbody>{detail.evidence.slice(offset, offset + 40).map((point, index) => <tr key={index} className="border-t border-border"><td className="p-2">{new Date(point.at).toLocaleTimeString()}</td><td>{point.kind}{point.sleepGap ? ' · sleep gap' : ''}</td><td>{point.value?.toFixed(1) ?? '—'}</td><td>{point.cpuPercent?.toFixed(1) ?? '—'}</td><td>{point.heapRatio === null ? '—' : (point.heapRatio * 100).toFixed(1)}</td></tr>)}</tbody></table></div>
      <div className="flex gap-3"><Button size="sm" variant="ghost" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 40))}>Previous evidence</Button><Button size="sm" variant="ghost" disabled={offset + 40 >= detail.evidence.length} onClick={() => setOffset(offset + 40)}>Next evidence</Button></div>
    </>}{selected && <Button size="sm" variant="outline" disabled={loading} onClick={() => setRevision(revision + 1)}>Refresh evidence</Button>}</div>
  </div>
}
