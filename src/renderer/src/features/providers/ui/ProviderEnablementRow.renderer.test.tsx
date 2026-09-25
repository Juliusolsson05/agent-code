import { fireEvent, screen } from '@testing-library/react'
import { render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ProviderEnablementSnapshot } from '@shared/types/providerEnablement'

const snapshot: ProviderEnablementSnapshot = {
  entries: [
    { kind: 'claude', enabled: true, because: 'detected', installed: true },
    { kind: 'codex', enabled: true, because: 'detected', installed: true },
    { kind: 'opencode', enabled: false, because: 'user', installed: true },
    { kind: 'grok', enabled: false, because: 'not-detected', installed: false },
  ],
  opencodeUsageSource: 'none', zaiCredentialPresent: false,
}

describe('ProviderEnablementRow', () => {
  const original = Object.getOwnPropertyDescriptor(window, 'api')
  const setMock = vi.fn().mockResolvedValue(snapshot)
  const resetMock = vi.fn().mockResolvedValue(snapshot)

  beforeEach(() => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        providerEnablementSet: setMock,
        providerEnablementReset: resetMock,
      },
    })
  })

  afterEach(() => {
    if (original) Object.defineProperty(window, 'api', original)
    vi.clearAllMocks()
  })

  async function setup() {
    const { ProviderEnablementRow } = await import('./ProviderEnablementRow')
    const { useProviderEnablementStore } = await import('@renderer/features/providers/store')
    useProviderEnablementStore.getState().setSnapshot(snapshot)
    render(<ProviderEnablementRow />)
  }

  it('renders one row per provider kind with state hints', async () => {
    await setup()
    expect(await screen.findByText('Grok')).toBeTruthy()
    // The hint line mixes text nodes and the reset link, so assert on the
    // rendered text rather than a single element match.
    const text = document.body.textContent ?? ''
    expect(text).toContain('not detected on PATH')
    expect(text).toContain('set by you')
    expect(text).toContain('detected')
  })

  it('toggling calls the API with kind and value', async () => {
    await setup()
    const grokSwitch = screen
      .getAllByRole('switch')
      .find(el => el.getAttribute('aria-label') === 'Enable Grok')
    expect(grokSwitch).toBeTruthy()
    if (grokSwitch) fireEvent.click(grokSwitch)
    expect(setMock).toHaveBeenCalledWith('grok', true)
  })

  it('reset link appears only for user overrides and calls the API', async () => {
    await setup()
    const resetButtons = screen.getAllByText('reset to detection')
    // Only opencode has a user override in the fixture.
    expect(resetButtons.length).toBe(1)
    fireEvent.click(resetButtons[0])
    expect(resetMock).toHaveBeenCalledWith('opencode')
  })
})
