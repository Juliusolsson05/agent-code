import { fireEvent } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { registerComposerEnterTarget } from '@renderer/workspace/tile-tree/TileLeaf/composerEnterRegistry'
import type { ComposerEnterTargetHandle } from '@renderer/workspace/tile-tree/TileLeaf/composerEnterRegistry'

// Which composer a document-level Enter submits (K2-2).
//
// "Hovered wins over focused" is right when the pointer is the latest intent,
// and wrong when the KEYBOARD moved the pane focus while the mouse rested
// over another pane's composer: Enter then submitted the wrong pane's draft.
// These drive the registry the way TileLeaf does, re-registering a fresh
// handle object on every focus or hover change.

const cleanups: Array<() => void> = []
afterEach(() => { while (cleanups.length) cleanups.pop()!() })

function pane(key: string, init: Partial<ComposerEnterTargetHandle>) {
  const submit = vi.fn()
  let unregister: (() => void) | null = null
  const set = (patch: Partial<ComposerEnterTargetHandle>) => {
    unregister?.()
    unregister = registerComposerEnterTarget({
      key,
      focused: false,
      hovered: false,
      hasSubmittableDraft: () => true,
      focus: () => {},
      submit,
      ...init,
      ...patch,
    })
  }
  set({})
  cleanups.push(() => unregister?.())
  return { set, submit }
}

describe('composer Enter target', () => {
  it('ignores a resting hover once the keyboard has moved the focused pane', () => {
    const a = pane('a', { focused: true })
    const b = pane('b', {})
    // The mouse moves onto A's composer: hover is the latest intent.
    fireEvent.pointerMove(document.body)
    a.set({ focused: true, hovered: true })
    // ⌥↓: the keyboard moves focus to B; the pointer does not move.
    a.set({ focused: false, hovered: true })
    b.set({ focused: true })

    fireEvent.keyDown(document.body, { key: 'Enter' })
    expect(b.submit).toHaveBeenCalledTimes(1)
    expect(a.submit).not.toHaveBeenCalled()
  })

  it('still lets a MOVED pointer win, the case the hover rule exists for', () => {
    const a = pane('a', {})
    const b = pane('b', { focused: true })
    // Focus has been on B; now the user moves the mouse over A's draft.
    fireEvent.pointerMove(document.body)
    a.set({ hovered: true })

    fireEvent.keyDown(document.body, { key: 'Enter' })
    expect(a.submit).toHaveBeenCalledTimes(1)
    expect(b.submit).not.toHaveBeenCalled()
  })
})
