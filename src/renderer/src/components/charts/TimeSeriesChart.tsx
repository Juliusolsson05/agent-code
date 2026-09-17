import { useId, useMemo, useState } from 'react'
import type { KeyboardEvent, PointerEvent } from 'react'
import { contiguousRuns, formatTimeTick, nearestIndex, niceCeiling, timeTicks, typicalStep, valueTicks } from './chartMath'
import type { ChartPoint } from './chartMath'
import { useElementWidth } from './useElementWidth'

export type TimeSeries = {
  id: string
  label: string
  /** A text-color utility (e.g. `text-accent`). Marks paint with currentColor
   * so every series follows the theme tokens instead of hard-coded hex. */
  colorClass: string
  points: ChartPoint[]
}
export type ChartThreshold = { value: number; label: string; tone: 'warning' | 'danger' }
export type ChartMarker = { key: string; at: number; label: string; tone: 'warning' | 'danger'; onSelect?: () => void }

type Props = {
  /** Accessible name; also prefixes the keyboard readout. */
  label: string
  series: TimeSeries[]
  from: number
  to: number
  formatValue: (value: number) => string
  mode?: 'line' | 'stacked'
  height?: number
  /** Lowest axis ceiling. Keeps a quiet series from being magnified into
   * something that looks alarming (a 3 ms loop drawn full height). */
  minCeiling?: number
  thresholds?: ChartThreshold[]
  markers?: ChartMarker[]
  /** Controlled hover time, so charts sharing an x-axis move one crosshair. */
  hoverAt?: number | null
  onHoverAt?: (at: number | null) => void
  emptyLabel?: string
}

const MARGIN = { top: 12, right: 12, bottom: 22, left: 52 }
const TONE_STROKE = { warning: 'stroke-warning', danger: 'stroke-danger' } as const
const TONE_FILL = { warning: 'fill-warning', danger: 'fill-danger' } as const

/**
 * Interactive time-series chart: axes with real units, a crosshair that reads
 * every series at one instant, threshold lines, incident markers and full
 * keyboard access.
 *
 * WHY hand-rolled instead of a chart library: the app needs lines, stacked
 * areas, markers and a crosshair, all painted from the theme tokens. A library
 * would bring its own styling and tooltip model to fight, for a feature set
 * this small. Shared by the Performance Monitor and Agent Analytics so both
 * behave the same way.
 */
export function TimeSeriesChart({
  label, series, from, to, formatValue, mode = 'line', height = 160, minCeiling = 0,
  thresholds = [], markers = [], hoverAt, onHoverAt, emptyLabel = 'No data in this range',
}: Props) {
  const { ref, width } = useElementWidth<HTMLDivElement>()
  const readoutId = useId()
  const [localHover, setLocalHover] = useState<number | null>(null)
  const hover = hoverAt !== undefined ? hoverAt : localHover
  const setHover = (at: number | null) => { if (onHoverAt) onHoverAt(at); else setLocalHover(at) }

  const plotWidth = Math.max(10, width - MARGIN.left - MARGIN.right)
  const plotHeight = Math.max(10, height - MARGIN.top - MARGIN.bottom)
  const span = Math.max(1, to - from)

  // Every sample time across series, ascending. The crosshair snaps to a real
  // sample so the tooltip never shows an interpolated value nobody measured.
  const times = useMemo(() => [...new Set(series.flatMap(item => item.points.map(point => point.at)))].sort((a, b) => a - b), [series])
  const maxGap = Math.max(typicalStep(times) * 3, span / 100)

  // Stacked areas add series in order; a missing reading contributes zero to
  // the stack but still breaks that series' own run below.
  const stacked = useMemo(() => {
    if (mode !== 'stacked') return null
    const totals = new Map<number, number>()
    return series.map(item => item.points.map(point => {
      const base = totals.get(point.at) ?? 0
      const top = base + (point.value ?? 0)
      totals.set(point.at, top)
      return { at: point.at, base, top, value: point.value }
    }))
  }, [mode, series])

  const dataMax = useMemo(() => {
    if (stacked) return Math.max(0, ...stacked.flatMap(item => item.map(point => point.top)))
    return Math.max(0, ...series.flatMap(item => item.points.map(point => point.value ?? 0)))
  }, [series, stacked])
  const ceiling = niceCeiling(Math.max(dataMax, minCeiling))
  const x = (at: number) => MARGIN.left + (at - from) / span * plotWidth
  const y = (value: number) => MARGIN.top + plotHeight - Math.min(1, value / ceiling) * plotHeight

  const hoverIndex = hover === null ? -1 : nearestIndex(times, hover)
  const snapped = hoverIndex >= 0 ? times[hoverIndex]! : null
  const readings = snapped === null ? [] : series.map((item, index) => {
    const point = item.points.find(candidate => candidate.at === snapped)
    const value = point?.value ?? null
    // No reading means no dot. In a stacked chart the layer's top at a missing
    // reading equals its base, and a dot there would claim a zero was measured.
    return { item, value, top: value === null ? null : stacked?.[index]?.find(candidate => candidate.at === snapped)?.top ?? value }
  })
  const total = mode === 'stacked' ? readings.reduce((sum, reading) => sum + (reading.value ?? 0), 0) : null

  const onPointer = (event: PointerEvent<SVGSVGElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect()
    const px = event.clientX - bounds.left
    if (px < MARGIN.left || px > MARGIN.left + plotWidth) return
    setHover(from + (px - MARGIN.left) / plotWidth * span)
  }
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!times.length) return
    const current = hoverIndex < 0 ? times.length : hoverIndex
    const step = event.shiftKey ? 10 : 1
    const next = event.key === 'ArrowLeft' ? Math.max(0, current - step)
      : event.key === 'ArrowRight' ? Math.min(times.length - 1, hoverIndex < 0 ? times.length - 1 : current + step)
        : event.key === 'Home' ? 0 : event.key === 'End' ? times.length - 1 : null
    if (event.key === 'Escape') { setHover(null); return }
    if (next === null) return
    event.preventDefault()
    setHover(times[next]!)
  }

  const readout = snapped === null ? '' : `${label} at ${new Date(snapped).toLocaleTimeString()}: ${readings.map(reading => `${reading.item.label} ${reading.value === null ? 'no reading' : formatValue(reading.value)}`).join(', ')}${total !== null ? `, total ${formatValue(total)}` : ''}`
  const tooltipLeft = snapped === null ? 0 : x(snapped)
  const flip = tooltipLeft > width * 0.6

  return (
    <div
      ref={ref}
      className="relative outline-none focus-visible:ring-1 focus-visible:ring-focus-ring rounded-control"
      tabIndex={0}
      role="group"
      aria-label={`${label}. Use left and right arrow keys to read values.`}
      aria-describedby={readoutId}
      onKeyDown={onKey}
      onBlur={() => setHover(null)}
    >
      <svg width={width} height={height} className="block select-none" onPointerMove={onPointer} onPointerLeave={() => setHover(null)} aria-hidden="true">
        {valueTicks(ceiling).map(tick => (
          <g key={tick}>
            <line x1={MARGIN.left} x2={MARGIN.left + plotWidth} y1={y(tick)} y2={y(tick)} className="stroke-border" strokeDasharray={tick === 0 ? undefined : '2 3'} />
            <text x={MARGIN.left - 6} y={y(tick)} dy="0.32em" textAnchor="end" className="fill-muted text-[9px] tabular-nums">{formatValue(tick)}</text>
          </g>
        ))}
        {timeTicks(from, to, Math.max(2, Math.floor(plotWidth / 110))).map(tick => (
          <text key={tick} x={x(tick)} y={height - 6} textAnchor="middle" className="fill-muted text-[9px] tabular-nums">{formatTimeTick(tick, span)}</text>
        ))}
        {thresholds.filter(threshold => threshold.value <= ceiling).map(threshold => (
          <g key={threshold.label}>
            <line x1={MARGIN.left} x2={MARGIN.left + plotWidth} y1={y(threshold.value)} y2={y(threshold.value)} className={TONE_STROKE[threshold.tone]} strokeDasharray="5 4" opacity={0.7} />
            <text x={MARGIN.left + plotWidth - 2} y={y(threshold.value) - 3} textAnchor="end" className={`${TONE_FILL[threshold.tone]} text-[9px]`}>{threshold.label}</text>
          </g>
        ))}
        {!times.length ? (
          <text x={MARGIN.left + plotWidth / 2} y={MARGIN.top + plotHeight / 2} textAnchor="middle" className="fill-muted text-[11px]">{emptyLabel}</text>
        ) : series.map((item, index) => {
          const layer = stacked?.[index]
          if (layer) {
            const runs = contiguousRuns(layer.map(point => ({ at: point.at, value: point.value === null ? null : point.top })), maxGap)
            return (
              <g key={item.id} className={item.colorClass}>
                {runs.map(run => {
                  const bases = new Map(layer.map(point => [point.at, point.base]))
                  const top = run.map(point => `${x(point.at)},${y(point.value)}`).join(' L')
                  const bottom = [...run].reverse().map(point => `${x(point.at)},${y(bases.get(point.at) ?? 0)}`).join(' L')
                  return <path key={run[0]!.at} d={`M${top} L${bottom} Z`} fill="currentColor" fillOpacity={0.35} stroke="currentColor" strokeWidth={1} />
                })}
              </g>
            )
          }
          return (
            <g key={item.id} className={item.colorClass}>
              {contiguousRuns(item.points, maxGap).map(run => run.length === 1
                ? <circle key={run[0]!.at} cx={x(run[0]!.at)} cy={y(run[0]!.value)} r={1.5} fill="currentColor" />
                : <path key={run[0]!.at} d={`M${run.map(point => `${x(point.at)},${y(point.value)}`).join(' L')}`} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" />)}
            </g>
          )
        })}
        {markers.filter(marker => marker.at >= from && marker.at <= to).map(marker => (
          <g key={marker.key} className={`${TONE_FILL[marker.tone]} ${marker.onSelect ? 'cursor-pointer' : ''}`} onClick={marker.onSelect}>
            <line x1={x(marker.at)} x2={x(marker.at)} y1={MARGIN.top} y2={MARGIN.top + plotHeight} className={TONE_STROKE[marker.tone]} opacity={0.35} />
            <path d={`M${x(marker.at) - 4},${MARGIN.top - 8} L${x(marker.at) + 4},${MARGIN.top - 8} L${x(marker.at)},${MARGIN.top - 1} Z`}><title>{marker.label}</title></path>
          </g>
        ))}
        {snapped !== null && (
          <g>
            <line x1={x(snapped)} x2={x(snapped)} y1={MARGIN.top} y2={MARGIN.top + plotHeight} className="stroke-ink-dim" strokeWidth={1} />
            {readings.map(reading => reading.top === null ? null : (
              <circle key={reading.item.id} cx={x(snapped)} cy={y(reading.top)} r={3} className={reading.item.colorClass} fill="currentColor" stroke="var(--color-surface)" strokeWidth={1.5} />
            ))}
          </g>
        )}
      </svg>
      {snapped !== null && (
        <div
          className="pointer-events-none absolute z-10 min-w-[140px] rounded-control border border-popover-border bg-popover-bg px-2 py-1.5 text-[10px] shadow-lg"
          style={{ top: MARGIN.top, ...(flip ? { right: width - tooltipLeft + 8 } : { left: tooltipLeft + 8 }) }}
        >
          <div className="mb-1 text-muted tabular-nums">{new Date(snapped).toLocaleString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', month: span > 86_400_000 ? 'short' : undefined, day: span > 86_400_000 ? 'numeric' : undefined })}</div>
          {readings.map(reading => (
            <div key={reading.item.id} className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-1.5 text-ink-dim"><span className={`inline-block size-2 rounded-full bg-current ${reading.item.colorClass}`} />{reading.item.label}</span>
              <span className="tabular-nums text-ink">{reading.value === null ? '—' : formatValue(reading.value)}</span>
            </div>
          ))}
          {total !== null && <div className="mt-1 flex justify-between gap-3 border-t border-border pt-1"><span className="text-muted">Total</span><span className="tabular-nums text-ink">{formatValue(total)}</span></div>}
        </div>
      )}
      <div id={readoutId} className="sr-only" aria-live="polite">{readout}</div>
    </div>
  )
}
