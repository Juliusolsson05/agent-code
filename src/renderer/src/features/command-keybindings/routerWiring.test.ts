import { describe, expect, it } from 'vitest'

import { buildDefaultKeybindings, contextsOverlap } from '@renderer/features/command-keybindings/defaults'
import { resolveEffectiveKeybindings } from '@renderer/features/command-keybindings/resolve'
import { toMonacoChord } from '@renderer/features/command-keybindings/normalize'
import { builtInCommandCatalog } from '@renderer/features/command-palette/catalog'

// ---------------------------------------------------------------------------
// R1 wiring tests.
//
// The original suite tested each new module in isolation and every module
// passed, while the WIRING between them was broken in four separate ways. These
// assert the joins, which is where all four defects lived.
// ---------------------------------------------------------------------------

const defaults = buildDefaultKeybindings()
const catalogIds = new Set(builtInCommandCatalog.map(c => c.id))

describe('every advertised binding is dispatchable', () => {
  it('routes every command that ships a default, except surface-owned ones', () => {
    // The defect this replaces: a hand-written 24-id allow-list while Settings
    // offered bindings for all 98 commands, so 74 rows persisted and displayed
    // a chord that could never fire.
    //
    // Now that routing is derived, the only commands excluded are those a
    // different surface owns. That set must stay tiny and deliberate.
    const surfaceOwned = new Set(['save-editor-file'])
    const unroutable = defaults
      .map(entry => entry.commandId)
      .filter(id => surfaceOwned.has(id))
    expect(unroutable).toEqual(['save-editor-file'])
  })

  it('gives every shipped default a real catalog command', () => {
    for (const entry of defaults) {
      expect(catalogIds.has(entry.commandId)).toBe(true)
    }
  })
})

describe('context filtering', () => {
  // The defect: the router matched on chord alone, so in Dispatch the
  // grid-context nav commands were matched, preventDefault-ed, and then
  // refused by admission — leaving the Dispatch handler unreachable.

  const contextOf = (id: string) => defaults.find(e => e.commandId === id)?.context

  // DELETED (#992): 'keeps navigation commands in the grid context' — the
  // nav-* commands died with the tile tree, and the 'grid' context followed in
  // stage 5 when the lane-stage gestures (⌥ arrows / HJKL) became registered
  // 'dispatch' commands (dispatch-select-previous/next-agent,
  // dispatch-focus-lane-left/right).

  it('keeps the lane grammar in the layout context and the editor disjoint', () => {
    // The one remaining disjoint pair: it is what lets a chord be a layout
    // gesture here and a Monaco command inside the editor.
    expect(contextsOverlap('dispatch', 'editor')).toBe(false)
    expect(contextOf('dispatch-select-previous-agent')).toBe('dispatch')
    expect(contextOf('dispatch-focus-lane-left')).toBe('dispatch')
  })

  it('scopes the feed binding so it cannot steal from a composer', () => {
    // Bare End is only routable when a rendered feed is focused AND the target
    // is not text-editing; the router computes 'feed' from both conditions.
    expect(contextOf('jump-latest-message')).toBe('feed')
  })

  it('keeps editor-owned chords in the editor context', () => {
    expect(contextOf('save-editor-file')).toBe('editor')
  })
})

describe('effective bindings drive the editor too', () => {
  it('translates the default save chord for Monaco', () => {
    // Monaco used to hard-code CtrlCmd|KeyS, so rebinding Save changed the
    // displayed chord and nothing else.
    const [binding] = resolveEffectiveKeybindings({})
      .filter(e => e.commandId === 'save-editor-file')
      .flatMap(e => e.bindings)
    expect(binding).toBe('Cmd+S')
    expect(toMonacoChord(binding)).toEqual({
      ctrlCmd: true, shift: false, alt: false, keyCode: 'KeyS',
    })
  })

  it('follows a rebinding', () => {
    const overrides = { 'save-editor-file': ['Cmd+Alt+S'] }
    const [binding] = resolveEffectiveKeybindings(overrides)
      .filter(e => e.commandId === 'save-editor-file')
      .flatMap(e => e.bindings)
    expect(toMonacoChord(binding)).toEqual({
      ctrlCmd: true, shift: false, alt: true, keyCode: 'KeyS',
    })
  })

  it('registers nothing rather than the wrong chord when Save is unbound', () => {
    // "Not assigned" has to mean it. Falling back to Cmd+S would make the
    // Settings row a lie.
    const bindings = resolveEffectiveKeybindings({ 'save-editor-file': [] })
      .filter(e => e.commandId === 'save-editor-file')
      .flatMap(e => e.bindings)
    expect(bindings).toEqual([])
  })

  it('refuses a chord Monaco cannot express rather than approximating it', () => {
    // Ctrl maps to Monaco's WinCtrl; conflating it with CtrlCmd would make
    // Ctrl+S behave as Cmd+S on macOS.
    expect(toMonacoChord('Ctrl+S')).toBeNull()
    expect(toMonacoChord('not a binding')).toBeNull()
  })
})

describe('unbinding is real', () => {
  it('leaves a command with no chord at all', () => {
    // The legacy hard-coded branches have been deleted, so an empty effective
    // set now means the chord genuinely does nothing.
    const effective = new Map(
      resolveEffectiveKeybindings({ 'new-tab': [] }).map(e => [e.commandId, e.bindings]),
    )
    expect(effective.get('new-tab')).toEqual([])
  })

  it('moves a chord completely when rebound', () => {
    const effective = new Map(
      resolveEffectiveKeybindings({ 'new-tab': ['Cmd+Alt+N'] }).map(e => [e.commandId, e.bindings]),
    )
    expect(effective.get('new-tab')).toEqual(['Cmd+Alt+N'])
    expect(effective.get('new-tab')).not.toContain('Cmd+T')
  })
})
