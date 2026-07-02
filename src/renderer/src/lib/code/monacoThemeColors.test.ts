import { describe, expect, it } from 'vitest'

import {
  normalizeMonacoThemeColor,
  normalizeMonacoThemeColorAlpha,
} from './monacoThemeColors'

describe('normalizeMonacoThemeColor', () => {
  it('expands shorthand hex colors into canonical Monaco hex', () => {
    expect(normalizeMonacoThemeColor('#fff', '#000000')).toBe('#ffffff')
    expect(normalizeMonacoThemeColor('#ffff', '#000000')).toBe('#ffffffff')
  })

  it('normalizes named and rgb colors Monaco would reject in token rules', () => {
    expect(normalizeMonacoThemeColor('white', '#000000')).toBe('#ffffff')
    expect(normalizeMonacoThemeColor('transparent', '#000000')).toBe('#00000000')
    expect(normalizeMonacoThemeColor('rgb(255, 128, 0)', '#000000')).toBe('#ff8000')
    expect(normalizeMonacoThemeColor('rgba(255, 255, 255, 0.5)', '#000000')).toBe(
      '#ffffff80',
    )
  })

  it('falls back to canonical hex for invalid input', () => {
    expect(normalizeMonacoThemeColor('not-a-color', '#fff')).toBe('#ffffff')
    expect(normalizeMonacoThemeColor('', 'white')).toBe('#000000')
  })
})

describe('normalizeMonacoThemeColorAlpha', () => {
  it('replaces alpha on normalized colors', () => {
    expect(normalizeMonacoThemeColorAlpha('#fff', '33', '#000000')).toBe('#ffffff33')
    expect(normalizeMonacoThemeColorAlpha('rgb(1, 2, 3)', 'aa', '#000000')).toBe(
      '#010203aa',
    )
  })

  it('uses opaque alpha when the requested alpha is malformed', () => {
    expect(normalizeMonacoThemeColorAlpha('#123456', 'bad', '#000000')).toBe('#123456ff')
  })
})
