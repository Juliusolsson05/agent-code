import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { EditorStatusBanner } from '@renderer/features/editor/ui/EditorStatusBanner'

// The save-conflict banner is read right before a destructive choice (K2-6).
// It mounts with its text, so it must be an alert to be announced at all, and
// its message must not be single-line truncated with the rest only in a hover
// title, which no keyboard user can read.

const LONG = 'The file changed on disk after you opened it: /Users/dev/project/src/very/deep/path/to/a/file/with/a/long/name.ts was modified by another process at 12:04:33.'

describe('EditorStatusBanner', () => {
  it('announces the conflict and shows the whole message with both recovery actions', () => {
    const onReload = vi.fn()
    const onOverwrite = vi.fn()
    render(<EditorStatusBanner message={LONG} conflict externalChange="changed" onReload={onReload} onOverwrite={onOverwrite} />)
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain(LONG)
    // No hover-only remainder: the message element wraps rather than truncates.
    const text = screen.getByText(LONG)
    expect(text.className).not.toContain('truncate')
    expect(text.hasAttribute('title')).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: 'Reload from disk' }))
    fireEvent.click(screen.getByRole('button', { name: 'Overwrite' }))
    expect(onReload).toHaveBeenCalledTimes(1)
    expect(onOverwrite).toHaveBeenCalledTimes(1)
  })
})
