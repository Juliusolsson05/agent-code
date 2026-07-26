import { describe, expect, it } from 'vitest'

import { builtInCommandCatalog } from '@renderer/features/command-palette/catalog'
import { buildCommandRegistry } from '@renderer/features/command-palette/registry'
import { isVisibleInPicker } from '@renderer/features/command-palette/pickerVisibility'
import { makeTestCommandContext } from '@renderer/features/command-palette/testing/commandContextHarness'
import { coerceSettings } from '@renderer/app-state/settings/persistence'

// ---------------------------------------------------------------------------
// Phase 3: tiers, categories, and the Navigation Commands group.
//
// The catalog baseline test asserted that ALL 102 commands resolved to the
// `default` tier — the audit's headline finding, that debug tooling and daily
// navigation entered the picker at the same level. That assertion is now
// inverted: this file proves the classification actually landed, rather than
// having been declared in a document.
// ---------------------------------------------------------------------------

const NAVIGATION_GROUP_IDS = [
  'next-tab',
  'prev-tab',
  'nav-left',
  'nav-right',
  'nav-up',
  'nav-down',
] as const

const byId = (id: string) => {
  const found = builtInCommandCatalog.find(c => c.id === id)
  if (!found) throw new Error(`no command ${id}`)
  return found
}

describe('category coverage', () => {
  it('assigns a category to every command', () => {
    // `category` is still optional in the type during the migration, so this
    // test is what actually enforces total coverage. It flips to a compile
    // error once the field is required; until then, an unclassified command
    // would silently fall out of every grouped Settings view.
    const missing = builtInCommandCatalog.filter(c => !c.category).map(c => c.id)
    expect(missing).toEqual([])
  })

  it('uses only known categories', () => {
    const known = new Set([
      'create',
      'navigate',
      'session',
      'layout-dispatch',
      'editor-files',
      'workspace-tools',
      'preferences',
      'developer',
    ])
    const unknown = builtInCommandCatalog
      .filter(c => c.category && !known.has(c.category))
      .map(c => `${c.id}:${c.category}`)
    expect(unknown).toEqual([])
  })

  it('classifies every diagnostic command as developer', () => {
    // The audit's rule: "debug is a surface label, not a visibility or
    // capability policy". Every command on the debug SURFACE must also carry
    // the developer CATEGORY, or the two axes disagree about what the command
    // is and Settings groups it away from its siblings.
    const mismatched = builtInCommandCatalog
      .filter(c => c.surface === 'debug' && c.category !== 'developer')
      .map(c => c.id)
    expect(mismatched).toEqual([])
  })
})

describe('tier classification', () => {
  it('no longer places every command in the default tier', () => {
    // The direct inversion of the Phase 0 baseline assertion.
    const tiers = new Set(builtInCommandCatalog.map(c => c.pickerVisibility ?? 'default'))
    expect(tiers.size).toBeGreaterThan(1)
  })

  it('hides every debug-surface command from the picker by default', () => {
    // Ten diagnostic commands used to enter the palette at the same tier as
    // New Tab. This is the single biggest reduction in list noise in the plan.
    const visible = builtInCommandCatalog
      .filter(c => c.surface === 'debug')
      .filter(c => (c.pickerVisibility ?? 'default') === 'default')
      .map(c => c.id)
    expect(visible).toEqual([])
  })

  it('classifies Remote Control as experimental', () => {
    // Recorded product decision: the panel stays experimental until packaged
    // runtime/network readiness and disclosure are complete. Opening a panel is
    // harmless; binding a port and pairing a device is not, and those actions
    // stay separately authorized inside the panel regardless of this tier.
    expect(byId('toggle-remote-panel').pickerVisibility).toBe('experimental')
  })

  it('keeps daily reversible actions in the default tier', () => {
    for (const id of ['new-tab', 'close-tab', 'toggle-git-bar', 'reload-agent']) {
      expect(byId(id).pickerVisibility ?? 'default').toBe('default')
    }
  })

  it('marks niche supported operations advanced rather than hiding them entirely', () => {
    // `advanced` is not `debug`: these are supported operations a power user
    // wants, just not ones that should crowd a fuzzy search.
    for (const id of ['rewind-to-prompt', 'duplicate-agent', 'normalize-layout', 'bury-pane']) {
      expect(byId(id).pickerVisibility).toBe('advanced')
    }
  })
})

describe('Navigation Commands group', () => {
  it('has exactly the six recorded members', () => {
    const members = builtInCommandCatalog
      .filter(c => c.commandGroup === 'navigation')
      .map(c => c.id)
    expect(members.sort()).toEqual([...NAVIGATION_GROUP_IDS].sort())
  })

  it('does not sweep in other navigate-category commands', () => {
    // The closed-membership rule. Jump to Latest Message, Spotlight, Reader
    // Mode, Tiled Tabs and Reorder Tabs are all `navigate` and must stay
    // ordinary commands — deriving membership from the category would make a
    // future navigation-adjacent feature default-hidden just for reusing a
    // label.
    for (const id of [
      'jump-latest-message',
      'toggle-spotlight',
      'toggle-reader-mode',
      'tiled-tabs',
      'reorder-tabs',
    ]) {
      expect(byId(id).category).toBe('navigate')
      expect(byId(id).commandGroup).toBeUndefined()
    }
  })

  it('removes all six from the picker when the group is off', () => {
    const ctx = makeTestCommandContext({ flags: { navigationCommandsEnabled: false } })
    const visible = new Set(buildCommandRegistry(ctx).map(c => c.id))
    for (const id of NAVIGATION_GROUP_IDS) expect(visible.has(id)).toBe(false)
  })

  it('restores them when the group is on', () => {
    // nav-* are grid-surface, so Dispatch must be off for them to be
    // applicable at all — otherwise this would pass for the wrong reason.
    const ctx = makeTestCommandContext({
      flags: { navigationCommandsEnabled: true, dispatchModeEnabled: false },
    })
    const visible = new Set(buildCommandRegistry(ctx).map(c => c.id))
    for (const id of NAVIGATION_GROUP_IDS) expect(visible.has(id)).toBe(true)
  })

  it('outranks a per-command override while the group is off', () => {
    // Documented precedence. If an override could pull one member back while
    // the family is off, Settings would show six switches that appear able to
    // contradict their own parent.
    const hidden = isVisibleInPicker(byId('nav-left'), {
      overrides: { 'nav-left': true },
      showHiddenCommands: false,
      navigationCommandsEnabled: false,
    })
    expect(hidden).toBe(false)
  })

  it('yields to a per-command override once the group is on', () => {
    const shown = isVisibleInPicker(byId('nav-left'), {
      overrides: { 'nav-left': false },
      showHiddenCommands: false,
      navigationCommandsEnabled: true,
    })
    expect(shown).toBe(false)
  })

  it('keeps the members in the context-free catalog in both states', () => {
    // Catalog membership must never depend on a persisted UI preference, or
    // native lookup, diagnostics, and id stability start varying by setting.
    const ids = builtInCommandCatalog.map(c => c.id)
    for (const id of NAVIGATION_GROUP_IDS) expect(ids).toContain(id)
  })
})

describe('navigationCommandsEnabled persistence', () => {
  it('defaults to false on a fresh install', () => {
    expect(coerceSettings({}).navigationCommandsEnabled).toBe(false)
  })

  it('defaults to false for a store written before the field existed', () => {
    // The upgrade path. `!== false` would have flipped six new rows into every
    // existing user's palette on update, which is the opposite of the intent.
    expect(coerceSettings({ showStatusMode: true }).navigationCommandsEnabled).toBe(false)
  })

  it.each([null, undefined, 0, 1, 'true', {}, []])(
    'coerces the malformed value %p to false',
    value => {
      const settings = coerceSettings({ navigationCommandsEnabled: value })
      expect(settings.navigationCommandsEnabled).toBe(false)
    },
  )

  it('persists an explicit true', () => {
    expect(coerceSettings({ navigationCommandsEnabled: true }).navigationCommandsEnabled).toBe(true)
  })

  it('is idempotent across repeated coercion', () => {
    // Coercion runs on every launch through `merge`, not only on version
    // change, so a value that drifted on the second pass would drift on every
    // subsequent boot.
    const once = coerceSettings({ navigationCommandsEnabled: true })
    const twice = coerceSettings(once)
    expect(twice.navigationCommandsEnabled).toBe(true)
    expect(coerceSettings(coerceSettings({})).navigationCommandsEnabled).toBe(false)
  })
})
