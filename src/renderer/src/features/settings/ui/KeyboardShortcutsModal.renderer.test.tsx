import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { KeyboardShortcutsModal } from './KeyboardShortcutsModal'

// The shortcut reference (⌘⇧/, plan S26): opens in its search box, renders
// every chord through the shared Kbd (it had its own font-mono span), and is
// scrollable from the keyboard.

describe('Keyboard Shortcuts', () => {
  it('opens in the search box and renders chords through the shared Kbd', () => {
    render(<KeyboardShortcutsModal open onClose={vi.fn()} />)
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Search shortcuts' }))
    const chords = [...document.querySelectorAll('[data-slot="kbd"]')].map(chip => chip.textContent)
    // The palette's shipped default, via the one display projection.
    expect(chords).toContain('⌘⇧P')
  })

  it('steps from the search box into the scrollable results with ↓, and closes from Close ⎋', () => {
    const onClose = vi.fn()
    render(<KeyboardShortcutsModal open onClose={onClose} />)
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Search shortcuts' }), { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByLabelText('Shortcuts'))
    const close = screen.getByRole('button', { name: 'Close' })
    expect(close.querySelector('[data-slot="kbd"]')?.textContent).toBe('⎋')
    fireEvent.click(close)
    expect(onClose).toHaveBeenCalled()
  })
})
