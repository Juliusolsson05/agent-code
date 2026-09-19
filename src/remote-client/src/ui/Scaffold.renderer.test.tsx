import { render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Scaffold } from './Scaffold'

// The contract: Scaffold mirrors window.visualViewport's height into
// --app-visible-height on <html> so styles.css can pin the app column to
// the VISIBLE height while the iOS keyboard occupies the lower part of
// the layout viewport (which iOS refuses to shrink — that refusal is why
// this component exists).
class FakeVisualViewport {
  height = 640
  listeners = { resize: new Set<() => void>(), scroll: new Set<() => void>() }
  addEventListener(kind: 'resize' | 'scroll', fn: () => void) {
    this.listeners[kind].add(fn)
  }
  removeEventListener(kind: 'resize' | 'scroll', fn: () => void) {
    this.listeners[kind].delete(fn)
  }
  emit(kind: 'resize' | 'scroll') {
    for (const fn of this.listeners[kind]) fn()
  }
}

function installFakeViewport(): FakeVisualViewport {
  const vv = new FakeVisualViewport()
  Object.defineProperty(window, 'visualViewport', {
    configurable: true,
    get: () => vv,
  })
  return vv
}

afterEach(() => {
  delete (window as { visualViewport?: unknown }).visualViewport
  document.documentElement.style.removeProperty('--app-visible-height')
})

describe('Scaffold', () => {
  it('publishes the visual viewport height as --app-visible-height', () => {
    const vv = installFakeViewport()
    render(<Scaffold>hi</Scaffold>)
    expect(document.documentElement.style.getPropertyValue('--app-visible-height')).toBe('640px')
  })

  it('tracks keyboard-driven resizes through rAF', async () => {
    const vv = installFakeViewport()
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(cb => {
      cb(0)
      return 0
    })
    const { unmount } = render(<Scaffold>hi</Scaffold>)
    vv.height = 320
    vv.emit('resize')
    expect(document.documentElement.style.getPropertyValue('--app-visible-height')).toBe('320px')
    raf.mockRestore()
    unmount()
  })

  it('cleans up listeners and the property on unmount', () => {
    const vv = installFakeViewport()
    const { unmount } = render(<Scaffold>hi</Scaffold>)
    unmount()
    expect(vv.listeners.resize.size).toBe(0)
    expect(vv.listeners.scroll.size).toBe(0)
    expect(document.documentElement.style.getPropertyValue('--app-visible-height')).toBe('')
  })
})
