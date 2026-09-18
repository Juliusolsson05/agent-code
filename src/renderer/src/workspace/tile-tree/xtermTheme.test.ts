import { describe, expect, it } from 'vitest'

import { colorWithAlpha } from '@renderer/workspace/tile-tree/xtermTheme'

describe('colorWithAlpha', () => {
  it('appends the alpha to six- and eight-digit hex', () => {
    expect(colorWithAlpha('#88c0d0', '44', '#000000ff')).toBe('#88c0d044')
    expect(colorWithAlpha('#88c0d0ff', '44', '#000000ff')).toBe('#88c0d044')
  })

  // Nord's muted ink is an alpha over the canvas. Before rgba() support the
  // terminal's inactive selection and scrollbar silently used the old dark
  // palette's literal fallback — the one place the green era survived.
  it('flattens an rgba() token over the canvas before applying the alpha', () => {
    expect(colorWithAlpha('rgba(216, 222, 233, 0.42)', '33', '#000000ff', '#171b21')).toBe('#686d7533')
  })

  it('returns the fallback for anything it cannot flatten', () => {
    expect(colorWithAlpha('color-mix(in srgb, red 50%, blue)', '33', '#686d7533')).toBe('#686d7533')
    expect(colorWithAlpha('rgba(1, 2, 3, 0.5)', '33', '#686d7533')).toBe('#686d7533')
  })
})
