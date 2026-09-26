import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ConfirmHost } from '@renderer/components/ui/confirm-dialog'

import { DebugBundleNotePrompt } from './DebugBundleNotePrompt'

// Debug bundle note (plan S19): ⌘↩ saves through DialogActions and says so
// on the button; plain Enter stays a newline; and a TYPED note is real input
// (B7's condition on D3) — Skip/Escape ask before discarding it.

function harness() {
  const onCancel = vi.fn()
  const onConfirm = vi.fn()
  render(
    <>
      <DebugBundleNotePrompt open title="Saved" description="bundle" bundlePath="/tmp/b" onCancel={onCancel} onConfirm={onConfirm} />
      <ConfirmHost />
    </>,
  )
  return { onCancel, onConfirm, note: screen.getByLabelText('Optional note') }
}

describe('Debug bundle note', () => {
  it('saves on ⌘↩ from the note and labels Save Note ⌘↩, Skip ⎋', () => {
    const { onConfirm, note } = harness()
    fireEvent.change(note, { target: { value: 'flaky after resume' } })
    expect(fireEvent.keyDown(note, { key: 'Enter' })).toBe(true) // newline, not a save
    expect(onConfirm).not.toHaveBeenCalled()
    fireEvent.keyDown(note, { key: 'Enter', metaKey: true })
    expect(onConfirm).toHaveBeenCalledWith('flaky after resume')
    expect(screen.getByRole('button', { name: 'Save Note' }).querySelector('[data-slot="kbd"]')?.textContent).toBe('⌘↩')
    expect(screen.getByRole('button', { name: 'Skip' }).querySelector('[data-slot="kbd"]')?.textContent).toBe('⎋')
  })

  it('skips at once with an empty note', () => {
    const { onCancel } = harness()
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }))
    return waitFor(() => expect(onCancel).toHaveBeenCalledOnce())
  })

  it('asks before Skip throws away a typed note, and keeps it when the user declines', async () => {
    const { onCancel, note } = harness()
    fireEvent.change(note, { target: { value: 'important context' } })
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }))
    const confirm = await screen.findByRole('dialog', { name: 'Discard this note?' })
    expect(onCancel).not.toHaveBeenCalled()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Cancel' })) })
    await waitFor(() => expect(confirm).not.toBeInTheDocument())
    expect(onCancel).not.toHaveBeenCalled()
    expect(note).toHaveValue('important context')
  })
})
