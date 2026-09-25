import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { POCKET_FORWARDED_CHORDS, POCKET_LOCAL_CHORDS, chordFromInput } from './guestPolicies'

const key = (key: string, code: string, mods: Partial<{ alt: boolean; meta: boolean; control: boolean; shift: boolean }> = {}, type = 'keyDown') =>
  ({ type, key, code, alt: false, meta: false, control: false, shift: false, ...mods })

describe('chordFromInput', () => {
  it('uses the physical code, so macOS Option chords resolve (⌥S reports key "ß")', () => {
    expect(chordFromInput(key('ß', 'KeyS', { alt: true }))).toBe('Alt+S')
    expect(chordFromInput(key('B', 'KeyB', { meta: true, shift: true }))).toBe('Cmd+Shift+B')
    expect(chordFromInput(key('ArrowLeft', 'ArrowLeft', { alt: true }))).toBe('Alt+Left')
    expect(chordFromInput(key(',', 'Comma', { meta: true }))).toBe('Cmd+,')
  })
  it('ignores key-up and bare modifiers', () => {
    expect(chordFromInput(key('b', 'KeyB', { meta: true }, 'keyUp'))).toBeNull()
    expect(chordFromInput(key('Shift', 'ShiftLeft', { shift: true }))).toBeNull()
  })
})

describe('forwarded chords', () => {
  it('every forwarded chord is a real default binding in the app, so it has somewhere to go', () => {
    // Read the defaults file rather than import it (it is renderer code).
    const defaults = readFileSync(join(__dirname, '../../renderer/src/features/command-keybindings/defaults.ts'), 'utf8')
    const bound = new Set([...defaults.matchAll(/'((?:Cmd|Alt|Ctrl|Shift)[^']*)'/g)].map(m => m[1]!))
    const missing = [...POCKET_FORWARDED_CHORDS].filter(c => !bound.has(c))
    expect(missing).toEqual([])
  })
  it('pocket-local chords never overlap forwarded ones', () => {
    for (const set of Object.values(POCKET_LOCAL_CHORDS)) for (const c of set) expect(POCKET_FORWARDED_CHORDS.has(c)).toBe(false)
  })
  // Review round 3, C #1: every other test in this file DERIVES its cases from
  // the sets, so deleting a chord from either one shipped green. A dropped
  // forward is worse than a dead chord: before-input-event then reports the
  // keystroke as human input, so ⌘⇧B inside a focused page would PAUSE the
  // agent instead of toggling the pocket, and only the PR's manual QA (#1149
  // item 5) would notice. These memberships are the product promise; a
  // trimming refactor must fail here, not in the field.
  it('forwards the chords the control reference promises while a page has focus (⌥S, ⌘⇧B, ⌘⇧P)', () => {
    for (const chord of ['Alt+S', 'Cmd+Shift+B', 'Cmd+Shift+P']) {
      expect(POCKET_FORWARDED_CHORDS.has(chord), chord).toBe(true)
    }
  })
  it('keeps the browser\'s own chords page-local (⌘R, ⌘⇧R, ⌘L, ⌘⇧S)', () => {
    expect(POCKET_LOCAL_CHORDS.reload.has('Cmd+R')).toBe(true)
    expect(POCKET_LOCAL_CHORDS.hardReload.has('Cmd+Shift+R')).toBe(true)
    expect(POCKET_LOCAL_CHORDS.focusAddress.has('Cmd+L')).toBe(true)
    expect(POCKET_LOCAL_CHORDS.pick.has('Cmd+Shift+S')).toBe(true)
  })
})
