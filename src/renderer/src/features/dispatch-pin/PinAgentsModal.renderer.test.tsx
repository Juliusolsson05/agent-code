import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { PinAgentsModal, type PinAgentsModalRow } from './PinAgentsModal'

// Pin Agents moved onto the shared list navigation and dialog anatomy (plan
// S2). #867's Enter/Space ownership stays pinned in focusedCancelEnter; this
// file pins what the migration ADDED for a keyboard user.

const rows: PinAgentsModalRow[] = Array.from({ length: 30 }, (_, index) => ({
  sessionId: `s${index}` as never,
  tabIndex: 0,
  tabTitle: 'Project',
  title: `Agent ${index}`,
}))

function harness() {
  const onConfirm = vi.fn()
  render(<PinAgentsModal open rows={rows} initialSelectedIds={[]} onCancel={() => {}} onConfirm={onConfirm} />)
  const dialog = screen.getByRole('dialog')
  const highlighted = () =>
    screen.getByRole('listbox').getAttribute('aria-activedescendant')
  return { dialog, highlighted, onConfirm }
}

describe('Pin Sessions keyboard', () => {
  it('jumps with End/Home and pages with PageDown on a long list', () => {
    // The hand-rolled handler only knew ↑↓ and j/k: reaching the 30th agent
    // took 29 presses.
    const { dialog, highlighted } = harness()
    fireEvent.keyDown(dialog, { key: 'End' })
    expect(highlighted()).toBe('pin-agents-row-s29')
    fireEvent.keyDown(dialog, { key: 'Home' })
    expect(highlighted()).toBe('pin-agents-row-s0')
    fireEvent.keyDown(dialog, { key: 'PageDown' })
    expect(highlighted()).toBe('pin-agents-row-s10')
  })

  it('keeps j/k and Space toggling, and commits the toggled draft on Enter', () => {
    const { dialog, onConfirm } = harness()
    fireEvent.keyDown(dialog, { key: 'j' })
    fireEvent.keyDown(dialog, { key: ' ' })
    fireEvent.keyDown(dialog, { key: 'Enter' })
    expect(onConfirm).toHaveBeenCalledWith(['s1'])
  })

  it('shows the key legend in the footer, not as a row in the body', () => {
    harness()
    const footer = document.querySelector('[data-slot="dialog-footer"]')!
    const legend = document.querySelector('[data-slot="kbd-legend"]')
    expect(legend).not.toBeNull()
    expect(footer.contains(legend)).toBe(true)
    // Enter commits, so the confirm says so.
    expect(screen.getByRole('button', { name: /Pin 0 Agents/ }).querySelector('[data-slot="kbd"]')?.textContent).toBe('↩')
  })
})
