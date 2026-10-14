import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

import type { HermesConnectionInfo } from '@shared/hermes/types'

import { ConnectionCard, HermesConnectionsRow } from './HermesConnectionsRow'

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
    // Gone everywhere, not just from the form (round-2 x1 M17).
    expect(screen.queryByText('"Office" already points at https://other.example.')).toBeNull()
    expect(screen.getByText('https://hermes.example')).toBeTruthy()
  })

  it('unreachable shows main\'s reason; Test shows what the server answered', async () => {
    api({ hermesTest: vi.fn(async () => ({ ok: true, version: 'v0.21.7', authRequired: true, providers: ['Username & Password'] })) })
    render(<ConnectionCard connection={connection({ state: 'unreachable', identity: { userId: 'me', provider: 'basic' }, lastError: 'Hermes did not answer in time. Check your network or VPN (Tailscale) path to the server.' })} />)
    expect(screen.getByText('Hermes did not answer in time. Check your network or VPN (Tailscale) path to the server.')).toBeTruthy()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Test' })) })
    expect(screen.getByText('Reached Hermes v0.21.7 · sign-in: Username & Password')).toBeTruthy()
  })

  it('says when the server\'s Hermes is too old, and when its contract only differs', () => {
    const { rerender } = render(<ConnectionCard connection={connection({ state: 'ready', identity: { userId: 'me', provider: 'basic' }, backend: { version: 'v0.20.0', desktopContract: 5, compatibility: 'unsupported' } })} />)
    expect(screen.getByText(/too old for Agent Code/)).toBeTruthy()
    rerender(<ConnectionCard connection={connection({ state: 'ready', identity: { userId: 'me', provider: 'basic' }, backend: { version: 'v0.22.0', desktopContract: 9, compatibility: 'skew' } })} />)
    expect(screen.getByText(/Hermes contract 9 \(Agent Code was tested with 8\)/)).toBeTruthy()
  })

  it('Add goes straight into sign-in for the new connection', async () => {
    const bridge = api({
      hermesList: vi.fn(async () => []),
      onHermesConnectionsChanged: vi.fn(() => () => undefined),
      hermesAdd: vi.fn(async () => connection({ id: 'new-id' })),
    })
    render(<HermesConnectionsRow />)
    fireEvent.change(screen.getByLabelText('New connection name'), { target: { value: 'Homelab' } })
    fireEvent.change(screen.getByLabelText('New Hermes URL'), { target: { value: 'https://hermes.example' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Add and sign in' })) })
    expect(bridge.hermesSignIn).toHaveBeenCalledWith('new-id')
  })
})


describe('Tailscale tag (#1498)', () => {
  it('marks a connection that is reached over a tailnet, and only that one', () => {
    const tailnet = render(<ConnectionCard connection={connection({ baseUrl: 'https://hermes.tail1234.ts.net' })} />)
    expect(tailnet.getByText('Tailscale')).toBeTruthy()
    tailnet.unmount()
    const publicUrl = render(<ConnectionCard connection={connection({ baseUrl: 'https://hermes-agent-pjlj.srv1921318.hstgr.cloud' })} />)
    expect(publicUrl.queryByText('Tailscale')).toBeNull()
  })
})
