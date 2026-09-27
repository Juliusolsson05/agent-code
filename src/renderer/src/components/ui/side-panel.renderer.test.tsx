import { render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'

import { DebugPanelHeader } from '@renderer/features/debug/ui/DebugPanelHeader'
import { SidePanel } from './side-panel'

// #512: one shell for the docked side-panel slot, and a named close on the
// debug-family header (five copies drew a bare "×" with no accessible name).
it('renders a named complementary landmark and keeps the panel width', () => {
  render(<SidePanel label="Git" className="w-[280px]">body</SidePanel>)
  const panel = screen.getByRole('complementary', { name: 'Git' })
  expect(panel.className).toContain('w-[280px]')
  expect(panel.className).toContain('border-l')
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
