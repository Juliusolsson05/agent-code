import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { RestoreBanner } from '@renderer/app/shell/RestoreBanner'

// The degraded-run banner collapses to a corner chip and expands back. Both
// swaps UNMOUNT the control that was just pressed, so focus used to fall to
// <body>: a keyboard user pressed Hide and lost their place, and the
// 60-second auto-collapse did the same to anyone tabbed onto the banner.
// Focus now moves to the counterpart (ledger G-35).
//
// Fixture: a real restore status value from the workspace store's union.

vi.mock('@renderer/workspace/WorkspaceContext', () => ({
  useWorkspaceLayoutContext: () => ({ restoreStatus: 'partial-restore' }),
}))

afterEach(() => vi.useRealTimers())

describe('RestoreBanner focus', () => {
  it('moves focus to the chip on Hide, and back to Hide on expand', () => {
    render(<RestoreBanner />)
    const hide = screen.getByRole('button', { name: 'Collapse autosave-off banner' })
    hide.focus()
    fireEvent.click(hide)
    const chip = screen.getByRole('button', { name: 'Show autosave-off details' })
    expect(document.activeElement).toBe(chip)

    fireEvent.click(chip)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Collapse autosave-off banner' }))
  })

  it('carries focus into the chip when the banner auto-collapses under it', () => {
    vi.useFakeTimers()
    render(<RestoreBanner />)
    screen.getByRole('button', { name: 'Collapse autosave-off banner' }).focus()
    act(() => { vi.advanceTimersByTime(60_000) })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Show autosave-off details' }))
  })

  it('does not steal focus when the banner auto-collapses while the user is elsewhere', () => {
    vi.useFakeTimers()
    const elsewhere = document.createElement('textarea')
    document.body.appendChild(elsewhere)
    render(<RestoreBanner />)
    elsewhere.focus()
    act(() => { vi.advanceTimersByTime(60_000) })
    expect(document.activeElement).toBe(elsewhere)
    elsewhere.remove()
  })
})
