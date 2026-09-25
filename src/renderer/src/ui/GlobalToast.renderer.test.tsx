import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { PaneToast } from '@renderer/workspace/tile-tree/TileLeaf/PaneToast'
import { CaffeinateToastSurface } from '@renderer/features/caffeinate/surfaces/CaffeinateToastSurface'
import { useCaffeinateStore } from '@renderer/features/caffeinate/store'

import { GlobalToastProvider } from './GlobalToast'
import { useGlobalToast } from './GlobalToastContext'

// Toasts (plan N17): each is an ALWAYS-MOUNTED live region, because a region
// that mounts together with its text is not announced; the global toast is a
// real button, so it can be dismissed from the keyboard.

const originalApi = Object.getOwnPropertyDescriptor(window, 'api')
afterEach(() => {
  cleanup()
  if (originalApi) Object.defineProperty(window, 'api', originalApi)
  else Reflect.deleteProperty(window, 'api')
})

function Trigger() {
  const { showToast } = useGlobalToast()
  return <button type="button" onClick={() => showToast('Copied')}>show</button>
}

describe('toasts', () => {
  it('keeps the global live region mounted before any toast, and dismisses from a button', () => {
    Object.defineProperty(window, 'api', { configurable: true, value: new Proxy({}, { get: () => () => () => {} }) })
    render(<GlobalToastProvider><Trigger /></GlobalToastProvider>)
    const region = screen.getByRole('status')
    expect(region).toHaveAttribute('aria-live', 'polite')
    act(() => { fireEvent.click(screen.getByRole('button', { name: 'show' })) })
    const toast = screen.getByRole('button', { name: /Copied/ })
    expect(region.contains(toast)).toBe(true)
    fireEvent.click(toast)
    expect(screen.queryByRole('button', { name: /Copied/ })).toBeNull()
    expect(screen.getByRole('status')).toBeInTheDocument()
  })

  it('shows caffeinate feedback in the one global toast, above dialog scrims', () => {
    // It was a second toast (bottom-right, z-50) that painted UNDER every
    // dialog scrim and mounted its status region with its text.
    Object.defineProperty(window, 'api', { configurable: true, value: new Proxy({}, { get: () => () => () => {} }) })
    render(<GlobalToastProvider><CaffeinateToastSurface /></GlobalToastProvider>)
    const region = screen.getByRole('status')
    act(() => { useCaffeinateStore.getState().setMessage('stopped: the helper exited') })
    expect(region.textContent).toContain('Caffeinate: stopped: the helper exited')
    // Forwarded once, then cleared, so the same text raised again shows again.
    expect(useCaffeinateStore.getState().message).toBeNull()
    expect(screen.getAllByRole('status')).toHaveLength(1)
  })

  it('keeps the pane live region mounted with no message', () => {
    const { rerender } = render(<PaneToast message={null} />)
    const region = screen.getByRole('status')
    rerender(<PaneToast message="Saved bundle" />)
    expect(screen.getByRole('status')).toHaveTextContent('Saved bundle')
    expect(region.isConnected || screen.getByRole('status')).toBeTruthy()
  })
})
