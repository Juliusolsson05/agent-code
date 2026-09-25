import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ConfirmCloseDialog } from './ConfirmCloseDialog'
import { ConfirmDeleteDialog } from './ConfirmDeleteDialog'

// The editor's two confirms (plan S24/S25), each against its own K1 rule:
// closing a dirty tab opens on the SAFE answer (Save & Close, Enter saves),
// deleting from disk opens on Cancel with no commit key.

describe('Unsaved changes on close', () => {
  it('opens on Save & Close, saves on Enter, and labels Cancel ⎋', () => {
    const onSaveAndClose = vi.fn()
    render(<ConfirmCloseDialog fileName="a.ts" onSaveAndClose={onSaveAndClose} onDiscard={vi.fn()} onCancel={vi.fn()} />)
    const save = screen.getByRole('button', { name: 'Save & Close' })
    expect(document.activeElement).toBe(save)
    expect(save.querySelector('[data-slot="kbd"]')?.textContent).toBe('↩')
    expect(screen.getByRole('button', { name: 'Cancel' }).querySelector('[data-slot="kbd"]')?.textContent).toBe('⎋')
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Enter' })
    expect(onSaveAndClose).toHaveBeenCalledOnce()
  })

  it('cannot be escaped or cancelled mid-save', () => {
    const onCancel = vi.fn()
    render(<ConfirmCloseDialog fileName="a.ts" saving onSaveAndClose={vi.fn()} onDiscard={vi.fn()} onCancel={onCancel} />)
    const cancel = screen.getByRole('button', { name: 'Cancel' })
    expect(cancel).toBeDisabled()
    expect(cancel.querySelector('[data-slot="kbd"]')).toBeNull()
    expect(screen.getByRole('button', { name: 'Discard' })).toBeDisabled()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(onCancel).not.toHaveBeenCalled()
  })
})

describe('Delete from disk', () => {
  it('opens on Cancel, never deletes from a dialog-level Enter, and shows no Enter chip on Delete', () => {
    const onConfirm = vi.fn()
    render(<ConfirmDeleteDialog path="src/a.ts" dirtyPaths={[]} onCancel={vi.fn()} onConfirm={onConfirm} />)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Enter' })
    expect(onConfirm).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Delete' }).querySelector('[data-slot="kbd"]')).toBeNull()
  })
})
