import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { Workspace } from '@renderer/workspace/workspaceStore'

import { DispatchRowProjectModal } from './DispatchRowProjectModal'

// Row Projects on the shared list keys (plan S10). Before: every project was
// its own Tab stop and no arrow key moved; toggles still apply LIVE, so the
// only exit is Close.

function harness(projectTabIds: string[] = []) {
  const setDispatchRowProjects = vi.fn()
  const workspace = {
    state: {
      tabs: [{ id: 'a', title: 'app' }, { id: 'b', title: 'service' }, { id: 'c', title: 'docs' }],
      stage: { focusedLane: 0, lanes: [{}], rows: [{ length: 1, projectTabIds }] },
    },
    setDispatchRowProjects,
  } as unknown as Workspace
  render(<DispatchRowProjectModal rowIndex={0} workspace={workspace} onClose={() => {}} />)
  return { setDispatchRowProjects, listbox: screen.getByRole('listbox') }
}

describe('Row Projects', () => {
  it('focuses the listbox and toggles the arrowed-to project with Space', () => {
    const { setDispatchRowProjects, listbox } = harness()
    expect(document.activeElement).toBe(listbox)
    fireEvent.keyDown(listbox, { key: 'ArrowDown' })
    fireEvent.keyDown(listbox, { key: ' ' })
    expect(setDispatchRowProjects).toHaveBeenCalledWith(0, ['b'])
  })

  it('keeps projects out of the Tab order and closes from one Close ⎋', () => {
    harness(['a'])
    for (const option of screen.getAllByRole('option')) expect(option).toHaveAttribute('tabindex', '-1')
    expect(screen.getByRole('option', { name: /app/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('button', { name: 'Close' }).querySelector('[data-slot="kbd"]')?.textContent).toBe('⎋')
    expect(screen.getByRole('button', { name: 'Any Project' })).toBeEnabled()
  })
})
