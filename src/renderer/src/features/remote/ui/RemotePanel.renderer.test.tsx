import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { RemotePanel } from './RemotePanel'

// Remote panel (plan S37): standard chrome — the corner close with its ⎋
// chip replaces a raw ✕, and the two-way Reach switch announces which side is
// on instead of relying on colour alone.

const originalApi = Object.getOwnPropertyDescriptor(window, 'api')
afterEach(() => {
  cleanup()
  if (originalApi) Object.defineProperty(window, 'api', originalApi)
  else Reflect.deleteProperty(window, 'api')
})

describe('Remote panel', () => {
  it('closes from the standard corner ⎋ and announces the Reach switch state', async () => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        remoteGetStatus: vi.fn(async () => ({
          enabled: true, url: 'http://192.168.1.2:1234', transport: 'tunnel', devices: [], connectedDeviceIds: [],
        })),
        onRemoteStatusChanged: vi.fn(() => () => {}),
      },
    })
    render(<RemotePanel onClose={vi.fn()} />)
    await act(async () => { await Promise.resolve() })
    const close = screen.getByRole('button', { name: 'Close' })
    expect(close.querySelector('[data-slot="kbd"]')?.textContent).toBe('⎋')
    expect(screen.getByRole('button', { name: 'Tunnel' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'LAN' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: 'Disable' })).toHaveAttribute('aria-pressed', 'true')
  })
})
