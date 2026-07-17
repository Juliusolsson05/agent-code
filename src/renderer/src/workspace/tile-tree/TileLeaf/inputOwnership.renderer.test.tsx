import { fireEvent, render, screen } from '@testing-library/react'
import { useRef, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { APP_INTERACTION_OWNER_ATTRIBUTE } from '@renderer/lib/interaction-ownership'
import { registerComposerEnterTarget } from './composerEnterRegistry'
import { registerDictationTarget } from './dictationHotkeyRegistry'
import { usePasteToFocus } from './usePasteToFocus'
import { useTypeToFocus } from './useTypeToFocus'

function mountInteractionOwner(): HTMLDivElement {
  const owner = document.createElement('div')
  owner.setAttribute(APP_INTERACTION_OWNER_ATTRIBUTE, 'app')
  document.body.append(owner)
  return owner
}

function ComposerIngressHarness(): JSX.Element {
  const [draft, setDraft] = useState('existing')
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useTypeToFocus({
    focused: true,
    sessionId: 'session-1',
    inputRef,
    setDraftInput: (_sessionId, next) => setDraft(next),
  })
  usePasteToFocus({
    focused: true,
    sessionId: 'session-1',
    inputRef,
    setDraftInput: (_sessionId, next) => setDraft(next),
    handlePaste: async () => ({ handledImages: false }),
  })

  return <textarea aria-label="Composer" ref={inputRef} value={draft} readOnly />
}

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

describe('app interaction ownership at composer ingress', () => {
  it('blocks type-to-focus while a dialog or takeover owns interaction', () => {
    render(<ComposerIngressHarness />)
    const owner = mountInteractionOwner()

    fireEvent.keyDown(document.body, { key: 'x' })
    expect((screen.getByLabelText('Composer') as HTMLTextAreaElement).value).toBe('existing')

    owner.remove()
    fireEvent.keyDown(document.body, { key: 'x' })
    expect((screen.getByLabelText('Composer') as HTMLTextAreaElement).value).toBe('existingx')
  })

  it('blocks paste-to-focus while a dialog or takeover owns interaction', () => {
    render(<ComposerIngressHarness />)
    const clipboard = new DataTransfer()
    clipboard.setData('text/plain', ' pasted')
    const owner = mountInteractionOwner()

    fireEvent.paste(document.body, { clipboardData: clipboard })
    expect((screen.getByLabelText('Composer') as HTMLTextAreaElement).value).toBe('existing')

    owner.remove()
    fireEvent.paste(document.body, { clipboardData: clipboard })
    expect((screen.getByLabelText('Composer') as HTMLTextAreaElement).value).toBe('existing pasted')
  })

  it('does not redirect Enter to an agent draft while an owner is mounted', () => {
    const focus = vi.fn()
    const submit = vi.fn()
    const unregister = registerComposerEnterTarget({
      focused: true,
      hovered: false,
      hasSubmittableDraft: () => true,
      focus,
      submit,
    })
    const owner = mountInteractionOwner()

    fireEvent.keyDown(document.body, { key: 'Enter' })
    expect(focus).not.toHaveBeenCalled()
    expect(submit).not.toHaveBeenCalled()

    owner.remove()
    fireEvent.keyDown(document.body, { key: 'Enter' })
    expect(focus).toHaveBeenCalledOnce()
    expect(submit).toHaveBeenCalledOnce()
    unregister()
  })

  it('blocks native dictation start but still drains a key-up already in flight', () => {
    type HotkeyHandler = (payload: { binding: string }) => void
    let down: HotkeyHandler | undefined
    let up: HotkeyHandler | undefined
    vi.stubGlobal('api', {
      onDictationHotkeyDown: (handler: HotkeyHandler) => {
        down = handler
        return () => undefined
      },
      onDictationHotkeyUp: (handler: HotkeyHandler) => {
        up = handler
        return () => undefined
      },
    } as Window['api'])

    let active = false
    const start = vi.fn(() => {
      active = true
    })
    const stop = vi.fn(() => {
      active = false
    })
    const unregister = registerDictationTarget({
      enabled: true,
      focused: true,
      lastFocusedAt: Date.now(),
      start,
      stop,
      isStarting: () => false,
      isActive: () => active,
    })

    down?.({ binding: 'fn' })
    expect(start).toHaveBeenCalledOnce()

    const owner = mountInteractionOwner()
    up?.({ binding: 'fn' })
    expect(stop).toHaveBeenCalledOnce()

    down?.({ binding: 'fn' })
    expect(start).toHaveBeenCalledOnce()
    owner.remove()
    unregister()
  })
})
