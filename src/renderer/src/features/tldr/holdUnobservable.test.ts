import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createTldrHoldController, useTldrView } from './viewState'
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

function controller(options: { real?: boolean } = {}) {
  const setHeld = vi.fn()
  const onUnobservable = vi.fn()
  let signal: ((reason: HoldEndReason) => void) | null = null
  const observeRelease = vi.fn((_event: unknown, release: (reason: HoldEndReason) => void) => {
    signal = release
    return () => { signal = null }
  })
  // `real: true` uses the PRODUCTION setHeld, so the store transition itself is
  // exercised rather than a spy (review finding 3: injecting both collaborators
  // meant the shipped default was asserted by nothing).
  const instance: Controller = createTldrHoldController(
    options.real ? undefined : setHeld,
    observeRelease as never,
    onUnobservable,
  )
  return {
    instance,
    setHeld,
    onUnobservable,
    native: (reason: HoldEndReason) => signal?.(reason),
    observing: () => signal !== null,
  }
}

const chord = { code: 'KeyL', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, repeat: false }
const commandUp = { code: 'MetaLeft', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false }

beforeEach(() => { useTldrView.setState({ held: false, latched: false, preview: 'tldr' }) })

describe('a hold whose key cannot be observed (#1066)', () => {
  it('KEEPS holding, because the Command keyup still works', () => {
    // Only the Cmd-LETTER keyup is swallowed by AppKit; the Command keyup
    // reaches the renderer. An earlier version latched here instead, which
    // threw that signal away AND handed the overlay every keystroke but
    // Escape — the #1021 trap, re-created for exactly the users this fixes.
    const { instance, setHeld, native } = controller()
    instance.start(chord, 'tldr')
    setHeld.mockClear()

    native('unobservable')
    expect(setHeld).not.toHaveBeenCalled()

    instance.keyUp(commandUp)
    expect(setHeld).toHaveBeenCalledExactlyOnceWith(false)
  })

  it('leaves the store held, not latched, through the production path', () => {
    // The shipped setHeld/latched transition, not a spy. A latched overlay
    // owns input; a held one does not.
    const { instance, native } = controller({ real: true })
    instance.start(chord, 'goal')
    native('unobservable')
    expect(useTldrView.getState()).toMatchObject({ held: true, latched: false, preview: 'goal' })

    instance.keyUp(commandUp)
    expect(useTldrView.getState()).toMatchObject({ held: false, latched: false })
  })

  it('tells the app once so the user can be shown why', () => {
    const { instance, onUnobservable, native } = controller()
    instance.start(chord, 'tldr')
    native('unobservable')
    expect(onUnobservable).toHaveBeenCalledTimes(1)
  })

  it('stops observing, since nothing more will come from the watcher', () => {
    const { instance, native, observing } = controller()
    instance.start(chord, 'tldr')
    native('unobservable')
    expect(observing()).toBe(false)
  })

  it('still closes normally on a real release', () => {
    const { instance, setHeld, onUnobservable, native } = controller()
    instance.start(chord, 'tldr')
    setHeld.mockClear()
    native('released')
    expect(setHeld).toHaveBeenCalledExactlyOnceWith(false)
    expect(onUnobservable).not.toHaveBeenCalled()
  })

  it('ignores a native signal that arrives after the gesture already ended', () => {
    const { instance, setHeld, onUnobservable } = controller()
    instance.start(chord, 'tldr')
    instance.keyUp(commandUp)
    setHeld.mockClear()
    controllerNative(instance)
    expect(setHeld).not.toHaveBeenCalled()
    expect(onUnobservable).not.toHaveBeenCalled()
  })
})

/** A late signal for a gesture that is already over must do nothing. */
function controllerNative(instance: Controller): void {
  instance.release('unobservable')
}
