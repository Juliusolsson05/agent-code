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
import { useRef } from 'react'
import { useTypeToFocus } from '@renderer/workspace/tile-tree/TileLeaf/useTypeToFocus'
import { usePasteToFocus } from '@renderer/workspace/tile-tree/TileLeaf/usePasteToFocus'
import type { SessionId } from '@renderer/workspace/types'

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

// Two prompts stacked in one pane (round-2 review A-P1). ConditionOutlet
// renders every visible condition, so this is a supported, if uncommon, stack.
function StackedPrompts({ second }: { second: boolean }) {
  const [pane, setPane] = useState<HTMLDivElement | null>(null)
  return (
    <div ref={setPane} data-pane-id="pane-a" className="relative">
      <textarea aria-label="composer A" />
      <PaneDialogHostProvider container={pane} active restoreFocus={() => pane?.querySelector('textarea')?.focus()}>
        <TrustDialogModal state={{ workspace: '/Users/me/first' }} onAccept={async () => {}} onDecline={async () => {}} />
        <TrustDialogModal state={second ? { workspace: '/Users/me/second' } : null} onAccept={async () => {}} onDecline={async () => {}} />
      </PaneDialogHostProvider>
    </div>
  )
}

describe('stacked pane prompts (round-2 review A-P1)', () => {
  it('keeps only the newest prompt live, then hands focus to the one beneath when it closes', () => {
    const { rerender } = render(<StackedPrompts second={false} />)
    rerender(<StackedPrompts second />)
    const [older, newer] = screen.getAllByRole('dialog')
    // The older prompt sits under the newer one's scrim: Tab must not reach it.
    expect(older!.closest('[inert]')).not.toBeNull()
    expect(newer!.closest('[inert]')).toBeNull()
    expect(screen.getByLabelText('composer A').closest('[inert]')).not.toBeNull()

    // Answer the newer one while it holds focus: focus goes to the older
    // prompt, not to the composer that is still inert under it.
    const newerButton = newer!.querySelector('button')!
    newerButton.focus()
    rerender(<StackedPrompts second={false} />)
    const remaining = screen.getByRole('dialog')
    expect(remaining.closest('[inert]')).toBeNull()
    expect(remaining.contains(document.activeElement)).toBe(true)
    expect(screen.getByLabelText('composer A').closest('[inert]')).not.toBeNull()
  })
})

// One controller per pane (Claude review of #1221: reviewer B F1/F2, A F2).
function PaneWith({ prompts, lateChild = false, toast = null }: { prompts: string[]; lateChild?: boolean; toast?: string | null }) {
  const [pane, setPane] = useState<HTMLDivElement | null>(null)
  return (
    <div ref={setPane} data-pane-id="pane-a" className="relative">
      <textarea aria-label="composer A" />
      {lateChild ? <button type="button">Send</button> : null}
      <PaneDialogHostProvider container={pane} active restoreFocus={() => {}}>
        {prompts.map(workspace => (
          <TrustDialogModal key={workspace} state={{ workspace }} onAccept={async () => {}} onDecline={async () => {}} />
        ))}
      </PaneDialogHostProvider>
      <PaneToast message={toast} />
    </div>
  )
}

describe('pane prompt inerting, one controller per pane', () => {
  it('leaves the newest of two prompts that mount in the SAME commit answerable', () => {
    // A TileLeaf remount mounts every visible prompt at once. Each prompt
    // used to inert the other, and neither could be answered.
    render(<PaneWith prompts={['/Users/me/first', '/Users/me/second']} />)
    const dialogs = screen.getAllByRole('dialog')
    expect(dialogs.map(d => d.closest('[inert]') !== null)).toEqual([true, false])
  })

  it('makes a pane control that mounts AFTER the prompt inert too', () => {
    const { rerender } = render(<PaneWith prompts={['/Users/me/first']} />)
    rerender(<PaneWith prompts={['/Users/me/first']} lateChild />)
    // MutationObserver callbacks are microtasks.
    return Promise.resolve().then(() => {
      expect(screen.getByRole('button', { name: 'Send' }).closest('[inert]')).not.toBeNull()
    })
  })

  it('keeps the pane toast live (announced and hoverable) above an open prompt', () => {
    const { rerender } = render(<PaneWith prompts={['/Users/me/first']} />)
    rerender(<PaneWith prompts={['/Users/me/first']} toast="That option was already replaced" />)
    const status = screen.getByRole('status')
    expect(status.closest('[inert]')).toBeNull()
    expect(status).toHaveTextContent('That option was already replaced')
  })

  it('removes only the inert it set, once the last prompt closes', () => {
    const { rerender } = render(<PaneWith prompts={['/Users/me/first']} />)
    const composer = screen.getByLabelText('composer A')
    expect(composer.closest('[inert]')).not.toBeNull()
    rerender(<PaneWith prompts={[]} />)
    expect(composer.closest('[inert]')).toBeNull()
  })
})

describe('pane-scoped condition dialogs (#713)', () => {
  it('stays inside its own pane and blocks nothing outside it', () => {
    const onDecline = vi.fn(async () => {})
    render(<TwoPanes trustActive={false} onDecline={onDecline} />)
    const composerB = screen.getByLabelText('composer B')
    composerB.focus()
    flushFrames()

    const dialog = screen.getByRole('dialog', { name: 'Trust This Folder?' })
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
    const trust = screen.getByRole('button', { name: 'Trust Folder' })
    expect(document.activeElement).toBe(trust)

    fireEvent.keyDown(trust, { key: 'Escape' })
    expect(onDecline).toHaveBeenCalledTimes(1)

    // The prompt resolves and unmounts while holding focus: focus goes back
    // to the pane's composer, not to <body>.
    rerender(<TwoPanes trustActive promptUp={false} onDecline={onDecline} />)
    expect(document.activeElement).toBe(screen.getByLabelText('composer A'))
  })

  it('makes the rest of ITS pane inert, so Tab cannot reach the covered composer (review A2/B1)', () => {
    // The scrim stops the pointer only. Shift+Tab from the prompt used to walk
    // into the same pane's composer, where typing edited a hidden draft.
    const { rerender } = render(<TwoPanes trustActive onDecline={vi.fn(async () => {})} />)
    const composerA = screen.getByLabelText('composer A')
    expect(composerA.closest('[inert]')).not.toBeNull()
    // The prompt itself and every other pane stay live.
    expect(screen.getByRole('dialog').closest('[inert]')).toBeNull()
    expect(screen.getByLabelText('composer B').closest('[inert]')).toBeNull()
    // Answered: the pane wakes up again.
    rerender(<TwoPanes trustActive promptUp={false} onDecline={vi.fn(async () => {})} />)
    expect(composerA.closest('[inert]')).toBeNull()
  })

  it('marks only its own pane for the pane-local routers', () => {
    render(<TwoPanes trustActive={false} onDecline={vi.fn(async () => {})} />)
    expect(paneHasInteractionOwner(screen.getByLabelText('composer A'))).toBe(true)
    expect(paneHasInteractionOwner(screen.getByLabelText('composer B'))).toBe(false)
    expect(isInPaneInteractionOwner(screen.getByRole('button', { name: 'Trust Folder' }))).toBe(true)
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

describe('pane-local routers yield to a pane dialog (review A, B2)', () => {
  it('never lets a hovered, prompted composer take Enter', () => {
    // B2: the hovered branch returned before the focused branch's `blocked`
    // check, and no test covered it. Pointer over pane A (with its prompt up),
    // keyboard elsewhere: Enter must not submit A's covered draft.
    const submit = vi.fn()
    render(<TwoPanes trustActive onDecline={vi.fn(async () => {})} />)
    const composerA = screen.getByLabelText('composer A')
    const unregister = registerComposerEnterTarget({
      key: 'pane-a',
      focused: false,
      hovered: true,
      blocked: () => paneHasInteractionOwner(composerA),
      hasSubmittableDraft: () => true,
      focus: () => {},
      submit,
    })
    // AFTER registering: the registry only listens for pointer moves while a
    // target exists, and hover counts only when the pointer moved last.
    fireEvent.pointerMove(document.body)
    fireEvent.keyDown(document.body, { key: 'Enter' })
    expect(submit).not.toHaveBeenCalled()
    unregister()
  })

  function Routers({ onDraft }: { onDraft: (next: string) => void }) {
    const [pane, setPane] = useState<HTMLDivElement | null>(null)
    const inputRef = useRef<HTMLTextAreaElement | null>(null)
    const setDraftInput = (_id: SessionId, next: string) => onDraft(next)
    useTypeToFocus({ focused: true, sessionId: 'a' as SessionId, inputRef, setDraftInput })
    usePasteToFocus({ focused: true, sessionId: 'a' as SessionId, inputRef, setDraftInput, handlePaste: async () => ({ kind: 'none' }) as never })
    return (
      <div ref={setPane} data-pane-id="pane-a" className="relative">
        <textarea ref={inputRef} aria-label="composer A" />
        <PaneDialogHostProvider container={pane} active>
          <TrustDialogModal state={{ workspace: '/w' }} onAccept={async () => {}} onDecline={async () => {}} />
        </PaneDialogHostProvider>
      </div>
    )
  }

  it('does not type or paste into the covered composer (review A)', () => {
    // A's mutation run: removing the paste guard survived every test. Keys and
    // pastes from a non-editable target used to be redirected into the draft.
    const onDraft = vi.fn()
    render(<Routers onDraft={onDraft} />)
    fireEvent.keyDown(document.body, { key: 'x' })
    const paste = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent
    Object.defineProperty(paste, 'clipboardData', { value: { getData: () => 'secret', items: [], files: [], types: ['text/plain'] } })
    document.body.dispatchEvent(paste)
    expect(onDraft).not.toHaveBeenCalled()
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
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Trust Folder' }))
  })
})
