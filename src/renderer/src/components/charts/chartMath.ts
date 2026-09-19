// Pure geometry for the app's charts. Kept free of React and the DOM so the
// rules that decide what a chart claims (where a gap is, which sample the
// cursor means, what the axis says) are unit-testable in the node project.

export type ChartPoint = { at: number; value: number | null }

/** Round an axis maximum up to 1, 2, 2.5 or 5 × 10^n.
 *
 * WHY never auto-fit to the data maximum: the old monitor scaled every line to
 * its own peak, so a calm 15 ms loop and an 1,800 ms stall drew the same shape.
 * A readable ceiling plus labelled ticks is what makes height mean something. */
export function niceCeiling(max: number): number {
  if (!Number.isFinite(max) || max <= 0) return 1
  const magnitude = 10 ** Math.floor(Math.log10(max))
  for (const step of [1, 2, 2.5, 5, 10]) if (max <= step * magnitude) return step * magnitude
  return 10 * magnitude
}

/** Evenly spaced ticks from 0 to a nice ceiling that covers `max`. */
export function valueTicks(max: number, count = 4): number[] {
  const ceiling = niceCeiling(max)
  return Array.from({ length: count + 1 }, (_, index) => ceiling * index / count)
}

const TIME_STEPS = [1000, 5000, 15_000, 30_000, 60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000, 3_600_000, 3 * 3_600_000, 6 * 3_600_000, 12 * 3_600_000, 86_400_000]

/** Wall-aligned time ticks (on the minute, the hour, midnight) so labels read
 * as times a person would say, not arbitrary offsets from the range start. */
export function timeTicks(from: number, to: number, count = 5): number[] {
  if (!(to > from)) return []
  const ideal = (to - from) / count
  const step = TIME_STEPS.find(candidate => candidate >= ideal) ?? Math.ceil(ideal / 86_400_000) * 86_400_000
  // Align to local time, not UTC: a daily tick at UTC midnight is mid-afternoon
  // somewhere, which is exactly the confusion wall alignment exists to avoid.
  const offset = new Date(from).getTimezoneOffset() * 60_000
  const ticks: number[] = []
  for (let at = Math.ceil((from - offset) / step) * step + offset; at <= to; at += step) ticks.push(at)
  return ticks
}

export function formatTimeTick(at: number, spanMs: number): string {
  const date = new Date(at)
  if (spanMs > 2 * 86_400_000) return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  return date.toLocaleTimeString(undefined, spanMs > 10 * 60_000 ? { hour: '2-digit', minute: '2-digit' } : { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

/** Index of the sample nearest `at` in an ascending list; -1 when empty. */
export function nearestIndex(ats: readonly number[], at: number): number {
  if (!ats.length) return -1
  let low = 0
  let high = ats.length - 1
  while (low < high) {
    const middle = (low + high) >> 1
    if (ats[middle]! < at) low = middle + 1
    else high = middle
  }
  if (low > 0 && Math.abs(ats[low - 1]! - at) <= Math.abs(ats[low]! - at)) return low - 1
  return low
}

/** Split a series into drawable runs.
 *
 * WHY breaks instead of one line: a missing reading, a sleep gap or a helper
 * restart is an interval nobody observed. Drawing straight through it invents
 * data. A run breaks at null values and wherever consecutive samples are
 * further apart than `maxGapMs`. */
export function contiguousRuns(points: readonly ChartPoint[], maxGapMs: number): Array<Array<{ at: number; value: number }>> {
  const runs: Array<Array<{ at: number; value: number }>> = []
  let current: Array<{ at: number; value: number }> = []
  let previousAt: number | null = null
  for (const point of points) {
    const broken = previousAt !== null && (point.at <= previousAt || point.at - previousAt > maxGapMs)
    if (point.value === null || broken) { if (current.length) runs.push(current); current = [] }
    if (point.value !== null) current.push({ at: point.at, value: point.value })
    previousAt = point.at
  }
  if (current.length) runs.push(current)
  return runs
}

/** Typical spacing between samples, used to decide what counts as a gap. The
 * median resists the very gaps it is used to detect. */
export function typicalStep(ats: readonly number[]): number {
  const steps: number[] = []
  for (let index = 1; index < ats.length; index++) if (ats[index]! > ats[index - 1]!) steps.push(ats[index]! - ats[index - 1]!)
  if (!steps.length) return 0
  steps.sort((a, b) => a - b)
  return steps[steps.length >> 1]!
}
