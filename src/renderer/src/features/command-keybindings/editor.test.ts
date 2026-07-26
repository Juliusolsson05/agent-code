import { describe, expect, it } from 'vitest'

import { buildDefaultKeybindings } from '@renderer/features/command-keybindings/defaults'
import { findBindingOwners } from '@renderer/features/command-keybindings/reservations'
import {
  resetCommandKeybindings,
  resolveEffectiveKeybindings,
  setCommandKeybindings,
} from '@renderer/features/command-keybindings/resolve'
import { builtInCommandCatalog } from '@renderer/features/command-palette/catalog'

// ---------------------------------------------------------------------------
// The Settings keybinding editor's BEHAVIOUR contract.
//
// The component is a thin shell over these functions; what matters — and what
// the audit's rules constrain — is the policy underneath. Testing the policy
// directly keeps these assertions honest without mounting a Settings page.
// ---------------------------------------------------------------------------

const defaults = buildDefaultKeybindings()
const effectiveAsDefaults = (overrides: Record<string, string[]>) =>
  resolveEffectiveKeybindings(overrides, defaults)

describe('conflict detection', () => {
  it('names the command that already owns a chord', () => {
    // "That shortcut is taken" is not actionable. The editor must be able to
    // say WHICH command, so the owner id has to come back rather than a bool.
    const owners = findBindingOwners({
      binding: 'Cmd+T',
      context: 'global',
      commandDefaults: effectiveAsDefaults({}),
      excludeCommandId: 'some-other-command',
    })
    expect(owners.map(o => o.id)).toContain('new-tab')
  })

  it('names a reserved interaction the user cannot reassign', () => {
    const owners = findBindingOwners({
      binding: 'Escape',
      context: 'global',
      commandDefaults: effectiveAsDefaults({}),
    })
    expect(owners.every(o => o.kind === 'reserved')).toBe(true)
  })

  it('detects a clash with the user OWN rebinding, not just the shipped table', () => {
    // The editor passes the EFFECTIVE set, so a chord the user moved onto
    // another command still conflicts. Checking shipped defaults alone would
    // let two of the user's own commands silently share a chord.
    const overrides = { 'toggle-git-bar': ['Cmd+Shift+9'] }
    const owners = findBindingOwners({
      binding: 'Cmd+Shift+9',
      context: 'global',
      commandDefaults: effectiveAsDefaults(overrides),
      excludeCommandId: 'toggle-debug-panel',
    })
    expect(owners.map(o => o.id)).toContain('toggle-git-bar')
  })

  it('does not report a command as conflicting with itself', () => {
    // Re-saving an unchanged binding must not be blocked.
    const owners = findBindingOwners({
      binding: 'Cmd+T',
      context: 'global',
      commandDefaults: effectiveAsDefaults({}),
      excludeCommandId: 'new-tab',
    })
    expect(owners.map(o => o.id)).not.toContain('new-tab')
  })

  it('detects a clash with the current dictation hotkey', () => {
    // Settings checks the CURRENT PROFILE's dictation binding; the repository
    // script checks the shipped default. Same function, different input.
    const owners = findBindingOwners({
      binding: 'Cmd+Shift+D',
      context: 'global',
      commandDefaults: effectiveAsDefaults({}),
      dictationBinding: 'Cmd+Shift+D',
    })
    expect(owners.map(o => o.id)).toContain('Voice dictation hotkey')
  })
})

describe('atomic Replace', () => {
  it('moves a chord in one write, never leaving it owned twice', () => {
    // Modelled exactly as the editor applies it: strip from every prior owner,
    // then install on the requester, producing ONE settings object. A
    // two-step write could be observed with the chord owned twice or by
    // nobody.
    let next: Record<string, string[]> = {}
    const victim = resolveEffectiveKeybindings({}, defaults)
      .find(e => e.commandId === 'new-tab')!
    next = setCommandKeybindings(next, 'new-tab', victim.bindings.filter(b => b !== 'Cmd+T'), defaults)
    next = setCommandKeybindings(next, 'toggle-git-bar', ['Cmd+T'], defaults)

    const after = new Map(
      resolveEffectiveKeybindings(next, defaults).map(e => [e.commandId, e.bindings]),
    )
    expect(after.get('new-tab')).not.toContain('Cmd+T')
    expect(after.get('toggle-git-bar')).toContain('Cmd+T')

    // Exactly one owner across the whole effective set.
    const owners = resolveEffectiveKeybindings(next, defaults)
      .filter(e => e.bindings.includes('Cmd+T'))
    expect(owners).toHaveLength(1)
  })
})

describe('editor row semantics', () => {
  it('reports Not assigned for a command with no binding', () => {
    const effective = new Map(
      resolveEffectiveKeybindings({}, defaults).map(e => [e.commandId, e.bindings]),
    )
    // Most of the catalog ships unbound; scarcity is deliberate.
    expect(effective.get('toggle-git-bar')).toBeUndefined()
  })

  it('supports several bindings on one command', () => {
    const effective = new Map(
      resolveEffectiveKeybindings({}, defaults).map(e => [e.commandId, e.bindings]),
    )
    expect(effective.get('close-pane')).toEqual(['Cmd+W', 'Alt+W'])
  })

  it('removing the last binding is an explicit unbind, not a reset', () => {
    // The distinction that lets a future release improve untouched defaults
    // without resurrecting a chord the user deliberately removed.
    const next = setCommandKeybindings({}, 'new-tab', [], defaults)
    expect(next['new-tab']).toEqual([])
    const effective = new Map(
      resolveEffectiveKeybindings(next, defaults).map(e => [e.commandId, e.bindings]),
    )
    expect(effective.get('new-tab')).toEqual([])
  })

  it('per-command Reset returns to inheriting', () => {
    const edited = setCommandKeybindings({}, 'new-tab', ['Cmd+Shift+9'], defaults)
    const reset = resetCommandKeybindings(edited, 'new-tab')
    const effective = new Map(
      resolveEffectiveKeybindings(reset, defaults).map(e => [e.commandId, e.bindings]),
    )
    expect(effective.get('new-tab')).toEqual(['Cmd+T'])
  })

  it('offers a row for every categorized built-in command', () => {
    // Including commands the palette never renders: they are still reachable
    // by chord, menu and programmatic call, so they are bindable.
    const rowable = builtInCommandCatalog.filter(c => c.category)
    expect(rowable).toHaveLength(builtInCommandCatalog.length)
  })
})
