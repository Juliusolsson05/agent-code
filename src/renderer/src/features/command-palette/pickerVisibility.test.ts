import { describe, expect, it } from 'vitest'

import {
  declaredTier,
  isVisibleInPicker,
  setPickerVisibilityOverride,
  suppressingCommandGroup,
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

  describe('setPickerVisibilityOverride (the WRITE half)', () => {
    // The prune rule is the half most likely to be "simplified" into
    // `next[id] = visible` by someone who does not read the docstring. Without
    // these four cases the whole suite stays green through that change, and the
    // bug only shows up the day a command's shipped default changes and a stale
    // entry that merely restated the old default keeps overriding the new one.

    it('deletes the entry when a default-tier command is set visible', () => {
      const next = setPickerVisibilityOverride({ a: false }, cmd('a'), true)
      expect(next).not.toHaveProperty('a')
    })

    it('stores false when a default-tier command is hidden', () => {
      expect(setPickerVisibilityOverride({}, cmd('a'), false)).toEqual({ a: false })
    })

    it('deletes the entry when a hidden-tier command is set back to hidden', () => {
      for (const tier of ['advanced', 'experimental', 'debug'] as const) {
        const next = setPickerVisibilityOverride({ a: true }, cmd('a', tier), false)
        expect(next, tier).not.toHaveProperty('a')
      }
    })

    it('stores true when a hidden-tier command is revealed', () => {
      expect(setPickerVisibilityOverride({}, cmd('a', 'debug'), true)).toEqual({ a: true })
    })

    it('never mutates the map it was given', () => {
      const before = { a: false, b: true }
      setPickerVisibilityOverride(before, cmd('a'), true)
      expect(before).toEqual({ a: false, b: true })
    })

    it('tolerates an undefined map, like the read half does', () => {
      expect(setPickerVisibilityOverride(undefined, cmd('a'), false)).toEqual({ a: false })
    })

    it('round-trips with isVisibleInPicker for every tier', () => {
      // The two halves must agree about what "declared default" means; this is
      // the property that keeps them from drifting apart.
      for (const tier of [undefined, 'advanced', 'experimental', 'debug'] as const) {
        for (const visible of [true, false]) {
          const overrides = setPickerVisibilityOverride({}, cmd('a', tier), visible)
          expect(isVisibleInPicker(cmd('a', tier), policy({ overrides })), `${tier}/${visible}`)
            .toBe(visible)
        }
      }
    })
  })

  describe('suppressingCommandGroup', () => {
    // Settings needs to tell "user unticked it" apart from "its parent group is
    // off" so it can disable that row and NAME the parent. Exported for exactly
    // that; pinned here so it cannot drift from the gate isVisibleInPicker uses.
    it('names the group when the group is off', () => {
      expect(
        suppressingCommandGroup(
          { commandGroup: 'navigation' },
          { navigationCommandsEnabled: false },
        ),
      ).toBe('navigation')
    })

    it('returns null when the group is on, or when the command has no group', () => {
      expect(
        suppressingCommandGroup(
          { commandGroup: 'navigation' },
          { navigationCommandsEnabled: true },
        ),
      ).toBeNull()
      expect(suppressingCommandGroup({}, { navigationCommandsEnabled: false })).toBeNull()
    })

    it('agrees with isVisibleInPicker: a suppressed command is never visible', () => {
      const command = { id: 'a', commandGroup: 'navigation' as const }
      expect(suppressingCommandGroup(command, { navigationCommandsEnabled: false })).not.toBeNull()
      expect(
        isVisibleInPicker(command, policy({ navigationCommandsEnabled: false })),
      ).toBe(false)
      // ...even with an explicit override trying to force it on, because the
      // group gate deliberately outranks per-command overrides.
      expect(
        isVisibleInPicker(
          command,
          policy({ navigationCommandsEnabled: false, overrides: { a: true } }),
        ),
      ).toBe(false)
    })
  })
})
