import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { Dialog, DialogContent, DialogTitle } from './dialog'
import { DialogActions, focusedControlOwnsEnter, focusedControlOwnsSpace } from './dialog-actions'

// DialogActions' Enter rule is shared: list dialogs that handle Enter on
// DialogContent themselves (New Agent In, Switch Provider) call the exported
// `focusedControlOwnsEnter` rather than copying a guard (#862). These pin the
// rule where it lives, so a change to it cannot quietly break every consumer.

function harness() {
  const onConfirm = vi.fn()
  const onCancel = vi.fn()
  render(
    <Dialog open>
      <DialogContent>
        <DialogTitle>Close agents</DialogTitle>
        <DialogActions confirmLabel="Close 3 Agents" onConfirm={onConfirm} onCancel={onCancel} />
      </DialogContent>
    </Dialog>,
  )
  return { onConfirm, onCancel }
}

describe('DialogActions Enter ownership', () => {
  it('confirms on an Enter that no control claims', () => {
    const { onConfirm } = harness()

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Enter' })

    expect(onConfirm).toHaveBeenCalledOnce()
  })

  it('leaves Enter on a focused Cancel to Cancel, so it can never confirm', () => {
    // The failure this prevents: preventDefault cancels Cancel's native click
    // and the footer confirms instead — Enter-on-Cancel performing the
    // destructive action. `true` = default not prevented.
    const { onConfirm } = harness()

    expect(fireEvent.keyDown(screen.getByRole('button', { name: 'Cancel' }), { key: 'Enter' })).toBe(true)

    expect(onConfirm).not.toHaveBeenCalled()
  })
})

// Key chips (keyboard-first plan H2). The rule these pin: a chip is shown
// exactly when that key performs that button's action — never a chip that
// lies. Before the chips, every dialog footer was silent about its keys.
function chipsOn(name: string | RegExp): string[] {
  const button = screen.getByRole('button', { name })
  return [...button.querySelectorAll('[data-slot="kbd"]')].map(chip => chip.textContent ?? '')
}

describe('DialogActions key chips', () => {
  it('labels Cancel with Escape and confirm with Enter', () => {
    harness()
    expect(chipsOn('Cancel')).toEqual(['⎋'])
    expect(chipsOn('Close 3 Agents')).toEqual(['↩'])
  })

  it('keeps the chip text out of the accessible name', () => {
    // A screen reader should hear "Cancel", not "Cancel escape".
    harness()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
  })

  it('drops the Escape chip while the surface refuses Escape', () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Switching</DialogTitle>
          <DialogActions confirmLabel="Switch" onConfirm={() => {}} onCancel={() => {}} escapeCancels={false} />
        </DialogContent>
      </Dialog>,
    )
    expect(chipsOn('Cancel')).toEqual([])
  })

  it('shows no chip and commits on no key when confirmKey is null', () => {
    const onConfirm = vi.fn()
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Deliberate</DialogTitle>
          <DialogActions confirmLabel="Apply" onConfirm={onConfirm} confirmKey={null} />
        </DialogContent>
      </Dialog>,
    )
    expect(chipsOn('Apply')).toEqual([])
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Enter' })
    expect(onConfirm).not.toHaveBeenCalled()
  })
})

describe('DialogActions Cmd+Enter commit', () => {
  function textareaHarness() {
    const onConfirm = vi.fn()
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Note</DialogTitle>
          <textarea aria-label="note" />
          <DialogActions confirmLabel="Save" onConfirm={onConfirm} onCancel={() => {}} confirmKey="Cmd+Enter" />
        </DialogContent>
      </Dialog>,
    )
    return { onConfirm, textarea: screen.getByRole('textbox', { name: 'note' }) }
  }

  it('commits on Cmd+Enter from inside the textarea and labels the button ⌘↩', () => {
    const { onConfirm, textarea } = textareaHarness()
    expect(chipsOn('Save')).toEqual(['⌘↩'])
    fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true })
    expect(onConfirm).toHaveBeenCalledOnce()
  })

  it('leaves plain Enter in the textarea as a newline', () => {
    const { onConfirm, textarea } = textareaHarness()
    expect(fireEvent.keyDown(textarea, { key: 'Enter' })).toBe(true)
    expect(onConfirm).not.toHaveBeenCalled()
  })
})

describe('focusedControlOwnsEnter', () => {
  it('claims Enter for buttons, links and textareas only', () => {
    expect(focusedControlOwnsEnter(document.createElement('button'))).toBe(true)
    expect(focusedControlOwnsEnter(document.createElement('a'))).toBe(true)
    expect(focusedControlOwnsEnter(document.createElement('textarea'))).toBe(true)
    // The dialog surface and ordinary containers do not: Enter there is the
    // dialog's to handle.
    expect(focusedControlOwnsEnter(document.createElement('div'))).toBe(false)
    expect(focusedControlOwnsEnter(null)).toBe(false)
  })
})

describe('focusedControlOwnsSpace', () => {
  it('claims Space for buttons and text fields, but NOT for links', () => {
    // The two keys do not activate the same elements, which is the whole
    // reason this is a second predicate rather than the Enter one reused.
    // Space presses a focused button and types into a text field; on a link it
    // SCROLLS — it does not follow it. A dialog that swallowed Space on a
    // focused link would take the scroll away and give the key to a list the
    // user is not looking at.
    expect(focusedControlOwnsSpace(document.createElement('button'))).toBe(true)
    expect(focusedControlOwnsSpace(document.createElement('textarea'))).toBe(true)
    expect(focusedControlOwnsSpace(document.createElement('input'))).toBe(true)
    expect(focusedControlOwnsSpace(document.createElement('a'))).toBe(false)
    expect(focusedControlOwnsEnter(document.createElement('a'))).toBe(true)
    expect(focusedControlOwnsSpace(document.createElement('div'))).toBe(false)
    expect(focusedControlOwnsSpace(null)).toBe(false)
  })
})
