import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { Workspace } from '@renderer/workspace/workspaceStore'

import { GridDispatchShapeOverlay } from './GridDispatchShapeOverlay'

// Grid Dispatch shape editor (plan S11): Enter applies from a number field
// and the footer says so; the Simple/Advanced switch and the per-row nested
// agents choice announce their state instead of relying on colour and
// "(•)" glyphs.

function harness(capChildren?: boolean) {
  const setDispatchGridShape = vi.fn(() => true)
  const workspace = {
    state: {
      tabs: [{ id: 'a', title: 'app' }],
      stage: { focusedLane: 0, lanes: [{}, {}], rows: [{ length: 2, capChildren }] },
    },
    setDispatchGridShape,
    setDispatchRowProjects: vi.fn(),
    setDispatchRowCapChildren: vi.fn(),
  } as unknown as Workspace
  render(<GridDispatchShapeOverlay workspace={workspace} onClose={() => {}} />)
  return { setDispatchGridShape }
}

describe('Grid Dispatch shape editor', () => {
  it('opens in the first lane count and applies on Enter, with Apply ↩ saying so', () => {
    const { setDispatchGridShape } = harness()
    const input = screen.getByRole('spinbutton', { name: 'Row 1 lane count' })
    expect(document.activeElement).toBe(input)
    expect(screen.getByRole('button', { name: 'Apply' }).querySelector('[data-slot="kbd"]')?.textContent).toBe('↩')
    expect(screen.getByRole('button', { name: 'Cancel' }).querySelector('[data-slot="kbd"]')?.textContent).toBe('⎋')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(setDispatchGridShape).toHaveBeenCalled()
  })

  it('announces which mode is on, and the nested-agents choice as a radio group', () => {
    harness(false) // capChildren false → opens in Advanced
    expect(screen.getByRole('button', { name: 'Advanced' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Simple' })).toHaveAttribute('aria-pressed', 'false')
    const group = screen.getByRole('radiogroup', { name: 'Row 1 nested agents' })
    expect(group).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /Show all/ })).toHaveAttribute('aria-checked', 'true')
  })

  it('makes the nested-agents pair one Tab stop whose arrows choose (ledger N5, steering k9)', () => {
    const { setDispatchGridShape } = harness(false)
    const showAll = screen.getByRole('radio', { name: /Show all/ })
    const cap = screen.getByRole('radio', { name: /Cap/ })
    // The checked one is the stop; a radio group is one Tab, not two.
    expect([showAll.tabIndex, cap.tabIndex]).toEqual([0, -1])
    showAll.focus()
    fireEvent.keyDown(showAll, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(cap)
    // The arrow CHOSE Cap in the draft (APG radios), and it never reached the
    // dialog: nothing was applied.
    expect(cap).toHaveAttribute('aria-checked', 'true')
    expect(setDispatchGridShape).not.toHaveBeenCalled()
  })
})
