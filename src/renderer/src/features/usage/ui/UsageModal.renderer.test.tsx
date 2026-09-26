import { fireEvent, screen, waitFor } from '@testing-library/react'

import { UsageModal } from './UsageModal'
import { render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { UsageSnapshot } from '@shared/types/usage'

const snapshot: UsageSnapshot = {
  fetchedAt: new Date('2026-09-20T12:02:00Z').toISOString(),
  cache: { hit: false, ttlMs: 30_000 },
  providers: [
    {
      provider: 'claude',
      status: 'ok',
      sourceLabel: 'Claude Code Keychain',
      plan: 'Pro',
      rows: [
        {
          id: 'w',
          label: 'Current week (all models)',
          percent: 62,
          severity: 'normal',
          resetsAt: null,
          active: true,
          detail: null,
          scope: 'all-models',
        },
      ],
      spend: null,
      extraUsage: null,
      credits: null,
    },
    {
      provider: 'codex',
      status: 'error',
      sourceLabel: '~/.codex/auth.json',
      message: 'Provider rejected the current auth token.',
    },
  ],
}

describe('UsageModal', () => {
  const original = Object.getOwnPropertyDescriptor(window, 'api')

  beforeEach(() => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        getUsageSnapshot: vi.fn().mockResolvedValue(snapshot),
        getUsageSources: vi.fn().mockResolvedValue([
          { id: 'claude', label: 'Claude' },
          { id: 'codex', label: 'Codex' },
        ]),
      },
    })
  })

  afterEach(() => {
    if (original) Object.defineProperty(window, 'api', original)
    vi.restoreAllMocks()
  })

  it('renders a rail entry per source and details for the selected one', async () => {
    render(<UsageModal open onClose={() => {}} />)
    expect(await screen.findByRole('tab', { name: /Claude/ })).toBeTruthy()
    expect(screen.getByRole('tab', { name: /Codex/ })).toBeTruthy()
    // Claude is selected by default; its row label is visible in the detail pane.
    expect(screen.getByText('Current week (all models)')).toBeTruthy()

    fireEvent.click(screen.getByRole('tab', { name: /Codex/ }))
    await waitFor(() => {
      expect(screen.getByText('Provider rejected the current auth token.')).toBeTruthy()
    })
  })

  // Plan S34: the rail is a tablist — one Tab stop, arrows move focus WITH
  // the selection — and ⌘[ / ⌘] cycle providers from anywhere (D5).
  it('is one Tab stop whose arrows move focus and selection together', async () => {
    render(<UsageModal open onClose={() => {}} />)
    const claude = await screen.findByRole('tab', { name: /Claude/ })
    const codex = screen.getByRole('tab', { name: /Codex/ })
    expect(claude).toHaveAttribute('tabindex', '0')
    expect(codex).toHaveAttribute('tabindex', '-1')
    claude.focus()
    fireEvent.keyDown(claude, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(codex)
    expect(codex).toHaveAttribute('aria-selected', 'true')
  })

  it('cycles providers with ⌘] from anywhere in the dialog and closes from the corner ⎋', async () => {
    render(<UsageModal open onClose={() => {}} />)
    const claude = await screen.findByRole('tab', { name: /Claude/ })
    fireEvent.keyDown(screen.getByRole('dialog'), { key: ']', code: 'BracketRight', metaKey: true })
    expect(screen.getByRole('tab', { name: /Codex/ })).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(screen.getByRole('dialog'), { key: '[', code: 'BracketLeft', metaKey: true })
    expect(claude).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('button', { name: 'Close' }).querySelector('[data-slot="kbd"]')?.textContent).toBe('⎋')
  })

  it('shows the empty state linking to settings when no source is active', async () => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        getUsageSnapshot: vi.fn().mockResolvedValue({ ...snapshot, providers: [] }),
        getUsageSources: vi.fn().mockResolvedValue([]),
      },
    })
    render(<UsageModal open onClose={() => {}} />)
    // Radix portals can surface the text in more than one accessibility
    // copy; at least one match is the contract.
    expect((await screen.findAllByText(/No usage sources are enabled/)).length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: /Open Settings/ })).toBeTruthy()
  })
})
