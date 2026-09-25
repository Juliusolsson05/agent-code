import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'

import { APP_INTERACTION_OWNER_SELECTOR } from '@renderer/lib/interaction-ownership'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from './dialog'

function DialogHarness(): JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div data-testid="feature-owner">
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger>Open details</DialogTrigger>
        <DialogContent>
          <DialogTitle>Agent details</DialogTitle>
          <DialogDescription>Inspect the selected agent.</DialogDescription>
          <button type="button">First action</button>
        </DialogContent>
      </Dialog>
    </div>
  )
}

describe('Dialog', () => {
  it('portals an accessible app interaction owner and closes with Escape', async () => {
    render(<DialogHarness />)
    const trigger = screen.getByRole('button', { name: 'Open details' })
    trigger.focus()
    fireEvent.click(trigger)

    const dialog = await screen.findByRole('dialog', { name: 'Agent details' })
    expect(dialog.getAttribute('aria-describedby')).toBeTruthy()
    expect(dialog.matches(APP_INTERACTION_OWNER_SELECTOR)).toBe(true)
    // WHY this class is a behavior contract, not a snapshot of incidental
    // styling: CSS Grid columns default to an automatic minimum. A direct
    // child containing an unbroken path can therefore widen the grid track
    // past the dialog's viewport-bound width, dragging a `w-full` textarea
    // outside the modal with it. The explicit zero minimum is what lets every
    // dialog child shrink before its own truncate/overflow policy takes over.
    expect(dialog.className).toContain('grid-cols-[minmax(0,1fr)]')
    // WHY this assertion matters: a portal is what lets Radix make the rest
    // of the app inert consistently; rendering under a transformed pane can
    // otherwise break both fixed positioning and stacking behavior.
    expect(screen.getByTestId('feature-owner').contains(dialog)).toBe(false)

    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(trigger))
  })

  it('lets a full-viewport surface override the width preset instead of stacking both', () => {
    // The pre-preset bug: `max-w-2xl` on McpServerDialog did nothing against
    // the base width, so the dialog rendered at 520 while its author believed
    // 672. With presets, an explicit width must REPLACE the preset (Settings,
    // Performance are sized to the window), never sit beside it and lose.
    render(
      <Dialog open>
        <DialogContent size="md" className="w-[min(1360px,96vw)]">
          <DialogTitle>Wide</DialogTitle>
        </DialogContent>
      </Dialog>,
    )
    const dialog = screen.getByRole('dialog')
    expect(dialog.className).toContain('w-[min(1360px,96vw)]')
    expect(dialog.className).not.toContain('w-[min(640px,92vw)]')
  })

  it('shows the Escape key on the corner close button without changing its accessible name', () => {
    render(
      <Dialog open>
        <DialogContent showCloseButton>
          <DialogTitle>Queued prompt</DialogTitle>
        </DialogContent>
      </Dialog>,
    )
    const close = screen.getByRole('button', { name: 'Close' })
    expect(close.querySelector('[data-slot="kbd"]')?.textContent).toBe('⎋')
  })
})
