import { describe, expect, it } from 'vitest'

import {
  KeybindingSyntaxError,
  displayKeybinding,
  eventMatchesKeybinding,
  keybindingFromEvent,
  normalizeKeybinding,
  parseKeybinding,
  tryNormalizeKeybinding,
} from '@renderer/features/command-keybindings/normalize'

/** Minimal KeyboardEvent stand-in. The router reads exactly these fields, so a
 *  literal is a more honest input than a constructed DOM event that happy-dom
 *  would populate with values a real macOS keypress never produces. */
const evt = (partial: Partial<KeyboardEvent>): KeyboardEvent =>
  ({
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    code: '',
    key: '',
    ...partial,
  }) as KeyboardEvent

describe('parseKeybinding', () => {
  it('normalizes modifier order regardless of how it was written', () => {
    // Fixed order is what lets string equality BE the collision engine. An
    // order-insensitive comparison would have to be remembered at every call
    // site, and forgotten at one of them.
    expect(normalizeKeybinding('Shift+Cmd+P')).toBe('Cmd+Shift+P')
    expect(normalizeKeybinding('Alt+Cmd+E')).toBe('Cmd+Alt+E')
  })

  it.each([
    ['cmd+p', 'Cmd+P'],
    ['Command+P', 'Cmd+P'],
    ['Meta+P', 'Cmd+P'],
    ['⌘P'.replace('⌘', '⌘+'), 'Cmd+P'],
    ['opt+d', 'Alt+D'],
    ['option+d', 'Alt+D'],
    ['⌥+d', 'Alt+D'],
    ['ctrl+a', 'Ctrl+A'],
  ])('accepts the alias %s', (input, expected) => {
    expect(normalizeKeybinding(input)).toBe(expected)
  })

  it('uppercases letters and leaves digits alone', () => {
    expect(normalizeKeybinding('cmd+w')).toBe('Cmd+W')
    expect(normalizeKeybinding('cmd+1')).toBe('Cmd+1')
  })

  it('normalizes named keys and both arrow spellings', () => {
    expect(normalizeKeybinding('alt+left')).toBe('Alt+Left')
    expect(normalizeKeybinding('Alt+ArrowLeft')).toBe('Alt+Left')
    expect(normalizeKeybinding('end')).toBe('End')
    expect(normalizeKeybinding('alt+pageup')).toBe('Alt+PageUp')
  })

  it('accepts punctuation and function keys', () => {
    expect(normalizeKeybinding('cmd+[')).toBe('Cmd+[')
    expect(normalizeKeybinding('cmd+,')).toBe('Cmd+,')
    expect(normalizeKeybinding('f5')).toBe('F5')
    expect(normalizeKeybinding('cmd+F12')).toBe('Cmd+F12')
  })

  it('is idempotent', () => {
    // Coercion runs on every settings load, so a value that changed on the
    // second pass would drift on every boot.
    const once = normalizeKeybinding('shift+cmd+p')
    expect(normalizeKeybinding(once)).toBe(once)
  })

  describe('rejections', () => {
    it('rejects a multi-step sequence with an actionable message', () => {
      // Accepting `Cmd+K R` and running only the first step would be worse than
      // refusing it: Settings would display a binding the runtime cannot honour.
      expect(() => parseKeybinding('Cmd+K R')).toThrow(KeybindingSyntaxError)
      expect(() => parseKeybinding('Cmd+K R')).toThrow(/Multi-step sequences are not supported/)
    })

    it('rejects a modifier-only binding', () => {
      // Can never fire: a bare modifier keydown has no key to match. Dictation
      // allows modifier-only holds, which is precisely why the command editor
      // must not inherit dictation's capture policy.
      expect(() => parseKeybinding('Cmd')).toThrow(/has no key/)
      expect(() => parseKeybinding('Cmd+Shift')).toThrow(/has no key/)
    })

    it('rejects two keys in one binding', () => {
      expect(() => parseKeybinding('Cmd+A+B')).toThrow(/more than one key/)
    })

    it('rejects a duplicate modifier', () => {
      expect(() => parseKeybinding('Cmd+Cmd+P')).toThrow(/Duplicate modifier/)
    })

    it('rejects an unrecognized key', () => {
      expect(() => parseKeybinding('Cmd+Frobnicate')).toThrow(/Unrecognized key/)
    })

    it('rejects an empty binding', () => {
      expect(() => parseKeybinding('   ')).toThrow(/empty/)
    })
  })

  describe('tryNormalizeKeybinding', () => {
    it('returns null instead of throwing, for coercion paths', () => {
      // Settings boot must survive a corrupt blob; a throw here would black-screen
      // the app on a value nobody can see to fix.
      expect(tryNormalizeKeybinding('Cmd+K R')).toBeNull()
      expect(tryNormalizeKeybinding(42)).toBeNull()
      expect(tryNormalizeKeybinding(null)).toBeNull()
      expect(tryNormalizeKeybinding('cmd+p')).toBe('Cmd+P')
    })
  })
})

describe('keybindingFromEvent', () => {
  it('reads a letter from the physical code, not the produced character', () => {
    // THE macOS case. Option is the text-composition modifier: ⌥D produces "∂".
    // Matching on `event.key` fails for every Option binding, which is most of
    // this app's pane grammar.
    const optionD = evt({ altKey: true, code: 'KeyD', key: '∂' })
    expect(keybindingFromEvent(optionD)).toBe('Alt+D')
  })

  it.each([
    ['ç', 'KeyC', 'Alt+C'],
    ['˚', 'KeyK', 'Alt+K'],
    ['¬', 'KeyL', 'Alt+L'],
    ['˙', 'KeyH', 'Alt+H'],
    ['†', 'KeyT', 'Alt+T'],
  ])('resolves the Option glyph %s to %s', (key, code, expected) => {
    expect(keybindingFromEvent(evt({ altKey: true, code, key }))).toBe(expected)
  })

  it('reads punctuation from the code too', () => {
    // ⌥- produces an en dash on macOS.
    expect(keybindingFromEvent(evt({ altKey: true, code: 'Minus', key: '–' }))).toBe('Alt+-')
    expect(keybindingFromEvent(evt({ metaKey: true, code: 'BracketLeft', key: '[' }))).toBe('Cmd+[')
  })

  it('reads named keys from event.key', () => {
    expect(keybindingFromEvent(evt({ key: 'ArrowLeft', altKey: true }))).toBe('Alt+Left')
    expect(keybindingFromEvent(evt({ key: 'End' }))).toBe('End')
    expect(keybindingFromEvent(evt({ key: 'Escape' }))).toBe('Escape')
  })

  it('does not collapse the numpad onto the number row', () => {
    // Different physical keys. Collapsing them would make a numpad press fire a
    // binding the user assigned to the number row.
    expect(keybindingFromEvent(evt({ metaKey: true, code: 'Digit1', key: '1' }))).toBe('Cmd+1')
    expect(keybindingFromEvent(evt({ metaKey: true, code: 'Numpad1', key: '1' }))).toBeNull()
  })

  it('returns null for a bare modifier press', () => {
    // Not an error — the user is mid-chord and the router has nothing to match.
    expect(keybindingFromEvent(evt({ key: 'Meta', metaKey: true }))).toBeNull()
    expect(keybindingFromEvent(evt({ key: 'Shift', shiftKey: true }))).toBeNull()
  })

  it('emits modifiers in canonical order', () => {
    const e = evt({ metaKey: true, shiftKey: true, altKey: true, code: 'KeyP', key: 'π' })
    expect(keybindingFromEvent(e)).toBe('Cmd+Alt+Shift+P')
  })
})

describe('eventMatchesKeybinding', () => {
  it('matches an Option chord through its produced glyph', () => {
    expect(eventMatchesKeybinding(evt({ altKey: true, code: 'KeyD', key: '∂' }), 'Alt+D')).toBe(true)
  })

  it('does not match when a modifier differs', () => {
    const e = evt({ altKey: true, shiftKey: true, code: 'KeyD', key: 'Î' })
    expect(eventMatchesKeybinding(e, 'Alt+D')).toBe(false)
    expect(eventMatchesKeybinding(e, 'Alt+Shift+D')).toBe(true)
  })
})

describe('displayKeybinding', () => {
  it('renders macOS symbols', () => {
    expect(displayKeybinding('Cmd+Shift+P')).toBe('⌘⇧P')
    expect(displayKeybinding('Alt+D')).toBe('⌥D')
    expect(displayKeybinding('Cmd+Alt+E')).toBe('⌘⌥E')
  })

  it('renders arrows and named keys as symbols where one exists', () => {
    expect(displayKeybinding('Alt+Left')).toBe('⌥←')
    expect(displayKeybinding('Escape')).toBe('⎋')
  })

  it('keeps word keys readable', () => {
    expect(displayKeybinding('Alt+PageUp')).toBe('⌥PageUp')
    expect(displayKeybinding('End')).toBe('End')
  })

  it('renders a malformed value as itself rather than throwing', () => {
    // This runs in a render path; throwing would blank a Settings page over a
    // value the user cannot see to fix.
    expect(displayKeybinding('not a binding')).toBe('not a binding')
  })
})
