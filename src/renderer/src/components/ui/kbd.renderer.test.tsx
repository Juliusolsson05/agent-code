import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { Kbd, KbdLegend } from './kbd'

// Kbd is the only key-hint renderer in the app (keyboard-first plan H1). The
// contract worth pinning is the one that keeps hints honest: a canonical
// binding is shown through displayKeybinding — the same projection the
// palette and Settings use — so a rebind can never leave a chip spelling the
// old chord differently from everywhere else.

describe('Kbd', () => {
  it('formats a canonical binding with the shared display projection', () => {
    render(<Kbd binding="Cmd+Shift+P" data-testid="chip" />)
    expect(screen.getByTestId('chip')).toHaveTextContent('⌘⇧P')
  })

  it('renders a malformed binding as itself instead of throwing in render', () => {
    // A range like ⌘1–9 is not a binding; it must still render, because the
    // alternative is a legend that blanks its whole dialog.
    render(<Kbd binding="⌘1–9" data-testid="chip" />)
    expect(screen.getByTestId('chip')).toHaveTextContent('⌘1–9')
  })

  it('is hidden from assistive tech by default, since it duplicates a label', () => {
    render(<Kbd binding="Escape" data-testid="chip" />)
    expect(screen.getByTestId('chip')).toHaveAttribute('aria-hidden', 'true')
  })
})

describe('KbdLegend', () => {
  it('exposes each key/verb pair to assistive tech', () => {
    render(<KbdLegend items={[{ keys: ['Up', 'Down'], label: 'move' }, { keys: ['Space'], label: 'toggle' }]} />)
    const chips = document.querySelectorAll('[data-slot="kbd"]')
    expect([...chips].map(chip => chip.textContent)).toEqual(['↑', '↓', '␣'])
    for (const chip of chips) expect(chip).toHaveAttribute('aria-hidden', 'false')
    expect(screen.getByText('move')).toBeInTheDocument()
  })
})
