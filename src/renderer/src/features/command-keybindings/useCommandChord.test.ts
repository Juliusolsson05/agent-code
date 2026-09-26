import { describe, expect, it } from 'vitest'

import { commandChordLabel, withChord } from './useCommandChord'

// The contract every live hint relies on (keyboard-first plan H4): the chord
// shown is the USER's, derived through the same resolution the router uses,
// and an unbound command shows no chord rather than the shipped default.

describe('commandChordLabel', () => {
  it('shows the shipped default when the user has not rebound the command', () => {
    expect(commandChordLabel('new-tab', {})).toBe('⌘T')
  })

  it('follows a user rebind', () => {
    expect(commandChordLabel('new-tab', { 'new-tab': ['Cmd+Shift+Y'] })).toBe('⌘⇧Y')
  })

  it('shows nothing for a command the user explicitly unbound', () => {
    // `[]` means "unbound" in the override store; falling back to the default
    // here would put a chord that does nothing on screen.
    expect(commandChordLabel('new-tab', { 'new-tab': [] })).toBeNull()
  })

  it('names the first binding of a multi-binding command, like the palette', () => {
    expect(commandChordLabel('close-pane', {})).toBe('⌘W')
  })
})

describe('withChord', () => {
  it('omits the parenthesis entirely when there is no chord', () => {
    expect(withChord('New Tab', null)).toBe('New Tab')
    expect(withChord('New Tab', '⌘T')).toBe('New Tab (⌘T)')
  })
})
