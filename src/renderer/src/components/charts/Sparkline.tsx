import { contiguousRuns, niceCeiling, typicalStep } from './chartMath'
import type { ChartPoint } from './chartMath'

/** A trend glyph for table rows: shape only, no axes.
 *
 * WHY it shares the row's fixed ceiling instead of scaling to its own peak: in
 * a ranked list, a sparkline scaled per row makes a 40 MB agent that grew by
 * 2 MB look exactly like a 6 GB agent that doubled. Callers pass the list-wide
 * `ceiling` so heights compare across rows; `title` carries the numbers. */
export function Sparkline({ points, from, to, ceiling, colorClass = 'text-accent', width = 96, height = 22, title }: {
  points: ChartPoint[]
  from: number
  to: number
  ceiling?: number
  colorClass?: string
  width?: number
  height?: number
  title?: string
}) {
  const span = Math.max(1, to - from)
  const top = niceCeiling(ceiling ?? Math.max(0, ...points.map(point => point.value ?? 0)))
  const x = (at: number) => (at - from) / span * width
  const y = (value: number) => height - 1 - Math.min(1, value / top) * (height - 2)
  const runs = contiguousRuns(points, Math.max(typicalStep(points.map(point => point.at)) * 3, span / 60))
  return (
    <svg width={width} height={height} className={`block ${colorClass}`} role="img" aria-label={title ?? 'Trend'}>
      {title ? <title>{title}</title> : null}
      {runs.map(run => run.length === 1
        ? <circle key={run[0]!.at} cx={x(run[0]!.at)} cy={y(run[0]!.value)} r={1.25} fill="currentColor" />
        : <path key={run[0]!.at} d={`M${run.map(point => `${x(point.at)},${y(point.value)}`).join(' L')}`} fill="none" stroke="currentColor" strokeWidth={1.25} />)}
    </svg>
  )
}
