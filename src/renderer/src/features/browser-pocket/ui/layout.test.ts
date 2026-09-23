import { describe, expect, it } from 'vitest'

import { fitViewport, pocketLayout } from './layout'

describe('pocketLayout', () => {
  it('collapsed is always the strip, even in Spotlight', () => {
    expect(pocketLayout({ width: 2000, height: 1200 }, 'collapsed', 'spotlight')).toBe('strip')
  })
  it('Spotlight always splits side by side when open', () => {
    expect(pocketLayout({ width: 300, height: 300 }, 'open', 'spotlight')).toBe('side')
  })
  it('a lane too small in both directions keeps the strip; unmeasured (0×0) too', () => {
    expect(pocketLayout({ width: 500, height: 400 }, 'open', 'lane')).toBe('strip')
    expect(pocketLayout({ width: 0, height: 0 }, 'open', 'lane')).toBe('strip')
  })
  it('wide lanes split side by side, tall ones stack, and a short-but-wide one never stacks into slivers', () => {
    expect(pocketLayout({ width: 1400, height: 700 }, 'open', 'lane')).toBe('side')
    expect(pocketLayout({ width: 700, height: 900 }, 'open', 'lane')).toBe('stacked')
    expect(pocketLayout({ width: 900, height: 300 }, 'open', 'lane')).toBe('side')
    expect(pocketLayout({ width: 400, height: 900 }, 'open', 'lane')).toBe('stacked')
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
