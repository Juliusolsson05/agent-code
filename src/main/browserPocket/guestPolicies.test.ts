import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { POCKET_FORWARDED_CHORDS, POCKET_LOCAL_CHORDS, chordFromInput } from './guestPolicies'

const key = (key: string, mods: Partial<{ alt: boolean; meta: boolean; control: boolean; shift: boolean }> = {}, type = 'keyDown') =>
  ({ type, key, alt: false, meta: false, control: false, shift: false, ...mods })

describe('chordFromInput', () => {
  it('produces the keybinding syntax', () => {
    expect(chordFromInput(key('s', { alt: true }))).toBe('Alt+S')
    expect(chordFromInput(key('b', { meta: true, shift: true }))).toBe('Cmd+Shift+B')
    expect(chordFromInput(key('ArrowLeft', { alt: true }))).toBe('Alt+Left')
    expect(chordFromInput(key(',', { meta: true }))).toBe('Cmd+,')
  })
  it('ignores key-up and bare modifiers', () => {
    expect(chordFromInput(key('b', { meta: true }, 'keyUp'))).toBeNull()
    expect(chordFromInput(key('Shift', { shift: true }))).toBeNull()
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
})
