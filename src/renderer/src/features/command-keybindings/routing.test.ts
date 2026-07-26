import { describe, expect, it } from 'vitest'

import { buildDefaultKeybindings } from '@renderer/features/command-keybindings/defaults'
import { resolveEffectiveKeybindings } from '@renderer/features/command-keybindings/resolve'
import { builtInCommandCatalog } from '@renderer/features/command-palette/catalog'
import { PALETTE_SELF_EXCLUDED_COMMAND_IDS } from '@renderer/features/command-palette/commands/paletteCommands'

// ---------------------------------------------------------------------------
// Phase 4: the keyboard router now resolves EFFECTIVE bindings and hands the
// command id to the execution gateway, instead of calling workspace actions
// directly.
//
// These assert the properties that make a user's rebinding real. The router
// itself is a DOM capture handler; exercising it end to end needs a mounted
// workspace, so what is pinned here is the data contract it consumes — which
// is where the drift the audit found actually lived.
// ---------------------------------------------------------------------------

const catalogIds = new Set(builtInCommandCatalog.map(c => c.id))

describe('routed command bindings', () => {
  it('every shipped default names a real catalog command', () => {
    // A binding for an id nothing ships is a chord that reserves a key and can
    // never fire.
    for (const entry of buildDefaultKeybindings()) {
      expect(catalogIds.has(entry.commandId)).toBe(true)
    }
  })

  it('a user override replaces the chord the router will match', () => {
    // THE property that makes Settings real rather than cosmetic. Before this
    // phase, editing a binding changed a display string while useKeybinds kept
    // running the hardcoded chord.
    const effective = resolveEffectiveKeybindings({ 'new-tab': ['Cmd+Shift+9'] })
    const newTab = effective.find(e => e.commandId === 'new-tab')
    expect(newTab?.bindings).toEqual(['Cmd+Shift+9'])
    expect(newTab?.bindings).not.toContain('Cmd+T')
  })

  it('an explicit unbind leaves the command with no chord', () => {
    const effective = resolveEffectiveKeybindings({ 'close-pane': [] })
    expect(effective.find(e => e.commandId === 'close-pane')?.bindings).toEqual([])
  })

  it('resolves both aliases for a multi-bound command', () => {
    // Alt+W was live and undeclared before this work; the router now matches
    // it through the same declared set the palette displays.
    const effective = resolveEffectiveKeybindings({})
    expect(effective.find(e => e.commandId === 'close-pane')?.bindings)
      .toEqual(['Cmd+W', 'Alt+W'])
    expect(effective.find(e => e.commandId === 'nav-left')?.bindings)
      .toEqual(['Alt+H', 'Alt+Left'])
  })

  it('gives the command palette its own rebindable chord', () => {
    // Cmd+Shift+P used to be a hard-coded callback with no command id, so it
    // could not be rebound, listed, or collision-checked.
    const effective = resolveEffectiveKeybindings({})
    expect(effective.find(e => e.commandId === 'open-command-palette')?.bindings)
      .toEqual(['Cmd+Shift+P'])
  })

  it('keeps palette-self commands out of the close-after-run rule', () => {
    // Cmd+Shift+P arrives with closeAfterRun=true (the palette was shut when
    // the chord fired). Honouring that blindly would open and close it in one
    // frame, so the exclusion set is what keeps the chord working.
    expect(PALETTE_SELF_EXCLUDED_COMMAND_IDS.has('open-command-palette')).toBe(true)
  })
})
