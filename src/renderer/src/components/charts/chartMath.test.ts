import { describe, expect, it } from 'vitest'
import { contiguousRuns, nearestIndex, niceCeiling, timeTicks, typicalStep, valueTicks } from './chartMath'

describe('chart geometry', () => {
  it('rounds axis ceilings to readable values instead of fitting the peak', () => {
    expect([0, 0.3, 1, 1.2, 18, 250, 1800, 7_300_000_000].map(niceCeiling)).toEqual([1, 0.5, 1, 2, 20, 250, 2000, 10_000_000_000])
    expect(valueTicks(180, 4)).toEqual([0, 50, 100, 150, 200])
  })

  it('finds the nearest sample and prefers the earlier one on a tie', () => {
    const ats = [0, 10, 20, 40]
    expect([-5, 4, 5, 6, 29, 31, 99].map(at => nearestIndex(ats, at))).toEqual([0, 0, 0, 1, 2, 3, 3])
    expect(nearestIndex([], 1)).toBe(-1)
  })

  it('breaks runs at missing readings, large gaps and backward time', () => {
    const runs = contiguousRuns([
      { at: 0, value: 1 }, { at: 5, value: 2 }, { at: 10, value: null }, { at: 15, value: 3 },
      { at: 60, value: 4 }, { at: 55, value: 5 }, { at: 60, value: 6 },
    ], 10)
    expect(runs.map(run => run.map(point => point.value))).toEqual([[1, 2], [3], [4], [5, 6]])
    expect(typicalStep([0, 5, 10, 100, 105])).toBe(5)
  })

  it('places time ticks on wall-clock boundaries inside the range', () => {
    const from = new Date(2026, 8, 14, 10, 7, 30).getTime()
    const ticks = timeTicks(from, from + 15 * 60_000, 5)
    expect(ticks.length).toBeGreaterThan(0)
    for (const tick of ticks) {
      expect(tick).toBeGreaterThanOrEqual(from)
      expect(new Date(tick).getSeconds()).toBe(0)
      expect(new Date(tick).getMinutes() % 5).toBe(0)
    }
  })
})
