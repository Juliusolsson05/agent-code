import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { Dialog, DialogContent, DialogTitle } from './dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './dropdown-menu'

// The keyboard contract the two hand-rolled menus broke (plan M1/M2): the
// menu opens from the keyboard, focus ENTERS it, arrows move between items,
// Enter selects, and Escape closes the MENU — not the dialog it opened from —
// and returns focus to the trigger. The inside-a-dialog case is the one that
// depends on the pinned version (one shared dismissable-layer stack; see the
// header of dropdown-menu.tsx), so it is exercised inside a real Dialog.

function Harness({ onSelect }: { onSelect: (label: string) => void }) {
  return (
    <Dialog open>
      <DialogContent>
        <DialogTitle>Settings</DialogTitle>
        <DropdownMenu>
          <DropdownMenuTrigger>Actions</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem onSelect={() => onSelect('Reveal')}>Reveal</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onSelect('Hide')}>Hide</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </DialogContent>
    </Dialog>
  )
}

describe('DropdownMenu', () => {
  it('opens from the keyboard, moves with arrows, and selects with Enter', async () => {
    const onSelect = vi.fn()
    render(<Harness onSelect={onSelect} />)
    const trigger = screen.getByRole('button', { name: 'Actions' })
    trigger.focus()
    fireEvent.keyDown(trigger, { key: 'Enter' })
    const reveal = await screen.findByRole('menuitem', { name: 'Reveal' })
    await waitFor(() => expect(document.activeElement).toBe(reveal))
    fireEvent.keyDown(reveal, { key: 'ArrowDown' })
    const hide = screen.getByRole('menuitem', { name: 'Hide' })
    await waitFor(() => expect(document.activeElement).toBe(hide))
    fireEvent.keyDown(hide, { key: 'Enter' })
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith('Hide'))
  })

  it('closes only the menu on Escape inside a dialog, and returns focus to the trigger', async () => {
    render(<Harness onSelect={() => {}} />)
    const trigger = screen.getByRole('button', { name: 'Actions' })
    trigger.focus()
    fireEvent.keyDown(trigger, { key: 'Enter' })
    const reveal = await screen.findByRole('menuitem', { name: 'Reveal' })
    fireEvent.keyDown(reveal, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument()
    await waitFor(() => expect(document.activeElement).toBe(trigger))
  })
})
