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

  // #1250 row 6: a failed write was an unhandled rejection with nothing on
  // screen. It is said, in fixed words (never the raw IPC text, which can
  // carry a filesystem path: q22), and the switch keeps main's value.
  it('says a failed toggle or reset did not save, without raw error text', async () => {
    setMock.mockRejectedValueOnce(new Error("EACCES: permission denied, open '/Users/someone/.config/agent-code/setup.json'"))
    await setup()
    const grokSwitch = screen.getAllByRole('switch').find(el => el.getAttribute('aria-label') === 'Enable Grok')!
    fireEvent.click(grokSwitch)
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't save this change. Nothing was changed.")
    expect(document.body.textContent).not.toContain('EACCES')
    expect(grokSwitch.getAttribute('aria-checked')).toBe('false')

    resetMock.mockRejectedValueOnce(new Error('EROFS: read-only file system'))
    fireEvent.click(screen.getByText('Reset to Detection'))
    await vi.waitFor(() => expect(screen.getAllByRole('alert').length).toBeGreaterThanOrEqual(1))
    expect(document.body.textContent).not.toContain('EROFS')
  })

  it('says a failed usage-source write did not save, without raw error text', async () => {
    const usageMock = vi.fn().mockRejectedValue(new Error("ENOSPC: no space left on device, write '/Users/someone/setup.json'"))
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { providerEnablementSet: setMock, providerEnablementReset: resetMock, providerEnablementSetOpencodeUsageSource: usageMock },
    })
    const { ProviderEnablementRow } = await import('./ProviderEnablementRow')
    const { useProviderEnablementStore } = await import('@renderer/features/providers/store')
    useProviderEnablementStore.getState().setSnapshot({
      ...snapshot,
      entries: snapshot.entries.map(entry => entry.kind === 'opencode' ? { ...entry, enabled: true } : entry),
      zaiCredentialPresent: true,
    })
    render(<ProviderEnablementRow />)
    fireEvent.change(screen.getByLabelText('OpenCode usage source'), { target: { value: 'zai' } })
    expect(await screen.findByText("Couldn't save this change. Nothing was changed.")).toBeTruthy()
    expect(document.body.textContent).not.toContain('ENOSPC')
  })

  it('reset link appears only for user overrides and calls the API', async () => {
    await setup()
    const resetButtons = screen.getAllByText('Reset to Detection')
    // Only opencode has a user override in the fixture.
    expect(resetButtons.length).toBe(1)
    fireEvent.click(resetButtons[0])
    expect(resetMock).toHaveBeenCalledWith('opencode')
  })
})
