import { useEffect, useMemo, useState } from 'react'

import type {
  DevDebugModule,
  DevDebugModuleProps,
} from '@renderer/features/debug/devModules/types'
import { buildFingerprintIndex } from '@renderer/rendering/evidence/catalogCoverage'
import { ALL_RENDER_SHAPE_CATALOGS } from '@providers/registry.renderShapes'
import {
  isRenderShapeCaptureArmed,
  renderShapeObserverStats,
} from '@renderer/features/feed/evidence/observer'
import {
  buildUnknownShapeReport,
  type UnknownShapeReport,
} from '@renderer/features/debug/devModules/RenderingShapes/unknownShapeReport'

// Unknown Shape Inbox — Phase 3 Dev Debug module (PR #555).
//
// DERIVED, NOT STORED: every open re-derives the report from the on-disk
// recording sidecars (render-shape:read-sightings sweep) plus the compiled
// catalogs. Restart-survival is free because the recordings are the
// database; there is no cache to invalidate and nothing to migrate.
//
// A simple table on purpose — dev modules are investigation surfaces, not
// product screens (devModules/types.ts contract). The high-value output is
// buildCopyText: a paste-ready block for an issue or the next agent session,
// which is the actual consumption path for inbox findings.

function StatusChip({ status }: { status: string }) {
  const tone =
    status === 'unknown-structure' || status === 'unknown-outcome'
      ? 'text-red-400'
      : status === 'known-claimed'
        ? 'text-muted'
        : 'text-amber-400'
  return <span className={`${tone} text-[11px] uppercase tracking-wider`}>{status}</span>
}

let lastReport: UnknownShapeReport | null = null

function useShapeReport(): {
  report: UnknownShapeReport | null
  error: string | null
  truncated: boolean
  refresh: () => void
} {
  const [state, setState] = useState<{
    report: UnknownShapeReport | null
    error: string | null
    truncated: boolean
  }>({ report: lastReport, error: null, truncated: false })
  // Manual refresh, not polling (review finding: the one-shot mount read
  // made the "live" inbox stale forever). The report is a disk sweep — a
  // human-triggered re-read matches how the module is actually used and
  // keeps the main process out of a polling loop.
  const [epoch, setEpoch] = useState(0)
  const index = useMemo(() => buildFingerprintIndex(ALL_RENDER_SHAPE_CATALOGS), [])
  useEffect(() => {
    let cancelled = false
    void window.api
      .readRenderShapeSightings()
      .then(sweep => {
        if (cancelled) return
        const report = buildUnknownShapeReport(sweep.sightings, index)
        lastReport = report
        setState({ report, error: null, truncated: sweep.truncated })
      })
      .catch(err => {
        if (cancelled) return
        setState({ report: null, error: err instanceof Error ? err.message : String(err), truncated: false })
      })
    return () => {
      cancelled = true
    }
  }, [index, epoch])
  return { ...state, refresh: () => setEpoch(e => e + 1) }
}

function RenderingShapesPanel({ sessionId }: DevDebugModuleProps) {
  const { report, error, truncated, refresh } = useShapeReport()
  const stats = renderShapeObserverStats()
  const armed = isRenderShapeCaptureArmed(sessionId)
  return (
    <div className="flex flex-col gap-2 text-[12px]">
      <div className="text-muted flex items-center gap-2">
        <span>
          capture {armed ? 'ARMED' : 'off'} for this pane · armed sessions {stats.armedSessions} ·
          dropped {stats.droppedQueue + stats.droppedKeys} · swallowed failures {stats.failures}
          {truncated ? ' · sweep truncated (old recordings skipped)' : ''}
        </span>
        <button
          type="button"
          className="border border-current/30 rounded-control px-1.5 py-0.5 text-[11px] hover:bg-current/10"
          onClick={refresh}
        >
          refresh
        </button>
      </div>
      {error ? <div className="text-red-400">sweep failed: {error}</div> : null}
      {!report ? (
        <div className="text-muted italic">no sightings yet — toggle Session Recording on an agent pane and use it</div>
      ) : (
        <>
          <div className="text-muted">
            {report.inbox.length} inbox / {report.rows.length} shapes · {report.totalSightings} sightings
            {report.malformedSightings > 0 ? ` · ${report.malformedSightings} MALFORMED/non-v1` : ''}
            {report.legacySightings > 0 ? ` · ${report.legacySightings} legacy v1 (recapture)` : ''}
          </div>
          <div className="max-h-[420px] overflow-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="text-muted">
                  <th className="pr-2">status</th>
                  <th className="pr-2">provider</th>
                  <th className="pr-2">event</th>
                  <th className="pr-2">fingerprint</th>
                  <th className="pr-2">catalog id</th>
                  <th>count</th>
                </tr>
              </thead>
              <tbody>
                {report.rows.slice(0, 200).map(row => (
                  <tr key={`${row.provider}-${row.structuralFingerprint}`} title={row.shapePaths.join('\n')}>
                    <td className="pr-2"><StatusChip status={row.status} /></td>
                    <td className="pr-2">{row.provider}</td>
                    <td className="pr-2">{row.eventTypes.join(',')}</td>
                    <td className="pr-2 font-mono">{row.structuralFingerprint}</td>
                    <td className="pr-2">{row.catalogShapeId ?? '—'}</td>
                    <td>{row.totalCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}

export const renderingShapesModule: DevDebugModule = {
  id: 'rendering-shapes',
  title: 'Rendering Shapes',
  description:
    'Unknown Shape Inbox — structural shapes observed during capture vs the provider catalogs',
  buildCopyText: (_props, mode) => {
    const report = lastReport
    if (!report) return 'rendering-shapes: no report loaded (open the module first)'
    const rows = mode === 'useful' ? report.inbox : report.rows
    return [
      `rendering-shapes report — ${report.rows.length} shapes, ${report.totalSightings} sightings, ${report.inbox.length} inbox, ${report.malformedSightings} malformed, ${report.legacySightings} legacy-v1`,
      ...rows.map(
        r =>
          `${r.status} ${r.provider} ${r.structuralFingerprint} events=${r.eventTypes.join(',')} planes=${r.planes.join(',')} lifecycles=${r.lifecycles.join(',')} count=${r.totalCount} catalog=${r.catalogShapeId ?? '-'}\n  paths: ${r.shapePaths.slice(0, 16).join(' ')}`,
      ),
    ].join('\n')
  },
  Component: RenderingShapesPanel,
}
