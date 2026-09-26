import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { ConfirmHost, requestConfirm, type ConfirmRequest } from './confirm-dialog'
import { Dialog, DialogContent, DialogTitle } from './dialog'

// requestConfirm replaced 17 window.confirm guards. What must hold for a
// keyboard user (plan K1/K3, steering note 1):
//   - a DESTRUCTIVE confirm opens on Cancel and no key press commits it —
//     Enter-on-open never destroys, and ⌘↩ is not an escape hatch around that;
//   - Escape cancels only the confirm, leaving the dialog that asked open.
// Rendered inside a real outer Radix dialog, because that is where most of
// the call sites live (Conventions / Custom Skills editors, Key Vault).

function Harness() {
  return (
    <>
      <Dialog open>
        <DialogContent>
          <DialogTitle>Key Vault</DialogTitle>
        </DialogContent>
      </Dialog>
      <ConfirmHost />
    </>
  )
}

async function ask(request: ConfirmRequest) {
  let settled: boolean | undefined
  act(() => {
    void requestConfirm(request).then(value => {
      settled = value
    })
  })
  const dialog = await screen.findByRole('dialog', { name: request.title })
  return { dialog, result: () => settled }
}

const danger: ConfirmRequest = { title: 'Delete key "prod"?', confirmLabel: 'Delete Key', tone: 'danger' }

describe('requestConfirm', () => {
  it('opens a destructive confirm with focus on Cancel and no Enter chip on the destructive button', async () => {
    render(<Harness />)
    await ask(danger)
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' })))
    const destroy = screen.getByRole('button', { name: 'Delete Key' })
    expect(destroy.querySelector('[data-slot="kbd"]')).toBeNull()
    // Settle it: the host is app-global, so an unsettled confirm would stay
    // at the head of the queue for the next test (as it would in the app).
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: danger.title })).toBeNull())
  })

  it('never commits a destructive confirm on a dialog-level Enter or ⌘↩ — only a deliberate press of the button', async () => {
    render(<Harness />)
    const { dialog, result } = await ask(danger)
    fireEvent.keyDown(dialog, { key: 'Enter' })
    fireEvent.keyDown(dialog, { key: 'Enter', metaKey: true })
    await Promise.resolve()
    expect(result()).toBeUndefined()
    fireEvent.click(screen.getByRole('button', { name: 'Delete Key' }))
    await waitFor(() => expect(result()).toBe(true))
  })

  it('commits a non-destructive confirm on Enter', async () => {
    render(<Harness />)
    const { dialog, result } = await ask({ title: 'Open Add skills?', confirmLabel: 'Open Add Skills' })
    fireEvent.keyDown(dialog, { key: 'Enter' })
    await waitFor(() => expect(result()).toBe(true))
  })

  it('cancels on Escape and leaves the dialog that asked open', async () => {
    render(<Harness />)
    const { result } = await ask(danger)
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    await waitFor(() => expect(result()).toBe(false))
    expect(screen.getByRole('dialog', { name: 'Key Vault' })).toBeInTheDocument()
  })
})
