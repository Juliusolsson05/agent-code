import { act, fireEvent, render, screen } from '@testing-library/react'
import { useRef, useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'

import { useAppStore } from '@renderer/app-state/store'
import { useInteractiveOwnership } from '@renderer/workspace/tile-tree/TileLeaf/useInteractiveOwnership'
import { useTypeToFocus } from '@renderer/workspace/tile-tree/TileLeaf/useTypeToFocus'
import { usePasteToFocus } from '@renderer/workspace/tile-tree/TileLeaf/usePasteToFocus'

import { KeyboardRegionContext, SIDEKICK_PANEL_ATTRIBUTE, useKeyboardRegionFollowsPointer } from './KeyboardRegionContext'

// One keyboard, two focused composers (#1493). The Sidekick panel's leaf and
// the focused lane's leaf are BOTH `focused` by their own rules, so before
// the region joined useInteractiveOwnership both claimed type-to-focus and
// paste — every keystroke landed in two drafts. Each composer below is wired
// exactly as TileLeaf wires them: `focused: interactive` from the real hook.

const original = useAppStore.getState()
afterEach(() => {
  useAppStore.setState(original, true)
  document.body.replaceChildren()
})

function Composer({ label }: { label: string }) {
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const { interactive } = useInteractiveOwnership(true)
  useTypeToFocus({ focused: interactive, sessionId: label, inputRef, setDraftInput: (_id, next) => setDraft(next) })
  usePasteToFocus({ focused: interactive, sessionId: label, inputRef, setDraftInput: (_id, next) => setDraft(next), handlePaste: async () => ({ handledImages: false }) })
  return <textarea aria-label={label} ref={inputRef} value={draft} readOnly />
}

function Window() {
  useKeyboardRegionFollowsPointer()
  return (
    <>
      <main><Composer label="lane" /></main>
      <aside {...{ [SIDEKICK_PANEL_ATTRIBUTE]: '' }}>
        <KeyboardRegionContext.Provider value="sidekick">
          <Composer label="sidekick" />
        </KeyboardRegionContext.Provider>
      </aside>
    </>
  )
}

const value = (label: string) => (screen.getByLabelText(label) as HTMLTextAreaElement).value

describe('keyboard region', () => {
  it('sends type-to-focus to exactly one of two focused composers', () => {
    render(<Window />)
    fireEvent.keyDown(document.body, { key: 'a' })
    expect([value('lane'), value('sidekick')]).toEqual(['a', ''])

    act(() => { useAppStore.getState().setKeyboardRegion('sidekick') })
    fireEvent.keyDown(document.body, { key: 'b' })
    expect([value('lane'), value('sidekick')]).toEqual(['a', 'b'])
  })

  it('sends a paste to exactly one composer', () => {
    render(<Window />)
    act(() => { useAppStore.getState().setKeyboardRegion('sidekick') })
    const clipboard = new DataTransfer()
    clipboard.setData('text/plain', 'pasted')
    fireEvent.paste(document.body, { clipboardData: clipboard })
    expect([value('lane'), value('sidekick')]).toEqual(['', 'pasted'])
  })

  it('follows the pointer into and out of the panel, ignoring dialogs', () => {
    render(<Window />)
    fireEvent.pointerDown(screen.getByLabelText('sidekick'))
    expect(useAppStore.getState().keyboardRegion).toBe('sidekick')

    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    const button = document.createElement('button')
    dialog.append(button)
    document.body.append(dialog)
    fireEvent.pointerDown(button)
    expect(useAppStore.getState().keyboardRegion).toBe('sidekick')

    // A context menu opened from the panel is portalled under <body>; picking
    // one of its items must not hand the keyboard to the lane (review round 1).
    for (const wrap of [{ role: 'menu' }, { 'data-radix-popper-content-wrapper': '' }]) {
      const menu = document.createElement('div')
      for (const [name, attr] of Object.entries(wrap)) menu.setAttribute(name, attr)
      const item = document.createElement('div')
      menu.append(item)
      document.body.append(menu)
      fireEvent.pointerDown(item)
      expect(useAppStore.getState().keyboardRegion).toBe('sidekick')
    }

    fireEvent.pointerDown(screen.getByLabelText('lane'))
    expect(useAppStore.getState().keyboardRegion).toBe('workspace')
  })
})
