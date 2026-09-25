import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { MergeProjectTabsModal } from './MergeProjectTabsModal'
import type { MergeTabOption } from './MergeProjectTabsModal'

// Two tabs on one repository plus an unrelated one, active tab last: the
// shape of the workspace that motivated #913.
function tabs(): MergeTabOption[] {
  return [
    { id: 'tab-a', label: 'A · repo', cwds: ['/repo'], directories: ['repo'], sessionCount: 1 },
    { id: 'tab-b', label: 'B · other', cwds: ['/other'], directories: ['other'], sessionCount: 2 },
    { id: 'tab-c', label: 'C · repo', cwds: ['/repo', '/repo/.worktrees/x'], directories: ['repo', 'x'], sessionCount: 3 },
  ]
}

const keep = () => screen.getByLabelText('Keep') as HTMLSelectElement
const box = (label: string) => screen.getByRole('checkbox', { name: new RegExp(label) }) as HTMLInputElement

describe('MergeProjectTabsModal', () => {
  it('keeps the active tab and pre-ticks its duplicates even when mounted before the workspace loaded', () => {
    const onConfirm = vi.fn()
    // The surface registry mounts every modal at app start, when the store
    // has no tabs and an empty active id; the dialog opens much later.
    const view = render(
      <MergeProjectTabsModal open={false} tabs={[]} initialTargetId="" onCancel={vi.fn()} onConfirm={onConfirm} />,
    )
    view.rerender(
      <MergeProjectTabsModal open={false} tabs={tabs()} initialTargetId="tab-c" onCancel={vi.fn()} onConfirm={onConfirm} />,
    )
    view.rerender(
      <MergeProjectTabsModal open tabs={tabs()} initialTargetId="tab-c" onCancel={vi.fn()} onConfirm={onConfirm} />,
    )

    expect(keep().value).toBe('tab-c')
    expect(box('A · repo').checked).toBe(true)
    expect(box('B · other').checked).toBe(false)
    expect(screen.getByRole('status')).toHaveTextContent('1 tab, 1 agent move to C · repo.')

    fireEvent.click(screen.getByRole('button', { name: 'Merge' }))
    expect(onConfirm).toHaveBeenCalledWith('tab-c', ['tab-a'])
  })

  it('re-seeds the ticked tabs when the kept tab changes', () => {
    render(
      <MergeProjectTabsModal open tabs={tabs()} initialTargetId="tab-c" onCancel={vi.fn()} onConfirm={vi.fn()} />,
    )
    fireEvent.change(keep(), { target: { value: 'tab-b' } })
    expect(keep().value).toBe('tab-b')
    // Nothing shares a folder with B, so nothing is pre-ticked and Merge waits.
    expect(box('A · repo').checked).toBe(false)
    expect(box('C · repo').checked).toBe(false)
    expect(screen.getByRole('button', { name: 'Merge' })).toBeDisabled()

    fireEvent.click(box('C · repo'))
    expect(screen.getByRole('status')).toHaveTextContent('1 tab, 3 agents move to B · other.')
  })

  it('drops a tab that closed while open, and a fallback target is never left ticked', () => {
    const onConfirm = vi.fn()
    const view = render(
      <MergeProjectTabsModal open tabs={tabs()} initialTargetId="tab-c" onCancel={vi.fn()} onConfirm={onConfirm} />,
    )
    expect(box('A · repo').checked).toBe(true)

    // The kept tab C closes: A becomes the kept tab, so its tick must go
    // with it — a target that is also a source is refused by the planner.
    view.rerender(
      <MergeProjectTabsModal
        open
        tabs={tabs().filter(tab => tab.id !== 'tab-c')}
        initialTargetId="tab-a"
        onCancel={vi.fn()}
        onConfirm={onConfirm}
      />,
    )
    expect(keep().value).toBe('tab-a')
    expect(box('B · other').checked).toBe(false)
    expect(screen.getByRole('status')).toHaveTextContent('Tick at least one tab to merge.')
    expect(screen.getByRole('button', { name: 'Merge' })).toBeDisabled()
  })

  it('merges on Enter from a ticked source and says so on the button (plan S17)', () => {
    // Merge closes nothing, so Enter may commit it; before, no key did.
    const onConfirm = vi.fn()
    render(<MergeProjectTabsModal open tabs={tabs()} initialTargetId="tab-c" onCancel={vi.fn()} onConfirm={onConfirm} />)
    expect(screen.getByRole('button', { name: 'Merge' }).querySelector('[data-slot="kbd"]')?.textContent).toBe('↩')
    fireEvent.keyDown(box('A · repo'), { key: 'Enter' })
    expect(onConfirm).toHaveBeenCalledWith('tab-c', ['tab-a'])
  })

  it('does NOT merge on Enter in the Keep select, where Enter means "choose this tab" (steering note k4)', () => {
    const onConfirm = vi.fn()
    render(<MergeProjectTabsModal open tabs={tabs()} initialTargetId="tab-c" onCancel={vi.fn()} onConfirm={onConfirm} />)
    keep().focus()
    expect(fireEvent.keyDown(keep(), { key: 'Enter' })).toBe(true) // default kept for the select
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('leaves Enter on a focused Cancel to Cancel', () => {
    const onConfirm = vi.fn()
    render(<MergeProjectTabsModal open tabs={tabs()} initialTargetId="tab-c" onCancel={vi.fn()} onConfirm={onConfirm} />)
    expect(fireEvent.keyDown(screen.getByRole('button', { name: 'Cancel' }), { key: 'Enter' })).toBe(true)
    expect(onConfirm).not.toHaveBeenCalled()
  })
})

