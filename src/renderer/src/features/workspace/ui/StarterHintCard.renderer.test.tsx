import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { useAppStore } from '@renderer/app-state/store'
import { StarterHintCard, starterCardVisibleForAgent } from './StarterHintCard'

const original = useAppStore.getState()
afterEach(() => { cleanup(); useAppStore.setState(original, true) })

// The starter card (#992 §4.6) — the Neovim-style "now what?" card the
// operator asked to bundle into this change. What these cases pin is the
// REGISTRY-DRIVEN contract, because that is the property that keeps the card
// true: every chord is read from the same resolution the router performs, so
// a rebinding user sees their chord and a default change can never leave the
// card lying. Hardcoded chord strings would be a plan failure — and this
// suite is the tripwire.

describe('StarterHintCard', () => {
  it('shows the eight fresh-agent slots with live default chords', () => {
    render(<StarterHintCard variant="fresh-agent" />)
    const card = document.querySelector('[data-starter-card]')!

    // Live defaults, through the registry — not literals copied into this
    // file (the `⌘1–9` range excepted: the digit grammar is a reserved
    // interaction, and its row resolves through the reservation table).
    expect(card.textContent).toContain('⌘⇧P')
    expect(card.textContent).toContain('Command Palette')
    expect(card.textContent).toContain('⌘N')
    expect(card.textContent).toContain('New Agent')
    expect(card.textContent).toContain('⌥← / ⌥→')
    expect(card.textContent).toContain('Focus Lane')
    expect(card.textContent).toContain('⌘1–9')
    expect(card.textContent).toContain('Fill Lane')
    expect(card.textContent).toContain('⌥S')
    expect(card.textContent).toContain('Spotlight')
    expect(card.textContent).toContain('⌥⌫')
    expect(card.textContent).toContain('Clear Lane')
  })

  it('renders unbound commands title-only, not with an invented chord', () => {
    // New Lane and New Row ship no default binding; the honest card names
    // them without a chord (Settings is where bindings are made). The
    // tripwire: any ⌥L-style invention here is the "second source of truth"
    // failure the plan names.
    render(<StarterHintCard variant="fresh-agent" />)
    const card = document.querySelector('[data-starter-card]')!
    expect(card.textContent).toContain('New Lane')
    expect(card.textContent).toContain('New Row')
    expect(card.textContent).not.toContain('⌥L')
  })

  it('shows the USER chord when a command is rebound', () => {
    useAppStore.setState({
      settings: {
        ...original.settings,
        commandKeybindingOverrides: { 'clear-focused-lane': ['Ctrl+Alt+Backspace'] },
      },
    } as never)
    render(<StarterHintCard variant="fresh-agent" />)
    // Row-scoped, not textContent-wide: '⌃⌥⌫' contains the substring '⌥⌫',
    // so the honest assertion is what THE CLEAR LANE ROW shows.
    const clearLaneRow = screen.getByText('Clear Lane').parentElement!
    // ⌃⌥⌫ contains ⌥⌫ as a substring, so assert the row's kbd EXACTLY.
    const kbd = clearLaneRow.querySelector('kbd')!
    expect(kbd.textContent).toBe('⌃⌥⌫')
  })

  it('shows exactly the four placement-flavored slots in the empty-lane variant', () => {
    render(<StarterHintCard variant="empty-lane" />)
    const card = document.querySelector('[data-starter-card]')!
    expect(card.textContent).toContain('Fill Lane')
    expect(card.textContent).toContain('New Lane')
    expect(card.textContent).toContain('Command Palette')
    expect(card.textContent).toContain('⌥↑ / ⌥↓')
    // The pair is named for the gesture, not for one half of it (#1013
    // review B: this row read "Select Previous Agent ⌥↑ / ⌥↓").
    expect(card.textContent).toContain('Select Agent')
    expect(card.textContent).not.toContain('Select Previous Agent')
    // The fresh-agent-only slots stay out: an empty lane has no agent yet,
    // so Clear Lane and Spotlight answer questions this lane cannot ask.
    expect(card.textContent).not.toContain('Clear Lane')
    expect(card.textContent).not.toContain('Spotlight')
    expect(card.textContent).not.toContain('New Row')
  })
})

describe('starterCardVisibleForAgent', () => {
  it('is true for an agent with no user turn yet, and false the moment one exists', () => {
    const meta = { kind: 'claude' as const }
    expect(starterCardVisibleForAgent(meta, [])).toBe(true)
    expect(starterCardVisibleForAgent(meta, [{ type: 'assistant' }])).toBe(true)
    // The welcome banner is not a user turn; the first prompt is the event.
    expect(starterCardVisibleForAgent(meta, [{ type: 'assistant' }, { type: 'user' }])).toBe(false)
  })

  it('is false for terminals and extension views — the card is a rendered-agent feature', () => {
    // §4.6: terminal lanes never get the card. (AgentTerminalLeaf never
    // mounts it structurally; this guards the data path too, so a future
    // caller cannot reintroduce it by asking.)
    expect(starterCardVisibleForAgent({ kind: 'terminal' }, [])).toBe(false)
    expect(starterCardVisibleForAgent({ kind: 'extension-view' }, [])).toBe(false)
    expect(starterCardVisibleForAgent(undefined, [])).toBe(false)
  })
})
