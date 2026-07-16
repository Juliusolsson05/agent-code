import { describe, expect, it } from 'vitest'

import { shouldPreventOwnedApplicationShortcut } from './useKeybinds'

function ownedShortcut(target: HTMLElement, init: KeyboardEventInit): boolean {
  let shouldPrevent = false
  target.addEventListener('keydown', event => {
    shouldPrevent = shouldPreventOwnedApplicationShortcut(event)
  })
  target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }))
  return shouldPrevent
}

describe('owned-surface shortcut policy', () => {
  it('preserves Option composition and word navigation in editable controls', () => {
    const input = document.createElement('input')

    expect(ownedShortcut(input, { altKey: true, code: 'KeyC', key: 'ç' })).toBe(false)
    expect(ownedShortcut(input, { altKey: true, code: 'ArrowLeft', key: 'ArrowLeft' })).toBe(false)
  })

  it('still suppresses workspace Option chords from non-editable modal chrome', () => {
    const chrome = document.createElement('div')

    expect(ownedShortcut(chrome, { altKey: true, code: 'KeyD', key: 'd' })).toBe(true)
  })

  it('still suppresses browser-level Cmd defaults from modal inputs', () => {
    const input = document.createElement('textarea')

    expect(ownedShortcut(input, { metaKey: true, code: 'KeyW', key: 'w' })).toBe(true)
  })
})
