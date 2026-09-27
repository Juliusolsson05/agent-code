import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { anySurfaceOpen, dismissLayerCountForTest, dismissTopmost, pushDismissLayer, useDismissLayer } from './dismissStack'

// #512: Escape dismisses only the topmost surface; an already-handled event
// passes through; a busy surface swallows Escape without closing.
const releases: Array<() => void> = []
const push = (layer: Parameters<typeof pushDismissLayer>[0]) => {
  const release = pushDismissLayer(layer)
  releases.push(release)
  return release
}
afterEach(() => { for (const release of releases.splice(0)) release() })

describe('dismiss stack', () => {
  it('dismisses only the topmost surface, then the one below', () => {
    const lower = vi.fn()
    const upper = vi.fn()
    const releaseLower = push({ onDismiss: lower })
    const releaseUpper = push({ onDismiss: upper })
    expect(dismissTopmost()).toBe(true)
    expect(upper).toHaveBeenCalledTimes(1)
    expect(lower).not.toHaveBeenCalled()
    releaseUpper()
    expect(dismissTopmost()).toBe(true)
    expect(lower).toHaveBeenCalledTimes(1)
    releaseLower()
    expect(dismissTopmost()).toBe(false)
  })

  it('leaves an already-handled Escape alone (the PTY-forwarding question row)', () => {
    const onDismiss = vi.fn()
    push({ onDismiss })
    expect(dismissTopmost({ defaultPrevented: true })).toBe(false)
    expect(onDismiss).not.toHaveBeenCalled()
  })

  it('consumes Escape without dismissing while the top surface is busy', () => {
    const lower = vi.fn()
    const upper = vi.fn()
    push({ onDismiss: lower })
    push({ onDismiss: upper, escapeEnabled: () => false })
    expect(dismissTopmost()).toBe(true)
    expect(upper).not.toHaveBeenCalled()
    expect(lower).not.toHaveBeenCalled()
  })

  it('releases idempotently and out of order', () => {
    const lower = vi.fn()
    const upper = vi.fn()
    const releaseLower = push({ onDismiss: lower })
    push({ onDismiss: upper })
    releaseLower()
    releaseLower()
    expect(dismissLayerCountForTest()).toBe(1)
    dismissTopmost()
    expect(upper).toHaveBeenCalledTimes(1)
    expect(lower).not.toHaveBeenCalled()
  })

  it('reports whether any surface is open', () => {
    expect(anySurfaceOpen()).toBe(false)
    const release = push({ onDismiss: () => {} })
    expect(anySurfaceOpen()).toBe(true)
    release()
    expect(anySurfaceOpen()).toBe(false)
  })
})

describe('useDismissLayer', () => {
  it('registers while open, reads the latest callbacks, and keeps its stack position across re-renders', () => {
    const first = vi.fn()
    const second = vi.fn()
    const view = renderHook(({ open, onDismiss, busy }) => useDismissLayer(open, onDismiss, { escapeEnabled: !busy }), {
      initialProps: { open: true, onDismiss: first, busy: false },
    })
    const upper = vi.fn()
    const releaseUpper = pushDismissLayer({ onDismiss: upper })

    // A re-render with a new callback must not move this layer above `upper`.
    view.rerender({ open: true, onDismiss: second, busy: false })
    dismissTopmost()
    expect(upper).toHaveBeenCalledTimes(1)
    releaseUpper()

    view.rerender({ open: true, onDismiss: second, busy: true })
    dismissTopmost()
    expect(second).not.toHaveBeenCalled()

    view.rerender({ open: true, onDismiss: second, busy: false })
    dismissTopmost()
    expect(second).toHaveBeenCalledTimes(1)
    expect(first).not.toHaveBeenCalled()

    view.rerender({ open: false, onDismiss: second, busy: false })
    expect(anySurfaceOpen()).toBe(false)
  })
})
