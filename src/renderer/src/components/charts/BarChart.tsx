import { useId, useState } from 'react'
import type { KeyboardEvent, PointerEvent } from 'react'
import { niceCeiling, valueTicks } from './chartMath'
import { useElementWidth } from './useElementWidth'

export type BarSeries = { id: string; label: string; colorClass: string }
export type BarDatum = { key: string; heading: string; tick: string; values: number[] }

type Props = {
  label: string
  /** Series drawn front to back: later series paint INSIDE earlier ones. Meant
   * for nested quantities (agent-hours always contain their wall-clock union),
   * so both read from one bar instead of two thin side-by-side columns. */
  series: BarSeries[]
  bars: BarDatum[]
  formatValue: (value: number) => string
  height?: number
}

const MARGIN = { top: 10, right: 8, bottom: 20, left: 44 }

/**
 * Category bars with a labelled axis, a hover/keyboard readout of every
 * series, and tick labels thinned to what fits.
 *
 * WHY this replaced per-bar SVG <title>: native titles appear after a delay,
 * cannot be reached from the keyboard, and showed nothing on the axis, so a
 * bar's height meant nothing until you waited on it.
 */
export function BarChart({ label, series, bars, formatValue, height = 140 }: Props) {
  const { ref, width } = useElementWidth<HTMLDivElement>()
  const readoutId = useId()
  const [active, setActive] = useState<number | null>(null)
  const plotWidth = Math.max(10, width - MARGIN.left - MARGIN.right)
  const plotHeight = Math.max(10, height - MARGIN.top - MARGIN.bottom)
  const ceiling = niceCeiling(Math.max(0, ...bars.flatMap(bar => bar.values)))
  const slot = plotWidth / Math.max(1, bars.length)
  const barWidth = Math.max(1, Math.min(28, slot * 0.72))
  const y = (value: number) => MARGIN.top + plotHeight - Math.min(1, value / ceiling) * plotHeight
  // Thin labels to roughly one per 56 px so dates never overprint.
  const labelEvery = Math.max(1, Math.ceil(56 / slot))

  const onPointer = (event: PointerEvent<SVGSVGElement>) => {
    const px = event.clientX - event.currentTarget.getBoundingClientRect().left - MARGIN.left
    const index = Math.floor(px / slot)
    setActive(index >= 0 && index < bars.length ? index : null)
  }
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!bars.length) return
    const next = event.key === 'ArrowLeft' ? Math.max(0, (active ?? bars.length) - 1)
      : event.key === 'ArrowRight' ? Math.min(bars.length - 1, active === null ? bars.length - 1 : active + 1)
        : event.key === 'Home' ? 0 : event.key === 'End' ? bars.length - 1 : null
    if (event.key === 'Escape') { setActive(null); return }
    if (next === null) return
    event.preventDefault()
    setActive(next)
  }
  const bar = active === null ? null : bars[active] ?? null
  const center = active === null ? 0 : MARGIN.left + slot * active + slot / 2
  const flip = center > width * 0.6

  return (
    <div ref={ref} className="relative rounded-control outline-none focus-visible:ring-1 focus-visible:ring-focus-ring" tabIndex={0} role="group"
      aria-label={`${label}. Use left and right arrow keys to read values.`} aria-describedby={readoutId} onKeyDown={onKey} onBlur={() => setActive(null)}>
      <svg width={width} height={height} className="block select-none" onPointerMove={onPointer} onPointerLeave={() => setActive(null)} aria-hidden="true">
        {valueTicks(ceiling).map(tick => (
          <g key={tick}>
            <line x1={MARGIN.left} x2={MARGIN.left + plotWidth} y1={y(tick)} y2={y(tick)} className="stroke-border" strokeDasharray={tick === 0 ? undefined : '2 3'} />
            <text x={MARGIN.left - 6} y={y(tick)} dy="0.32em" textAnchor="end" className="fill-muted text-[9px] tabular-nums">{formatValue(tick)}</text>
          </g>
        ))}
        {bars.map((datum, index) => {
          const left = MARGIN.left + slot * index + (slot - barWidth) / 2
          return (
            <g key={datum.key} opacity={active === null || active === index ? 1 : 0.55}>
              {series.map((item, seriesIndex) => {
                const value = datum.values[seriesIndex] ?? 0
                const inset = seriesIndex * Math.min(3, barWidth / 6)
                return value > 0 ? (
                  <rect key={item.id} x={left + inset} width={Math.max(1, barWidth - inset * 2)} y={y(value)} height={Math.max(1, MARGIN.top + plotHeight - y(value))} rx={1}
                    className={item.colorClass} fill="currentColor" fillOpacity={seriesIndex === 0 ? 0.45 : 0.95} />
                ) : null
              })}
              {index % labelEvery === 0 ? <text x={left + barWidth / 2} y={height - 5} textAnchor="middle" className="fill-muted text-[9px]">{datum.tick}</text> : null}
            </g>
          )
        })}
      </svg>
      {bar && (
        <div className="pointer-events-none absolute z-10 min-w-[150px] rounded-control border border-popover-border bg-popover-bg px-2 py-1.5 text-[10px] shadow-[0_8px_24px_var(--theme-shadow-color)]"
          style={{ top: MARGIN.top, ...(flip ? { right: width - center + 10 } : { left: center + 10 }) }}>
          <div className="mb-1 text-muted">{bar.heading}</div>
          {series.map((item, index) => (
            <div key={item.id} className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-1.5 text-ink-dim"><span className={`inline-block size-2 rounded-full bg-current ${item.colorClass}`} />{item.label}</span>
              <span className="tabular-nums text-ink">{formatValue(bar.values[index] ?? 0)}</span>
            </div>
          ))}
        </div>
      )}
      <div id={readoutId} className="sr-only" aria-live="polite">
        {bar ? `${bar.heading}: ${series.map((item, index) => `${item.label} ${formatValue(bar.values[index] ?? 0)}`).join(', ')}` : ''}
      </div>
    </div>
  )
}
