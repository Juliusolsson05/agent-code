import { describe, expect, it } from 'vitest'

import { fitViewport, pocketLayout, pocketSplitWidth, MIN_SPLIT_WIDTH } from './layout'

describe('pocketLayout', () => {
  it('collapsed is always the strip, even in Spotlight', () => {
    expect(pocketLayout({ width: 2000, height: 1200 }, 'collapsed', 'spotlight')).toBe('strip')
  })
  it.each(['lane', 'spotlight'] as const)('opens full-size in narrow %s surfaces, never a dead-end strip', surface => {
    for (const size of [{ width: 240, height: 350 }, { width: 400, height: 900 }, { width: 0, height: 0 }]) {
      expect(pocketLayout(size, 'open', surface)).toBe('browser')
    }
  })
  it('requires room for both panes, including the divider, and never stacks', () => {
    expect(pocketLayout({ width: MIN_SPLIT_WIDTH - 1, height: 1000 }, 'open', 'lane')).toBe('browser')
    expect(pocketLayout({ width: MIN_SPLIT_WIDTH, height: 180 }, 'open', 'lane')).toBe('side')
    expect(pocketLayout({ width: 1400, height: 100 }, 'open', 'spotlight')).toBe('browser')
    expect(pocketLayout({ width: 700, height: 900 }, 'open', 'lane')).toBe('side')
  })
  it('preserves both pane minimums even after an extreme drag or resize', () => {
    expect(pocketSplitWidth(MIN_SPLIT_WIDTH, 0.2)).toBe(320)
    expect(pocketSplitWidth(MIN_SPLIT_WIDTH, 0.8)).toBe(320)
    expect(pocketSplitWidth(1000, 0.99)).toBe(716)
    expect(pocketSplitWidth(1000, 0.01)).toBe(320)
  })
})

describe('fitViewport', () => {
  it('fills the slot when no device is emulated', () => {
    expect(fitViewport({ width: 800, height: 600 }, null)).toEqual({ width: 800, height: 600, scale: 1, offsetX: 0, offsetY: 0 })
  })
  it('keeps the device CSS size and scales down to fit, centred', () => {
    const f = fitViewport({ width: 400, height: 600 }, { width: 393, height: 852 })
    expect(f.width).toBe(393)
    expect(f.scale).toBeCloseTo(600 / 852)
    expect(f.offsetX).toBeCloseTo((400 - 393 * (600 / 852)) / 2)
  })
  it('never scales up', () => {
    expect(fitViewport({ width: 2000, height: 2000 }, { width: 393, height: 852 }).scale).toBe(1)
  })
})
