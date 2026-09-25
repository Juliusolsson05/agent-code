import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Workspace } from '@renderer/workspace/workspaceStore'

import { usePocketLiveStore } from '../state/pocketLiveStore'
import { PocketStrip } from './PocketStrip'

// The collapsed pocket strip from the keyboard (K2-8 / K2-9). Its status
// glyphs ("● agent", "!", "3 err") explained themselves only in hover
// titles, and the page thumbnail appeared on mouseenter only, so a keyboard
// user saw a status they could never expand.

const thumbnail = vi.fn(async () => 'data:image/png;base64,AAAA')
beforeEach(() => {
  window.api = { ...(window.api ?? {}), pocketThumbnail: thumbnail } as unknown as typeof window.api
  usePocketLiveStore.getState().patch('p1', {
    failed: { code: 'ERR_CONNECTION_REFUSED', description: 'connection refused', url: 'http://localhost:5173/' },
    unseenErrors: 3,
  })
})
afterEach(() => {
  cleanup()
  usePocketLiveStore.getState().forget('p1')
  thumbnail.mockClear()
})

const workspace = {
  state: { sessions: { s1: { cwd: '/w', kind: 'claude', browserPocket: { pocketId: 'p1', view: 'collapsed', profile: 'lane', url: 'http://localhost:5173/app' } } } },
  updateBrowserPocket: () => {},
} as unknown as Workspace

describe('PocketStrip', () => {
  it('opens its details on keyboard focus, spelled out and linked to the focused control', async () => {
    render(<PocketStrip sessionId={'s1' as never} workspace={workspace} />)
    expect(screen.queryByRole('tooltip')).toBeNull()

    const open = screen.getByRole('button', { name: 'Open browser pocket' })
    await act(async () => { open.focus() })
    const details = screen.getByRole('tooltip')
    expect(details.textContent).toContain('Page failed: connection refused')
    expect(details.textContent).toContain('3 console errors since you last opened the pocket')
    expect(open.getAttribute('aria-describedby')).toBe(details.id)
    // The preview is fetched for focus too, not only mouseenter.
    expect(thumbnail).toHaveBeenCalledTimes(1)

    // Moving focus WITHIN the strip keeps it open; leaving the strip closes it.
    const url = screen.getByRole('button', { name: /localhost:5173\/app/ })
    fireEvent.blur(open, { relatedTarget: url })
    expect(screen.getByRole('tooltip')).toBeTruthy()
    fireEvent.blur(url, { relatedTarget: document.body })
    expect(screen.queryByRole('tooltip')).toBeNull()
  })
})
