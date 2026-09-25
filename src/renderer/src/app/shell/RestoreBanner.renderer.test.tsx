import { act, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

// The banner reads two fields of the layout context; mocking the hook keeps
// the test on the banner's own decision rather than the whole workspace.
let context: { restoreStatus: string; saveFailure: string | null } = { restoreStatus: 'complete-restore', saveFailure: null }
vi.mock('@renderer/workspace/WorkspaceContext', () => ({ useWorkspaceLayoutContext: () => context }))

import { RestoreBanner } from './RestoreBanner'

describe('RestoreBanner', () => {
  it('says workspace changes are not being saved, with the storage error (#1244)', () => {
    context = { restoreStatus: 'complete-restore', saveFailure: "EACCES: permission denied, open '/state/workspace.json'" }
    render(<RestoreBanner />)
    expect(screen.getByRole('alert').textContent).toContain("Workspace changes are not being saved: EACCES: permission denied, open '/state/workspace.json'")
  })

  // #1263 review C: a workspace.json this build refused at load stays
  // refused for the whole process, so "changes save on the next success" was
  // false there. The banner says what will actually help.
  it('does not promise a later save when the workspace file is read-only this session', () => {
    context = { restoreStatus: 'complete-restore', saveFailure: 'Workspace file is read-only this session: workspace.json has an unsupported version (9)' }
    render(<RestoreBanner />)
    const text = screen.getByRole('alert').textContent ?? ''
    expect(text).toContain('workspace.json has an unsupported version (9)')
    expect(text).not.toContain('save on the next success')
    expect(text).toContain('Quit Agent Code')
  })

  it('shows nothing while saves work', () => {
    context = { restoreStatus: 'complete-restore', saveFailure: null }
    const { container } = render(<RestoreBanner />)
    expect(container).toBeEmptyDOMElement()
  })

  it('keeps a restore problem first: its autosave-off state is the more severe one', () => {
    context = { restoreStatus: 'partial-restore', saveFailure: 'ENOSPC' }
    render(<RestoreBanner />)
    expect(screen.getByRole('alert').textContent).toContain('partially restored')
  })

  it('labels failing saves "Not saving", expanded and collapsed, never "Autosave off" (#1263 review)', () => {
    vi.useFakeTimers()
    try {
      context = { restoreStatus: 'complete-restore', saveFailure: 'ENOSPC: no space left on device' }
      render(<RestoreBanner />)
      expect(screen.getByRole('alert').textContent).toContain('Not saving')
      expect(screen.getByRole('alert').textContent).not.toContain('Autosave off')
      act(() => { vi.advanceTimersByTime(60_000) })
      expect(screen.getByRole('button', { name: 'Show save-failure details' }).textContent).toContain('Not saving')
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps "Autosave off" for a restore problem, whose autosave really is off', () => {
    vi.useFakeTimers()
    try {
      context = { restoreStatus: 'partial-restore', saveFailure: null }
      render(<RestoreBanner />)
      act(() => { vi.advanceTimersByTime(60_000) })
      expect(screen.getByRole('button', { name: 'Show autosave-off details' }).textContent).toContain('Autosave off')
    } finally {
      vi.useRealTimers()
    }
  })
})
