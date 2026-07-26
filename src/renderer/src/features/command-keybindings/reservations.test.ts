import { describe, expect, it } from 'vitest'

import {
  buildDefaultKeybindings,
  contextsOverlap,
} from '@renderer/features/command-keybindings/defaults'
import {
  RESERVED_INTERACTIONS,
  findBindingCollisions,
  findBindingOwners,
  listApprovedOverlaps,
} from '@renderer/features/command-keybindings/reservations'

describe('context overlap matrix', () => {
  it('treats grid and dispatch as mutually exclusive', () => {
    // Two states of one layout switch. ⌥K focusing a grid pane and ⌥K moving
    // the Dispatch selection is one gesture with two meanings, not a conflict.
    expect(contextsOverlap('grid', 'dispatch')).toBe(false)
  })

  it('treats every other pair as potentially simultaneous', () => {
    // No generic "different surface means safe" escape hatch: the editor
    // overlays the workspace, the feed sits inside a pane, and global is by
    // definition everywhere.
    expect(contextsOverlap('global', 'editor')).toBe(true)
    expect(contextsOverlap('global', 'grid')).toBe(true)
    expect(contextsOverlap('editor', 'feed')).toBe(true)
    expect(contextsOverlap('feed', 'grid')).toBe(true)
  })

  it('treats a context as overlapping itself', () => {
    expect(contextsOverlap('grid', 'grid')).toBe(true)
  })
})

describe('shipped defaults', () => {
  const defaults = buildDefaultKeybindings()

  it('parses every shipped binding', () => {
    // buildDefaultKeybindings normalizes on the way out, so an authoring typo
    // throws at module load here rather than producing a binding that silently
    // never matches any key the user can press.
    expect(() => buildDefaultKeybindings()).not.toThrow()
  })

  it('declares no duplicate binding within a single command', () => {
    for (const entry of defaults) {
      expect(new Set(entry.bindings).size).toBe(entry.bindings.length)
    }
  })

  it('preserves the previously undisclosed aliases', () => {
    // These ran before this change but were never advertised. Dropping them
    // would be a silent regression for anyone with the muscle memory; declaring
    // them is what lets Settings finally show and unbind them.
    const byId = new Map(defaults.map(d => [d.commandId, d]))
    expect(byId.get('close-pane')?.bindings).toContain('Alt+W')
    expect(byId.get('nav-left')?.bindings).toContain('Alt+Left')
    expect(byId.get('nav-up')?.bindings).toContain('Alt+Up')
  })

  it('fills the Global Editor metadata gap', () => {
    const byId = new Map(defaults.map(d => [d.commandId, d]))
    expect(byId.get('toggle-global-editor')?.bindings).toEqual(['Cmd+Shift+E'])
  })

  it('adds exactly one genuinely new chord', () => {
    // ⌘, for Settings is the only default that did not already run. Everything
    // else is preserved muscle memory, so upgrading users lose nothing.
    const byId = new Map(defaults.map(d => [d.commandId, d]))
    expect(byId.get('open-settings')?.bindings).toEqual(['Cmd+,'])
  })

  it('derives per-provider chords from the provider registry', () => {
    // The one chord family that already had a single source of truth. Keeping
    // it derived means adding a provider cannot leave metadata and behavior
    // disagreeing.
    const byId = new Map(defaults.map(d => [d.commandId, d]))
    expect(byId.get('codex-vertical')?.bindings).toEqual(['Alt+C'])
    expect(byId.get('codex-horizontal')?.bindings).toEqual(['Alt+Shift+C'])
    // OpenCode declares no splitShortcutKey, so it ships unbound. Deliberate
    // scarcity, not an oversight.
    expect(byId.has('opencode-vertical')).toBe(false)
  })

  it('scopes editor and feed bindings to their own contexts', () => {
    const byId = new Map(defaults.map(d => [d.commandId, d]))
    // Cmd+S must not be global or it would fire outside the editor.
    expect(byId.get('save-editor-file')?.context).toBe('editor')
    // Bare End must not be global or it would collide with End in any composer.
    expect(byId.get('jump-latest-message')?.context).toBe('feed')
  })
})

describe('findBindingCollisions', () => {
  it('reports a clash between two overlapping-context owners', () => {
    const collisions = findBindingCollisions({
      commandDefaults: [
        { commandId: 'a', bindings: ['Cmd+J'], context: 'global' },
        { commandId: 'b', bindings: ['Cmd+J'], context: 'editor' },
      ],
      reserved: [],
    })
    expect(collisions).toHaveLength(1)
    expect(collisions[0].binding).toBe('Cmd+J')
    expect(collisions[0].owners.map(o => o.id).sort()).toEqual(['a', 'b'])
  })

  it('allows the same chord in mutually exclusive contexts', () => {
    // The grid/dispatch case, which is legal by the overlap matrix.
    const collisions = findBindingCollisions({
      commandDefaults: [
        { commandId: 'grid-thing', bindings: ['Alt+K'], context: 'grid' },
        { commandId: 'dispatch-thing', bindings: ['Alt+K'], context: 'dispatch' },
      ],
      reserved: [],
    })
    expect(collisions).toEqual([])
  })

  it('reports a clash with a reserved interaction', () => {
    const collisions = findBindingCollisions({
      commandDefaults: [{ commandId: 'a', bindings: ['Escape'], context: 'global' }],
    })
    expect(collisions.map(c => c.binding)).toContain('Escape')
  })

  it('reports a clash with the current dictation hotkey', () => {
    const collisions = findBindingCollisions({
      commandDefaults: [{ commandId: 'a', bindings: ['Cmd+Alt+D'], context: 'global' }],
      reserved: [],
      dictationBinding: 'Cmd+Alt+D',
    })
    expect(collisions).toHaveLength(1)
    expect(collisions[0].owners.map(o => o.id)).toContain('Voice dictation hotkey')
  })

  it('finds no unapproved collision among the shipped defaults', () => {
    // THE gate. If this fails, two shipped chords fight and the winner is
    // decided by registration order — which is an accident, not a policy.
    const collisions = findBindingCollisions({
      commandDefaults: buildDefaultKeybindings(),
      reserved: RESERVED_INTERACTIONS,
    })
    expect(collisions).toEqual([])
  })

  it('suppresses only the exact approved owner pair', () => {
    // Cmd+W is a genuine overlap (close-pane globally vs editor-native close
    // file) that the app resolves by focus precedence, so it is approved. That
    // approval must not generalize into "Cmd+W is free" — a third owner
    // appearing later has to be reported.
    const collisions = findBindingCollisions({
      commandDefaults: [
        { commandId: 'close-pane', bindings: ['Cmd+W'], context: 'global' },
        { commandId: 'interloper', bindings: ['Cmd+W'], context: 'global' },
      ],
      reserved: RESERVED_INTERACTIONS.filter(r => r.owner === 'Editor-native close file'),
    })
    expect(collisions.map(c => c.binding)).toEqual(['Cmd+W'])
  })
})

describe('approved overlaps', () => {
  it('documents a reason for every approved overlap', () => {
    // An approved overlap is a promise that some handler resolves the ambiguity
    // before either owner runs. An entry with no stated reason is a promise
    // nobody can check.
    for (const approved of listApprovedOverlaps()) {
      expect(approved.reason.length).toBeGreaterThan(40)
      expect(approved.owners.length).toBeGreaterThanOrEqual(2)
    }
  })
})

describe('findBindingOwners', () => {
  const defaults = buildDefaultKeybindings()

  it('names the command that owns a chord', () => {
    // "That shortcut is taken" is not actionable. "⌘T is used by new-tab" is.
    const owners = findBindingOwners({
      binding: 'Cmd+T',
      context: 'global',
      commandDefaults: defaults,
    })
    expect(owners.map(o => o.id)).toContain('new-tab')
  })

  it('names a reserved interaction', () => {
    const owners = findBindingOwners({
      binding: 'Escape',
      context: 'global',
      commandDefaults: defaults,
    })
    expect(owners.map(o => o.id)).toContain('Dismiss modal, picker, Spotlight, Reader, or fullscreen')
  })

  it('does not report a command as conflicting with itself', () => {
    // Re-saving an unchanged binding must not be blocked.
    const owners = findBindingOwners({
      binding: 'Cmd+T',
      context: 'global',
      commandDefaults: defaults,
      excludeCommandId: 'new-tab',
    })
    expect(owners.map(o => o.id)).not.toContain('new-tab')
  })

  it('reports nothing for a free chord', () => {
    expect(
      findBindingOwners({
        binding: 'Cmd+Shift+Alt+Y',
        context: 'global',
        commandDefaults: defaults,
      }),
    ).toEqual([])
  })
})
