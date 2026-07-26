import { describe, expect, it } from 'vitest'

import {
  coerceCommandKeybindingOverrides,
  effectiveBindingsFor,
  resetCommandKeybindings,
  resolveEffectiveKeybindings,
  setCommandKeybindings,
} from '@renderer/features/command-keybindings/resolve'
import { coerceSettings } from '@renderer/app-state/settings/persistence'
import type { CommandBindingDefault } from '@renderer/features/command-keybindings/defaults'

const DEFAULTS: CommandBindingDefault[] = [
  { commandId: 'a', bindings: ['Cmd+A'], context: 'global' },
  { commandId: 'b', bindings: ['Cmd+B', 'Alt+B'], context: 'grid' },
]

describe('sparse override semantics', () => {
  // The three states are distinct and all load-bearing. These four tests are
  // the contract that lets a future release improve an untouched default
  // without resurrecting a chord the user deliberately removed.

  it('inherits the shipped default when absent', () => {
    expect(effectiveBindingsFor('a', {}, DEFAULTS)).toEqual(['Cmd+A'])
  })

  it('treats an empty array as an explicit unbind', () => {
    // NOT the same as absent. The user removed this on purpose, so a release
    // that later hands the command a new default must not override that.
    expect(effectiveBindingsFor('a', { a: [] }, DEFAULTS)).toEqual([])
  })

  it('replaces the defaults entirely with a non-empty override', () => {
    // Replace, not merge: a user who sets one binding does not silently keep
    // the shipped one alongside it.
    expect(effectiveBindingsFor('b', { b: ['Cmd+Z'] }, DEFAULTS)).toEqual(['Cmd+Z'])
  })

  it('keeps absent and empty distinguishable through resolution', () => {
    const resolved = resolveEffectiveKeybindings({ a: [] }, DEFAULTS)
    const a = resolved.find(e => e.commandId === 'a')
    const b = resolved.find(e => e.commandId === 'b')
    expect(a?.customized).toBe(true)
    expect(b?.customized).toBe(false)
  })

  it('supports binding a command that ships with no default', () => {
    const resolved = resolveEffectiveKeybindings({ 'never-shipped': ['Cmd+Q'] }, DEFAULTS)
    const entry = resolved.find(e => e.commandId === 'never-shipped')
    expect(entry?.bindings).toEqual(['Cmd+Q'])
    // 'global' is the strictest context for collision purposes — it overlaps
    // everything, so the checker flags any clash rather than missing one.
    expect(entry?.context).toBe('global')
  })
})

describe('setCommandKeybindings', () => {
  it('stores a deviation from the shipped default', () => {
    expect(setCommandKeybindings({}, 'a', ['Cmd+Z'], DEFAULTS)).toEqual({ a: ['Cmd+Z'] })
  })

  it('stores an explicit unbind', () => {
    expect(setCommandKeybindings({}, 'a', [], DEFAULTS)).toEqual({ a: [] })
  })

  it('records an explicit edit even when it equals the shipped default', () => {
    // The plan's acceptance criterion is "preserves explicit choices when a
    // later release changes shipped defaults". Deleting the entry as redundant
    // breaks exactly that: a user who deliberately keeps a command on today's
    // chord would have it silently moved when a future release changes the
    // default. resetCommandKeybindings is the documented way back to
    // inheriting; an equal-to-default edit is still a decision.
    expect(setCommandKeybindings({ a: [] }, 'a', ['Cmd+A'], DEFAULTS)).toEqual({ a: ['Cmd+A'] })
  })

  it('keeps a recorded choice pinned when the shipped default later moves', () => {
    const chosen = setCommandKeybindings({}, 'a', ['Cmd+A'], DEFAULTS)
    const nextRelease = [{ commandId: 'a', bindings: ['Cmd+Alt+A'], context: 'global' as const }]
    expect(effectiveBindingsFor('a', chosen, nextRelease)).toEqual(['Cmd+A'])
  })

  it('treats binding order as significant', () => {
    // Two bindings for one command are an ordered display list, so a reorder is
    // a real edit rather than a no-op.
    const next = setCommandKeybindings({}, 'b', ['Alt+B', 'Cmd+B'], DEFAULTS)
    expect(next.b).toEqual(['Alt+B', 'Cmd+B'])
  })

  it('does not mutate the input map', () => {
    const before = { a: ['Cmd+Z'] }
    setCommandKeybindings(before, 'a', [], DEFAULTS)
    expect(before).toEqual({ a: ['Cmd+Z'] })
  })
})

describe('resetCommandKeybindings', () => {
  it('returns the command to inheriting', () => {
    // Reset means "go back to inheriting", not "pin me to whatever the default
    // happens to be this week".
    const next = resetCommandKeybindings({ a: ['Cmd+Z'] }, 'a')
    expect(next).toEqual({})
    expect(effectiveBindingsFor('a', next, DEFAULTS)).toEqual(['Cmd+A'])
  })
})

describe('coerceCommandKeybindingOverrides', () => {
  it('normalizes stored bindings', () => {
    expect(coerceCommandKeybindingOverrides({ a: ['shift+cmd+p'] })).toEqual({
      a: ['Cmd+Shift+P'],
    })
  })

  it('drops a malformed binding but keeps the parseable siblings', () => {
    // A user with three bindings and one corrupt value keeps the two that
    // still parse, rather than losing the command entirely.
    expect(coerceCommandKeybindingOverrides({ a: ['cmd+p', 'Cmd+K R', 'alt+d'] })).toEqual({
      a: ['Cmd+P', 'Alt+D'],
    })
  })

  it('deduplicates bindings that normalize to the same chord', () => {
    expect(coerceCommandKeybindingOverrides({ a: ['cmd+p', 'Cmd+P', '⌘+p'] })).toEqual({
      a: ['Cmd+P'],
    })
  })

  it('drops an all-malformed array so the command inherits again', () => {
    // Corruption, not intent. Collapsing it to `[]` made the damage permanent:
    // `[]` means "explicitly unbound" and outranks the shipped default forever,
    // so a value mangled by an older build's parser would leave the command
    // showing "Not assigned" with no way back.
    expect(coerceCommandKeybindingOverrides({ a: ['nonsense'] })).toEqual({})
  })

  it('still honours a genuine explicit unbind', () => {
    // The distinction the rule above must not damage: a real unbind writes an
    // EMPTY array, which has nothing to fail parsing and round-trips intact.
    expect(coerceCommandKeybindingOverrides({ a: [] })).toEqual({ a: [] })
  })

  it('recovers a command whose binding an older build could not parse', () => {
    const settings = coerceCommandKeybindingOverrides({ a: ['SomeFutureKey'] })
    expect(effectiveBindingsFor('a', settings, DEFAULTS)).toEqual(['Cmd+A'])
  })

  it('preserves unknown command ids', () => {
    // May belong to an extension that is temporarily uninstalled, or a command
    // a downgrade removed. Pruning opportunistically discards a deliberate
    // binding the moment someone runs an older build.
    expect(coerceCommandKeybindingOverrides({ 'ext.thing': ['cmd+9'] })).toEqual({
      'ext.thing': ['Cmd+9'],
    })
  })

  it.each([null, undefined, 42, 'x', []])('returns {} for the malformed root %p', value => {
    expect(coerceCommandKeybindingOverrides(value)).toEqual({})
  })

  it('ignores a non-array entry', () => {
    expect(coerceCommandKeybindingOverrides({ a: 'Cmd+P' })).toEqual({})
  })
})

describe('settings persistence', () => {
  it('defaults to an empty map', () => {
    // Seeding with today's defaults would pin every command to this release's
    // chords and make future default improvements invisible.
    expect(coerceSettings({}).commandKeybindingOverrides).toEqual({})
  })

  it('round-trips and normalizes a persisted override', () => {
    const settings = coerceSettings({ commandKeybindingOverrides: { 'new-tab': ['cmd+t'] } })
    expect(settings.commandKeybindingOverrides).toEqual({ 'new-tab': ['Cmd+T'] })
  })

  it('is idempotent across repeated coercion', () => {
    // Coercion runs on every launch through `merge`, not only on version
    // change, so drift on the second pass means drift on every boot.
    const once = coerceSettings({ commandKeybindingOverrides: { a: ['shift+cmd+p'] } })
    const twice = coerceSettings(once)
    expect(twice.commandKeybindingOverrides).toEqual(once.commandKeybindingOverrides)
  })

  it('survives a store written before the field existed', () => {
    expect(coerceSettings({ showStatusMode: true }).commandKeybindingOverrides).toEqual({})
  })
})
