import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The banner reads two fields of the layout context; mocking the hook keeps
// the test on the banner's own decision rather than the whole workspace.
let context: { restoreStatus: string; saveFailure: string | null } = { restoreStatus: 'complete-restore', saveFailure: null }
vi.mock('@renderer/workspace/WorkspaceContext', () => ({ useWorkspaceLayoutContext: () => context }))

import { RestoreBanner } from './RestoreBanner'

describe('RestoreBanner', () => {
  it('says workspace changes are not being saved, with the storage error (#1244)', () => {
    context = { restoreStatus: 'complete-restore', saveFailure: "EACCES: permission denied, open '/state/workspace.json'" }
    render(<RestoreBanner />)
    expect(screen.getByRole('alert').textContent).toContain("Workspace changes are not being saved: EACCES: permission denied, open '/state/workspace.json'")
  })

  // #1263 review C: a workspace.json this build refused at load stays
  // refused for the whole process, so "changes save on the next success" was
  // false there. The banner says what will actually help.
  it('does not promise a later save when the workspace file is read-only this session', () => {
    context = { restoreStatus: 'complete-restore', saveFailure: 'Workspace file is read-only this session: workspace.json has an unsupported version (9)' }
    render(<RestoreBanner />)
    const text = screen.getByRole('alert').textContent ?? ''
    expect(text).toContain('workspace.json has an unsupported version (9)')
    expect(text).not.toContain('save on the next success')
    expect(text).toContain('Quit Agent Code')
  })

  it('shows nothing while saves work', () => {
    context = { restoreStatus: 'complete-restore', saveFailure: null }
    const { container } = render(<RestoreBanner />)
    expect(container).toBeEmptyDOMElement()
  })

  it('keeps a restore problem first: its autosave-off state is the more severe one', () => {
    context = { restoreStatus: 'partial-restore', saveFailure: 'ENOSPC' }
    render(<RestoreBanner />)
    expect(screen.getByRole('alert').textContent).toContain('partially restored')
  })

  it('labels failing saves "Not saving", expanded and collapsed, never "Autosave off" (#1263 review)', () => {
    vi.useFakeTimers()
    try {
      context = { restoreStatus: 'complete-restore', saveFailure: 'ENOSPC: no space left on device' }
      render(<RestoreBanner />)
      expect(screen.getByRole('alert').textContent).toContain('Not saving')
      expect(screen.getByRole('alert').textContent).not.toContain('Autosave off')
      act(() => { vi.advanceTimersByTime(60_000) })
      expect(screen.getByRole('button', { name: 'Show save-failure details' }).textContent).toContain('Not saving')
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps "Autosave off" for a restore problem, whose autosave really is off', () => {
    vi.useFakeTimers()
    try {
      context = { restoreStatus: 'partial-restore', saveFailure: null }
      render(<RestoreBanner />)
      act(() => { vi.advanceTimersByTime(60_000) })
      expect(screen.getByRole('button', { name: 'Show autosave-off details' }).textContent).toContain('Autosave off')
    } finally {
      vi.useRealTimers()
    }
  })
})

// The degraded-run banner collapses to a corner chip and expands back. Both
// swaps UNMOUNT the control that was just pressed, so focus used to fall to
// <body>: a keyboard user pressed Hide and lost their place, and the
// 60-second auto-collapse did the same to anyone tabbed onto the banner.
// Focus now moves to the counterpart (ledger G-35).
//
// Fixture: a real restore status value from the workspace store's union.

afterEach(() => vi.useRealTimers())

describe('RestoreBanner focus', () => {
  beforeEach(() => { context = { restoreStatus: 'partial-restore', saveFailure: null } })

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
