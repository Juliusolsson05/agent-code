import { describe, expect, it } from 'vitest'

import {
  declaredTier,
  isVisibleInPicker,
} from '@renderer/features/command-palette/pickerVisibility'
import type { CommandPickerVisibility } from '@renderer/features/command-palette/types'

const cmd = (id: string, tier?: CommandPickerVisibility) => ({ id, pickerVisibility: tier })

const policy = (overrides?: {
  overrides?: Record<string, boolean> | undefined
  showHiddenCommands?: boolean
  navigationCommandsEnabled?: boolean
}) => ({
  overrides: overrides?.overrides ?? {},
  showHiddenCommands: overrides?.showHiddenCommands ?? false,
  // Defaults ON here, opposite to the product default, so the group gate never
  // silently participates in a test that is about tiers or overrides. Group
  // behavior gets its own describe block below, where the flag is explicit.
  navigationCommandsEnabled: overrides?.navigationCommandsEnabled ?? true,
})

describe('declaredTier', () => {
  it('treats an absent tier as default', () => {
    // The `absent ≡ 'default'` rule is applied in exactly one place so callers
    // cannot re-implement the fallback and drift apart. Both the registry and
    // the Settings metadata list route through here for that reason.
    expect(declaredTier({ pickerVisibility: undefined })).toBe('default')
  })

  it.each(['default', 'advanced', 'experimental', 'debug'] as const)(
    'passes %s through unchanged',
    tier => {
      expect(declaredTier({ pickerVisibility: tier })).toBe(tier)
    },
  )
})

describe('isVisibleInPicker', () => {
  it('shows a default-tier command', () => {
    expect(isVisibleInPicker(cmd('a'), policy())).toBe(true)
  })

  it.each(['advanced', 'experimental', 'debug'] as const)(
    'hides a %s-tier command',
    tier => {
      expect(isVisibleInPicker(cmd('a', tier), policy())).toBe(false)
    },
  )

  describe('per-command override', () => {
    it('forces a hidden tier into the picker', () => {
      expect(isVisibleInPicker(cmd('a', 'debug'), policy({ overrides: { a: true } }))).toBe(true)
    })

    it('forces a default-tier command out of the picker', () => {
      expect(isVisibleInPicker(cmd('a'), policy({ overrides: { a: false } }))).toBe(false)
    })

    it('ignores an override belonging to a different command', () => {
      expect(isVisibleInPicker(cmd('a'), policy({ overrides: { b: false } }))).toBe(true)
    })
  })

  describe('showHiddenCommands escape hatch', () => {
    it('reveals every tier', () => {
      expect(isVisibleInPicker(cmd('a', 'debug'), policy({ showHiddenCommands: true }))).toBe(true)
    })

    it('outranks an explicit false override', () => {
      // Documented precedence: the escape hatch is checked first, so "show me
      // everything" genuinely means everything rather than "everything except
      // what I previously hid" — which would make the affordance useless for
      // finding a command you hid and now want back.
      const result = isVisibleInPicker(
        cmd('a'),
        policy({ overrides: { a: false }, showHiddenCommands: true }),
      )
      expect(result).toBe(true)
    })
  })

  describe('defensive coercion', () => {
    it('does not throw when the override map is undefined', () => {
      // This runs inside the palette's first-render useMemo. A bare `[id]`
      // index on undefined throws and takes the whole app to a black screen —
      // the exact #249 launch regression. A persisted-settings shape predating
      // the field must degrade to "no override", never crash.
      expect(() => isVisibleInPicker(cmd('a'), policy({ overrides: undefined }))).not.toThrow()
      expect(isVisibleInPicker(cmd('a'), policy({ overrides: undefined }))).toBe(true)
    })

    it('falls back to the declared tier for a non-boolean override value', () => {
      // Coercion should already have removed these, but the registry's
      // `typeof === 'boolean'` check is what makes that guarantee local rather
      // than a trust relationship with a persistence layer three modules away.
      const overrides = { a: 'yes' as unknown as boolean }
      expect(isVisibleInPicker(cmd('a', 'debug'), policy({ overrides }))).toBe(false)
      expect(isVisibleInPicker(cmd('a'), policy({ overrides }))).toBe(true)
    })
  })
})
