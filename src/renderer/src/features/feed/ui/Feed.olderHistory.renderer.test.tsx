import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { Feed } from '@renderer/features/feed/ui/Feed'

// #1413 review a and b: after a failed older-history page, the pane says
// "Scroll up again to retry". The real Feed used to request a page only on a
// `scroll` event, and at scrollTop 0 an upward wheel moves nothing, so no
// event fired: the retry the toast promised could not happen at the top.

describe('Feed older-history trigger', () => {
  it('retries a failed page on an upward wheel at the very top', async () => {
    const onLoadOlderHistory = vi.fn(async () => {})
    render(<Feed sessionId="s1" provider="claude" entries={[]} hasOlderHistory onLoadOlderHistory={onLoadOlderHistory} />)
    const scroller = screen.getByRole('region', { name: 'Conversation' })
    expect(scroller.scrollTop).toBe(0)
    // First request (as a scroll to the top makes it) fails in the hook.
    await act(async () => { fireEvent.wheel(scroller, { deltaY: -40 }) })
    expect(onLoadOlderHistory).toHaveBeenCalledTimes(1)
    // The user does what the toast says: another upward gesture, still at 0.
    await act(async () => { fireEvent.wheel(scroller, { deltaY: -40 }) })
    expect(onLoadOlderHistory).toHaveBeenCalledTimes(2)
  })

  // Verification b: the touch form of the same gesture.
  it('retries on a downward finger drag at the very top, and not on an upward one', async () => {
    const onLoadOlderHistory = vi.fn(async () => {})
    render(<Feed sessionId="s1" provider="claude" entries={[]} hasOlderHistory onLoadOlderHistory={onLoadOlderHistory} />)
    const scroller = screen.getByRole('region', { name: 'Conversation' })
    await act(async () => {
      fireEvent.touchStart(scroller, { touches: [{ clientY: 100 }] })
      fireEvent.touchMove(scroller, { touches: [{ clientY: 60 }] })
    })
    expect(onLoadOlderHistory).not.toHaveBeenCalled()
    await act(async () => {
      fireEvent.touchStart(scroller, { touches: [{ clientY: 100 }] })
      fireEvent.touchMove(scroller, { touches: [{ clientY: 140 }] })
    })
    expect(onLoadOlderHistory).toHaveBeenCalledTimes(1)
  })

  it('does not load on a downward wheel', async () => {
    const onLoadOlderHistory = vi.fn(async () => {})
    render(<Feed sessionId="s1" provider="claude" entries={[]} hasOlderHistory onLoadOlderHistory={onLoadOlderHistory} />)
    const scroller = screen.getByRole('region', { name: 'Conversation' })
    await act(async () => { fireEvent.wheel(scroller, { deltaY: 40 }) })
    expect(onLoadOlderHistory).not.toHaveBeenCalled()
  })
})
