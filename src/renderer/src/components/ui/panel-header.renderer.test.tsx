import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { PanelHeader } from '@renderer/components/ui/panel-header'

// The docked side-panel header (UI pass, G-26). Before it, Git's and
// Worktrees' close was a bare × with NO accessible name, so a screen reader
// announced "button" and nothing else.

describe('PanelHeader', () => {
  it('names its close after the panel, and puts actions before it', () => {
    const onClose = vi.fn()
    render(<PanelHeader label="Git" onClose={onClose} actions={<button type="button">Refresh</button>} />)
    const close = screen.getByRole('button', { name: 'Close Git' })
    const buttons = screen.getAllByRole('button')
    expect(buttons.at(-1)).toBe(close)
    expect(document.querySelector('[data-slot="section-label"]')?.textContent).toBe('Git')
    fireEvent.click(close)
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
