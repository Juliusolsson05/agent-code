import { render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'

import { DebugPanelHeader } from '@renderer/features/debug/ui/DebugPanelHeader'
import { SidePanel } from './side-panel'

// #512: one shell for the docked side-panel slot, and a named close on the
// debug-family header (five copies drew a bare "×" with no accessible name).
it('renders a named complementary landmark with its content, width and column layout', () => {
  render(<SidePanel label="Git" className="w-[280px]"><p>panel body</p></SidePanel>)
  const panel = screen.getByRole('complementary', { name: 'Git' })
  expect(panel).toContainElement(screen.getByText('panel body'))
  // The shell's layout contract: a full-height, non-shrinking column that
  // clips its own overflow so each panel scrolls inside itself.
  for (const cls of ['w-[280px]', 'border-l', 'h-full', 'flex-shrink-0', 'flex', 'flex-col', 'overflow-hidden', 'bg-surface']) {
    expect(panel.className.split(/\s+/)).toContain(cls)
  }
})

it('lets a panel override the border colour instead of stacking two', () => {
  render(<SidePanel label="Rendering debug" className="border-red-500/60">body</SidePanel>)
  const panel = screen.getByRole('complementary', { name: 'Rendering debug' })
  expect(panel.className).toContain('border-red-500/60')
  expect(panel.className).not.toMatch(/(^|\s)border-border(\s|$)/)
})

it('gives the debug header close an accessible name', () => {
  const onClose = vi.fn()
  render(<DebugPanelHeader title="dev debug" closeLabel="Close dev debug" onClose={onClose} />)
  screen.getByRole('button', { name: 'Close dev debug' }).click()
  expect(onClose).toHaveBeenCalledTimes(1)
})
