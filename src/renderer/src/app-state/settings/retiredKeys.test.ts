import { describe, expect, it } from 'vitest'

import { coerceSettings } from '@renderer/app-state/settings/persistence'

// ---------------------------------------------------------------------------
// Phase 7: retiring a persisted Settings field.
//
// Deleting a field from the `Settings` TYPE does not delete it from a user's
// stored blob. `coerceSettings` spreads `parsed` wholesale, so a retired key
// survives coercion, gets written back on the next save, and lives forever in
// localStorage — invisible to TypeScript and impossible to reason about. The
// plan flags this trap by name for `dispatchProjectTerminal`.
// ---------------------------------------------------------------------------

const RETIRED = 'dispatchProjectTerminal'

describe('retired persisted settings keys', () => {
  it.each([true, false])('drops a stored %p value', stored => {
    // Both polarities, because the trap is about the KEY surviving the spread,
    // not about which value it held.
    const settings = coerceSettings({ [RETIRED]: stored }) as Record<string, unknown>
    expect(RETIRED in settings).toBe(false)
  })

  it('does not reserialize the key on the next save', () => {
    // The actual damage: coerce -> save -> coerce is the real lifecycle, and a
    // key that survives one round trip survives all of them.
    const once = coerceSettings({ [RETIRED]: true })
    const twice = coerceSettings(JSON.parse(JSON.stringify(once))) as Record<string, unknown>
    expect(RETIRED in twice).toBe(false)
  })

  it('is idempotent across repeated coercion', () => {
    // Coercion runs on every launch through `merge`, not only on a version
    // change, so drift on the second pass means drift on every boot.
    const first = coerceSettings({ [RETIRED]: true })
    const second = coerceSettings(first)
    expect(second).toEqual(first)
  })

  it('leaves every surviving setting untouched', () => {
    // The omission must be surgical. A filter that dropped more than its list
    // would silently reset unrelated preferences on upgrade.
    const settings = coerceSettings({
      [RETIRED]: true,
      showStatusMode: false,
      usageHeaderLevel: 'minimal',
      navigationCommandsEnabled: true,
    })
    expect(settings.showStatusMode).toBe(false)
    expect(settings.usageHeaderLevel).toBe('minimal')
    expect(settings.navigationCommandsEnabled).toBe(true)
  })

  it('still produces a usable settings object from a blob that had only the retired key', () => {
    const settings = coerceSettings({ [RETIRED]: true })
    expect(settings.mode).toBeDefined()
    expect(settings.accent).toBeDefined()
  })
})
