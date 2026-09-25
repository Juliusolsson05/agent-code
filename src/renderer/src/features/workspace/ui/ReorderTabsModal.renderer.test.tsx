import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ReorderTabsModal } from './ReorderTabsModal'

// Reorder Tabs' two-phase model (browse → pick → move) keeps its own handler;
// #867 ownership is pinned in focusedCancelEnter. This pins what the
// keyboard-first pass added (plan S3): Home/End, and hints that follow the
// phase so they never claim a key does something it does not.

const tabs = ['A', 'B', 'C', 'D'].map(title => ({ id: title as never, title }))

function harness() {
  const onConfirm = vi.fn()
  render(<ReorderTabsModal open tabs={tabs} activeTabId={'A' as never} onCancel={() => {}} onConfirm={onConfirm} />)
  return { dialog: screen.getByRole('dialog'), onConfirm }
}

const doneChip = () => screen.getByRole('button', { name: 'Done' }).querySelector('[data-slot="kbd"]')?.textContent ?? null

describe('Reorder Tabs keyboard', () => {
  it('sends the picked tab straight to the end with End, then commits on Enter', () => {
    const { dialog, onConfirm } = harness()
    fireEvent.keyDown(dialog, { key: 'Enter' }) // pick A
    fireEvent.keyDown(dialog, { key: 'End' })
    fireEvent.keyDown(dialog, { key: 'Enter' }) // commit
    expect(onConfirm).toHaveBeenCalledWith(['B', 'C', 'D', 'A'])
  })

  it('jumps the browsing cursor with End/Home without reordering anything', () => {
    const { dialog, onConfirm } = harness()
    fireEvent.keyDown(dialog, { key: 'End' })
    fireEvent.keyDown(dialog, { key: 'Enter' }) // pick D
    fireEvent.keyDown(dialog, { key: 'Home' }) // D to the front
    fireEvent.keyDown(dialog, { key: 'Enter' })
    expect(onConfirm).toHaveBeenCalledWith(['D', 'A', 'B', 'C'])
  })

  it('shows Enter on Done only while a tab is picked, when Enter really commits', () => {
    const { dialog } = harness()
    expect(doneChip()).toBeNull() // browsing: Enter picks up, it does not commit
    expect(screen.getByText('pick up')).toBeInTheDocument()
    fireEvent.keyDown(dialog, { key: 'Enter' })
    expect(doneChip()).toBe('↩')
    expect(screen.getByText('put down')).toBeInTheDocument()
  })
})
