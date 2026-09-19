import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { PeekOverlay } from './PeekOverlay'
import { providerBadge } from './providerIdentity'

// The peek overlay's contract is the desktop TldrOverlay/TldrFreshness
// pair brought to touch: opaque canvas cover, honest fallbacks, the
// freshness footer pair (Last active / Note written|Goal set), and the
// TLDR<->Goal toggle chip that does NOT dismiss.

const RECORD = { text: 'Fixing the feed gutter', updatedAt: '2026-09-17T10:00:00Z', revision: 3 }

describe('PeekOverlay', () => {
  it('shows the record text with the freshness footer pair', () => {
    render(
      <PeekOverlay
        kind="tldr"
        record={RECORD}
        lastActiveAt={Date.now() - 10_000}
        onDismiss={() => {}}
        onToggleKind={() => {}}
      />,
    )
    expect(screen.getByRole('note').textContent).toContain('Fixing the feed gutter')
    expect(screen.getByRole('note').textContent).toContain('Last active now')
    expect(screen.getByRole('note').textContent).toContain('Note written')
    expect(screen.getByText('show goal')).toBeTruthy()
  })

  it('uses the Goal wording for the goal kind and falls back honestly', () => {
    render(
      <PeekOverlay
        kind="goal"
        record={null}
        lastActiveAt={null}
        onDismiss={() => {}}
        onToggleKind={() => {}}
      />,
    )
    const note = screen.getByRole('note')
    expect(note.textContent).toContain('No goal set yet')
    expect(note.textContent).toContain('Last active unknown')
    expect(note.textContent).toContain('Goal set —')
  })

  it('toggle chip switches kind without dismissing; tapping elsewhere dismisses', () => {
    const onDismiss = vi.fn()
    const onToggleKind = vi.fn()
    render(
      <PeekOverlay
        kind="tldr"
        record={RECORD}
        lastActiveAt={null}
        onDismiss={onDismiss}
        onToggleKind={onToggleKind}
      />,
    )
    fireEvent.click(screen.getByText('show goal'))
    expect(onToggleKind).toHaveBeenCalledTimes(1)
    expect(onDismiss).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('note'))
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })
})

describe('providerBadge', () => {
  it('resolves every agent provider from its own identity descriptor', () => {
    expect(providerBadge('claude').shortLabel).toBeTruthy()
    expect(providerBadge('codex').shortLabel).toBeTruthy()
    // The v1 list printed the raw wire kind; v2 never does.
    expect(providerBadge('opencode').shortLabel).toBe('OpenCode')
    expect(providerBadge('opencode').shortLabel).not.toBe('opencode')
  })
})
