import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ConfirmHost } from '@renderer/components/ui/confirm-dialog'

import { ThemeEditorModal } from './SettingsPage'

// Theme editor (plan S27): one exit (the header Close is gone), ⌘↩ saves from
// the JSON editor, and an edited draft is never thrown away by one Escape.

function harness() {
  const onClose = vi.fn()
  const onSave = vi.fn()
  render(
    <>
      <ThemeEditorModal theme={null} onClose={onClose} onSave={onSave} />
      <ConfirmHost />
    </>,
  )
  return { onClose, onSave }
}

describe('Theme editor', () => {
  it('has one Cancel ⎋ exit and saves with ⌘↩', () => {
    const { onSave } = harness()
    expect(screen.getAllByRole('button', { name: /^(Close|Cancel)$/ })).toHaveLength(1)
    const save = screen.getByRole('button', { name: 'Save & Apply' })
    expect(save.querySelector('[data-slot="kbd"]')?.textContent).toBe('⌘↩')
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Night' } })
    fireEvent.keyDown(screen.getByLabelText('Name'), { key: 'Enter', metaKey: true })
    expect(onSave).toHaveBeenCalledWith('Night', expect.any(String), false)
  })

  it('asks before Escape discards an edited draft, and closes at once when nothing changed', async () => {
    const { onClose } = harness()
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Night' } })
    fireEvent.keyDown(screen.getByLabelText('Name'), { key: 'Escape' })
    expect(await screen.findByRole('dialog', { name: 'Discard theme changes?' })).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Discard Changes' })) })
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
  })
})
