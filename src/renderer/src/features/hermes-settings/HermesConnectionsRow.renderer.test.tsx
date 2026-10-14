import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

import type { HermesConnectionInfo } from '@shared/hermes/types'

import { ConnectionCard } from './HermesConnectionsRow'

// Settings → Hermes connection card states (#1482). Round-1 review x1 found
// every sentence and button of this card unpinned (the copy, Cancel sign-in,
// error display, the IPC-prefix strip) and one real bug: a refused Save hid
// its reason. Connection values are justified literals: this is UI over
// HermesConnectionInfo (shared/hermes/types.ts), which has no wire recording.

const originalApi = window.api
afterEach(() => {
  cleanup()
  Object.defineProperty(window, 'api', { configurable: true, value: originalApi })
})

function connection(overrides: Partial<HermesConnectionInfo>): HermesConnectionInfo {
  return { id: 'c1', name: 'Homelab', baseUrl: 'https://hermes.example', createdAt: 0, state: 'signed-out', identity: null, backend: null, lastError: null, ...overrides }
}

function api(overrides: Record<string, unknown>) {
  const value = { hermesSignIn: vi.fn(async () => undefined), hermesCancelSignIn: vi.fn(async () => undefined), hermesUpdate: vi.fn(async () => undefined), ...overrides }
  Object.defineProperty(window, 'api', { configurable: true, value })
  return value
}

describe('Hermes connection card', () => {
  it('signed out: says so and offers Sign in', async () => {
    const bridge = api({})
    render(<ConnectionCard connection={connection({})} />)
    expect(screen.getByText('Not signed in.')).toBeTruthy()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Sign in' })) })
    expect(bridge.hermesSignIn).toHaveBeenCalledWith('c1')
  })

  it('signing in: waits for the browser and Cancel sign-in reaches main', () => {
    const bridge = api({})
    render(<ConnectionCard connection={connection({ state: 'signing-in' })} />)
    expect(screen.getByText('Waiting for you to sign in in your browser…')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel sign-in' }))
    expect(bridge.hermesCancelSignIn).toHaveBeenCalledWith('c1')
  })

  it('a failed sign-in shows main\'s sentence without Electron\'s IPC wrapper', async () => {
    api({ hermesSignIn: vi.fn(async () => { throw new Error("Error invoking remote method 'hermes:sign-in': Error: Hermes refused the connection. Is `hermes serve` running on the server?") }) })
    render(<ConnectionCard connection={connection({})} />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Sign in' })) })
    expect(screen.getByText('Hermes refused the connection. Is `hermes serve` running on the server?')).toBeTruthy()
  })

  it('a refused Save keeps the form open AND says why; Cancel clears it', async () => {
    api({ hermesUpdate: vi.fn(async () => { throw new Error("Error invoking remote method 'hermes:update': Error: \"Office\" already points at https://other.example.") }) })
    render(<ConnectionCard connection={connection({ state: 'ready', identity: { userId: 'me', provider: 'basic' } })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.change(screen.getByLabelText('Hermes URL'), { target: { value: 'https://other.example' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })) })
    expect(screen.getByRole('alert').textContent).toBe('"Office" already points at https://other.example.')
    expect(screen.getByLabelText('Hermes URL')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByText('https://hermes.example')).toBeTruthy()
  })
})
