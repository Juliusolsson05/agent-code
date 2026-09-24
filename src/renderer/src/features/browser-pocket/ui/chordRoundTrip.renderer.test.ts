import { expect, it } from 'vitest'

import { chordFromInput, forwardedKeyFromInput, POCKET_FORWARDED_CHORDS } from '@main/browserPocket/guestPolicies'
import { keybindingFromEvent } from '@shared/keybindings'

import { keyboardEventFor } from './usePocketBridges'

// The two halves of chord forwarding must agree: main decides a guest key is
// an app chord, and the renderer replays it into the router, which normalizes
// it AGAIN. If they disagreed, ⌥S pressed inside a page would be swallowed by
// main and then match nothing in the router.
//
// Inputs mimic what macOS delivers: Option changes `key` to a symbol (⌥S →
// "ß", ⌥H → "˙") while `code` stays physical.
const MAC_OPTION_KEYS: Record<string, string> = { S: 'ß', H: '˙', J: '∆', K: '˚', L: '¬' }

function macInput(chord: string) {
  const parts = chord.split('+')
  const token = parts[parts.length - 1]!
  const alt = parts.includes('Alt')
  const code = /^[A-Z]$/.test(token) ? `Key${token}` : token === ',' ? 'Comma' : ['Left', 'Right', 'Up', 'Down'].includes(token) ? `Arrow${token}` : token
  const key = /^[A-Z]$/.test(token) ? (alt ? MAC_OPTION_KEYS[token] ?? token.toLowerCase() : token.toLowerCase()) : ['Left', 'Right', 'Up', 'Down'].includes(token) ? `Arrow${token}` : token
  return { type: 'keyDown', key, code, meta: parts.includes('Cmd'), control: parts.includes('Ctrl'), alt, shift: parts.includes('Shift') }
}

it.each([...POCKET_FORWARDED_CHORDS])('%s survives guest → main → renderer router unchanged', chord => {
  const input = macInput(chord)
  expect(chordFromInput(input)).toBe(chord)
  expect(keybindingFromEvent(keyboardEventFor(forwardedKeyFromInput(input)))).toBe(chord)
})
