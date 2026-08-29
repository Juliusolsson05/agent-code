import { beforeEach, describe, expect, it } from 'vitest'

import {
  CORNER_CHIP_CSS_VAR,
  CORNER_CONTROL_CSS_VAR,
  CORNER_FLOAT_CSS_VAR,
  CORNER_SLAB_CSS_VAR,
  applyTheme,
} from '@renderer/app-state/settings/theme'
import { CORNER_STYLES, DEFAULT_SETTINGS } from '@renderer/app-state/settings/types'
import type { Settings } from '@renderer/app-state/settings/types'

const CORNER_VARS = [
  CORNER_CHIP_CSS_VAR,
  CORNER_CONTROL_CSS_VAR,
  CORNER_SLAB_CSS_VAR,
  CORNER_FLOAT_CSS_VAR,
] as const

function readCorners(): string[] {
  const root = document.documentElement
  return CORNER_VARS.map(name => root.style.getPropertyValue(name))
}

function withCorners(cornerStyle: unknown): Settings {
  // Cast at the seam rather than in the assertions: two of these cases model a
  // persisted blob that never went through coerceSettings, which is exactly the
  // call shape the phone client uses (see the applyTheme comment).
  return { ...DEFAULT_SETTINGS, cornerStyle } as Settings
}

describe('applyTheme corner radius', () => {
  beforeEach(() => {
    for (const name of CORNER_VARS) document.documentElement.style.removeProperty(name)
  })

  // The guarantee that makes this feature safe to ship: `sharp` is a promise
  // that the app returns to sharp rectangles completely, not approximately. If
  // a future tier edit leaves one token non-zero, a user who chose Sharp gets a
  // single stray rounded surface and no way to explain it — so this asserts the
  // written CSS values rather than the CORNER_STYLES table, which would only
  // restate itself.
  it('writes zero to every token at the sharp tier', () => {
    applyTheme(withCorners('sharp'))
    expect(readCorners()).toEqual(['0px', '0px', '0px', '0px'])
  })

  // A partially applied tier is the shape a copy-paste error takes here, and it
  // fails silently: chips follow the new setting while panels keep the old one,
  // which reads as a rendering bug rather than a missing assignment.
  it('writes all four tokens together when the tier changes', () => {
    applyTheme(withCorners('sharp'))
    applyTheme(withCorners('round'))

    const round = CORNER_STYLES.find(style => style.id === 'round')!
    expect(readCorners()).toEqual([round.chip, round.control, round.slab, round.float])
    expect(readCorners().every(value => value !== '')).toBe(true)
  })

  // applyTheme is called by the phone client on an UNCOERCED settings blob, so
  // it cannot assume coerceSettings ran. Resolving to undefined here would write
  // four invalid values at once and drop every rounded surface in the app.
  it('falls back to the default tier for a corner style it cannot resolve', () => {
    const fallback = CORNER_STYLES[0]

    for (const bad of ['squircle', undefined, null, 7]) {
      applyTheme(withCorners(bad))
      expect(readCorners()).toEqual([
        fallback.chip,
        fallback.control,
        fallback.slab,
        fallback.float,
      ])
    }
  })
})
