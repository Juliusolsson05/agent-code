import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { Dialog, DialogContent, DialogTitle } from './dialog'
import { DialogActions, focusedControlOwnsEnter } from './dialog-actions'

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
