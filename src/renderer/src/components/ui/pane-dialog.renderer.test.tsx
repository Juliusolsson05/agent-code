import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'

import { PANE_DIALOG_LAYERS, PaneDialogHostProvider } from '@renderer/components/ui/pane-dialog'
import { PaneToast } from '@renderer/workspace/tile-tree/TileLeaf/PaneToast'
import {
  hasAppInteractionOwner,
  isInPaneInteractionOwner,
  paneHasInteractionOwner,
} from '@renderer/lib/interaction-ownership'
import { registerComposerEnterTarget } from '@renderer/workspace/tile-tree/TileLeaf/composerEnterRegistry'
import { TrustDialogModal } from '@providers/claude/renderer/TrustDialogModal'

// #713: one pane's condition modal must not take the whole app hostage.
//
// Driven with the REAL Claude trust modal (the one #713 was observed with),
// mounted the way TileLeaf mounts it: inside a PaneDialogHostProvider whose
// container is the pane root. Two panes, each with a composer, stand in for
// "the pane with the prompt" and "the pane the user is working in".

let frames: FrameRequestCallback[] = []
beforeEach(() => {
  frames = []
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.push(callback)
    return frames.length
  })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
const flushFrames = () => act(() => { frames.splice(0).forEach(frame => frame(performance.now())) })

function TwoPanes({ trustActive, promptUp = true, onDecline }: {
  trustActive: boolean
  promptUp?: boolean
  onDecline: () => Promise<void>
}) {
  const [paneA, setPaneA] = useState<HTMLDivElement | null>(null)
  return (
    <>
      <div ref={setPaneA} data-pane-id="pane-a" className="relative">
        <textarea aria-label="composer A" />
        <PaneDialogHostProvider
          container={paneA}
          active={trustActive}
          restoreFocus={() => paneA?.querySelector('textarea')?.focus()}
        >
          <TrustDialogModal
            state={promptUp ? { workspace: '/Users/me/untrusted' } : null}
            onAccept={async () => {}}
            onDecline={onDecline}
          />
        </PaneDialogHostProvider>
      </div>
      <div data-pane-id="pane-b">
        <textarea aria-label="composer B" />
      </div>
    </>
  )
}

describe('pane-scoped condition dialogs (#713)', () => {
  it('stays inside its own pane and blocks nothing outside it', () => {
    const onDecline = vi.fn(async () => {})
    render(<TwoPanes trustActive={false} onDecline={onDecline} />)
    const composerB = screen.getByLabelText('composer B')
    composerB.focus()
    flushFrames()

    const dialog = screen.getByRole('dialog', { name: 'Trust this folder?' })
    expect(dialog.closest('[data-pane-id]')?.getAttribute('data-pane-id')).toBe('pane-a')
    // No APP owner: every global router stays live for the other panes.
    expect(hasAppInteractionOwner()).toBe(false)
    // A background prompt never steals focus from the pane in use.
    expect(document.activeElement).toBe(composerB)

    // Escape in pane B is pane B's: not a decline, and NOT defaultPrevented
    // (the composer's key handler bails on defaultPrevented, which is exactly
    // what a document-level Radix layer would have done to it).
    expect(fireEvent.keyDown(composerB, { key: 'Escape' })).toBe(true)
    expect(onDecline).not.toHaveBeenCalled()
    // A click elsewhere is not a decline either.
    fireEvent.pointerDown(composerB)
    fireEvent.focusIn(composerB)
    expect(onDecline).not.toHaveBeenCalled()
  })

  it('takes focus when its pane becomes active, declines on Escape inside, and hands focus back', () => {
    const onDecline = vi.fn(async () => {})
    const { rerender } = render(<TwoPanes trustActive={false} onDecline={onDecline} />)
    flushFrames()
    rerender(<TwoPanes trustActive onDecline={onDecline} />)
    flushFrames()
    const trust = screen.getByRole('button', { name: 'Trust folder' })
    expect(document.activeElement).toBe(trust)

    fireEvent.keyDown(trust, { key: 'Escape' })
    expect(onDecline).toHaveBeenCalledTimes(1)

    // The prompt resolves and unmounts while holding focus: focus goes back
    // to the pane's composer, not to <body>.
    rerender(<TwoPanes trustActive promptUp={false} onDecline={onDecline} />)
    expect(document.activeElement).toBe(screen.getByLabelText('composer A'))
  })

  it('marks only its own pane for the pane-local routers', () => {
    render(<TwoPanes trustActive={false} onDecline={vi.fn(async () => {})} />)
    expect(paneHasInteractionOwner(screen.getByLabelText('composer A'))).toBe(true)
    expect(paneHasInteractionOwner(screen.getByLabelText('composer B'))).toBe(false)
    expect(isInPaneInteractionOwner(screen.getByRole('button', { name: 'Trust folder' }))).toBe(true)
    expect(isInPaneInteractionOwner(screen.getByLabelText('composer B'))).toBe(false)
  })

  it('never lets document Enter submit a draft that sits under a pane dialog', () => {
    const submitA = vi.fn()
    const submitB = vi.fn()
    render(<TwoPanes trustActive onDecline={vi.fn(async () => {})} />)
    const composerA = screen.getByLabelText('composer A')
    const unregisterA = registerComposerEnterTarget({
      focused: true,
      hovered: false,
      blocked: () => paneHasInteractionOwner(composerA),
      hasSubmittableDraft: () => true,
      focus: () => {},
      submit: submitA,
    })
    fireEvent.keyDown(document.body, { key: 'Enter' })
    expect(submitA).not.toHaveBeenCalled()
    // The same registry still serves an unblocked pane.
    const unregisterB = registerComposerEnterTarget({
      focused: true,
      hovered: false,
      hasSubmittableDraft: () => true,
      focus: () => {},
      submit: submitB,
    })
    fireEvent.keyDown(document.body, { key: 'Enter' })
    expect(submitB).toHaveBeenCalledTimes(1)
    unregisterA()
    unregisterB()
  })
})

describe('pane feedback above a pane dialog (#713, steering k9)', () => {
  // happy-dom does not paint, so this pins the stacking CONTRACT on the
  // mounted elements: the pane toast is positioned and sits on a higher layer
  // than both the scrim and the dialog, inside the same pane stacking context.
  const zOf = (element: Element) => Number(/z-\[(\d+)\]/.exec(element.className)?.[1] ?? Number.NaN)

  it('paints the pane s refusal toast above the scrim and the dialog', () => {
    function PaneWithToast() {
      const [pane, setPane] = useState<HTMLDivElement | null>(null)
      return (
        <div ref={setPane} data-pane-id="pane-a" className="relative">
          <PaneDialogHostProvider container={pane} active={false}>
            <TrustDialogModal state={{ workspace: '/w' }} onAccept={async () => {}} onDecline={async () => {}} />
          </PaneDialogHostProvider>
          <PaneToast message="That option was already replaced; re-read the question." />
        </div>
      )
    }
    const { container } = render(<PaneWithToast />)
    const scrim = container.querySelector('[data-slot="pane-dialog-scrim"]')!
    const dialog = screen.getByRole('dialog')
    const toast = screen.getByRole('status')
    expect(toast.className).toContain('relative')
    expect(zOf(toast)).toBeGreaterThan(zOf(dialog))
    expect(zOf(dialog)).toBeGreaterThan(zOf(scrim))
    // All three share the pane as their stacking context: nothing between
    // them and the pane root creates another one.
    expect(toast.parentElement).toBe(scrim.parentElement)
    expect([PANE_DIALOG_LAYERS.scrim, PANE_DIALOG_LAYERS.content, PANE_DIALOG_LAYERS.feedback].map(c => zOf({ className: c } as Element)))
      .toEqual([60, 61, 62])
  })
})

describe('app-mode dialogs are unchanged', () => {
  it('still portals to the body, owns the app, and honours data-autofocus', async () => {
    render(<TrustDialogModal state={{ workspace: '/w' }} onAccept={async () => {}} onDecline={async () => {}} />)
    const dialog = screen.getByRole('dialog')
    expect(dialog.closest('[data-pane-id]')).toBeNull()
    expect(hasAppInteractionOwner()).toBe(true)
    await act(async () => { frames.splice(0).forEach(frame => frame(performance.now())) })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Trust folder' }))
  })
})
