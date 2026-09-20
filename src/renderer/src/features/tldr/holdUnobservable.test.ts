import { describe, expect, it, vi } from 'vitest'

import { createTldrHoldController } from './viewState'
import type { HoldEndReason } from '@shared/types/tldr'

// ---------------------------------------------------------------------------
// #1066. The native watcher polls `CGEventSource.keyState`, which answers
// `false` both for "that key is up" and for "this process cannot see the
// keyboard". On a freshly signed build — macOS keys Accessibility to the code
// signature, so every release starts without the previous one's grants — the
// watcher exited instantly and the peek flashed and vanished, indistinguishable
// from a broken feature.
//
// The controller is driven directly rather than through the DOM because the
// distinction arrives as a REASON on the native signal, not as a key event:
// tldr.renderer.test.tsx already drives the gesture through the real router.
// ---------------------------------------------------------------------------

type Controller = ReturnType<typeof createTldrHoldController>

function controller() {
  const setHeld = vi.fn()
  const setLatched = vi.fn()
  let signal: ((reason: HoldEndReason) => void) | null = null
  const observeRelease = vi.fn((_event: unknown, release: (reason: HoldEndReason) => void) => {
    signal = release
    return () => { signal = null }
  })
  const instance: Controller = createTldrHoldController(
    setHeld,
    observeRelease as never,
    setLatched,
  )
  return {
    instance,
    setHeld,
    setLatched,
    native: (reason: HoldEndReason) => signal?.(reason),
    observing: () => signal !== null,
  }
}

const chord = { code: 'KeyL', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, repeat: false }

describe('a hold whose key cannot be observed (#1066)', () => {
  it('latches the peek instead of closing it', () => {
    const { instance, setHeld, setLatched, native } = controller()
    instance.start(chord, 'tldr')
    expect(setHeld).toHaveBeenCalledWith(true, 'tldr')
    setHeld.mockClear()

    native('unobservable')
    // The bug: this used to clear, so the overlay appeared and vanished in the
    // same frame. Latched is the state the Goal/TLDR command produces every
    // day — Escape dismisses it — so the peek stays readable without ever
    // becoming an overlay with no way out.
    expect(setLatched).toHaveBeenCalledExactlyOnceWith('tldr')
    expect(setHeld).not.toHaveBeenCalled()
  })

  it('latches the preview that was actually being held, not a default', () => {
    // ⌘G and ⌘L share one gesture and one store; latching the wrong one would
    // answer a question the user did not ask.
    const { instance, setLatched, native } = controller()
    instance.start(chord, 'goal')
    native('unobservable')
    expect(setLatched).toHaveBeenCalledExactlyOnceWith('goal')
  })

  it('still closes normally on a real release', () => {
    const { instance, setHeld, setLatched, native } = controller()
    instance.start(chord, 'tldr')
    setHeld.mockClear()
    native('released')
    expect(setHeld).toHaveBeenCalledExactlyOnceWith(false)
    expect(setLatched).not.toHaveBeenCalled()
  })

  it('closes normally when the renderer sees the modifier come up first', () => {
    // A fast tap releases Command, whose keyup is NOT swallowed the way a
    // Cmd-letter keyup is. That path must stay a plain close: it is the reason
    // a late 'unobservable' signal can never strand a peek the user finished.
    const { instance, setHeld, setLatched } = controller()
    instance.start(chord, 'tldr')
    setHeld.mockClear()
    instance.keyUp({ code: 'KeyL', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false })
    expect(setHeld).toHaveBeenCalledExactlyOnceWith(false)
    expect(setLatched).not.toHaveBeenCalled()
  })

  it('ignores a native signal that arrives after the gesture already ended', () => {
    // Exactly the fast-tap race: the renderer released on the Command keyup,
    // then the helper reports it could not observe anything. Acting on it would
    // latch a peek the user had already dismissed.
    const { instance, setHeld, setLatched, native } = controller()
    instance.start(chord, 'tldr')
    instance.keyUp({ code: 'KeyL', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false })
    setHeld.mockClear()

    native('unobservable')
    expect(setLatched).not.toHaveBeenCalled()
    expect(setHeld).not.toHaveBeenCalled()
  })

  it('stops observing once a hold has ended either way', () => {
    for (const reason of ['released', 'unobservable'] as const) {
      const { instance, native, observing } = controller()
      instance.start(chord, 'tldr')
      expect(observing()).toBe(true)
      native(reason)
      expect(observing(), reason).toBe(false)
    }
  })
})
