import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { Feed } from '@renderer/features/feed/ui/Feed'

// The transcript scroller from the keyboard (ledger N13 / K2-4). It held
// buttons, so it was never a Tab stop, and a keyboard user had no way to
// scroll or page through a conversation. Rendering an empty feed is enough:
// the contract is on the scroller element, not on any row.

describe('Feed scroller', () => {
  it('is a labelled Tab stop, and keyboard scrolling counts as engagement', () => {
    const onUserEngagement = vi.fn()
    render(<Feed sessionId="s1" provider="claude" entries={[]} onUserEngagement={onUserEngagement} />)
    const scroller = screen.getByRole('region', { name: 'Conversation' })
    expect(scroller.tabIndex).toBe(0)

    scroller.focus()
    fireEvent.keyDown(scroller, { key: 'PageUp' })
    expect(onUserEngagement).toHaveBeenCalledTimes(1)
  })

  it('leaves a key pressed inside a feed control to that control', () => {
    const onUserEngagement = vi.fn()
    render(<Feed sessionId="s1" provider="claude" entries={[]} onUserEngagement={onUserEngagement} />)
    const scroller = screen.getByRole('region', { name: 'Conversation' })
    const inner = document.createElement('button')
    scroller.append(inner)
    fireEvent.keyDown(inner, { key: 'Enter' })
    expect(onUserEngagement).not.toHaveBeenCalled()
  })
})
