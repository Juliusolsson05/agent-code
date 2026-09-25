import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SEEN_DWELL_MS, useAcknowledgeAfterDwell } from './useAcknowledgeAfterDwell'

// #1172: when an unseen completion counts as seen. The workspace is driven with
// arrow keys, so focus sweeping across a pane must NOT clear it. Stopping on a
// visible pane must. These pin that distinction, plus the "already watching"
// case that must not flash.

type Props = { active: boolean; unread: boolean }

function mount(initial: Props) {
  const acknowledge = vi.fn()
  const view = renderHook(
    ({ active, unread }: Props) => useAcknowledgeAfterDwell(active, unread, acknowledge),
    { initialProps: initial },
  )
  return { acknowledge, ...view }
}

function advance(ms: number) {
  act(() => { vi.advanceTimersByTime(ms) })
}

describe('useAcknowledgeAfterDwell', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('does not acknowledge a pane the user only passes through', () => {
    const { acknowledge, rerender } = mount({ active: false, unread: true })
    // An arrow-key hop: focused and visible for a moment, then gone.
    rerender({ active: true, unread: true })
    advance(250)
    rerender({ active: false, unread: true })
    advance(SEEN_DWELL_MS * 2)
    expect(acknowledge).not.toHaveBeenCalled()
  })

  it('acknowledges once the user stays on the pane for the dwell', () => {
    const { acknowledge, rerender } = mount({ active: false, unread: true })
    rerender({ active: true, unread: true })
    advance(SEEN_DWELL_MS - 1)
    expect(acknowledge).not.toHaveBeenCalled()
    advance(1)
    expect(acknowledge).toHaveBeenCalledTimes(1)
  })

  it('restarts the dwell after leaving and coming back', () => {
    const { acknowledge, rerender } = mount({ active: true, unread: true })
    advance(SEEN_DWELL_MS - 100)
    rerender({ active: false, unread: true })
    rerender({ active: true, unread: true })
    // Time on the pane before leaving doesn't carry over. Two quick visits
    // aren't one long look.
    advance(SEEN_DWELL_MS - 100)
    expect(acknowledge).not.toHaveBeenCalled()
    advance(100)
    expect(acknowledge).toHaveBeenCalledTimes(1)
  })

  it('acknowledges at once when the turn ends in a pane the user is already watching', () => {
    const { acknowledge, rerender } = mount({ active: true, unread: false })
    advance(SEEN_DWELL_MS + 500)
    // Called synchronously inside the commit that sets the marker, not on a
    // timer, so the stripes never reach the screen.
    rerender({ active: true, unread: true })
    expect(acknowledge).toHaveBeenCalledTimes(1)
  })

  it('counts only the rest of the dwell when the turn ends shortly after arriving', () => {
    const { acknowledge, rerender } = mount({ active: true, unread: false })
    advance(1000)
    rerender({ active: true, unread: true })
    advance(SEEN_DWELL_MS - 1000 - 1)
    expect(acknowledge).not.toHaveBeenCalled()
    advance(1)
    expect(acknowledge).toHaveBeenCalledTimes(1)
  })

  it('does nothing while there is no unread marker', () => {
    const { acknowledge } = mount({ active: true, unread: false })
    advance(SEEN_DWELL_MS * 3)
    expect(acknowledge).not.toHaveBeenCalled()
  })

  it('acknowledges on time even while the pane re-renders constantly', () => {
    // A streaming pane re-renders many times a second, each time with a new
    // callback. Re-arming must recompute the same deadline from when the pane
    // became active. If it restarted the dwell from the re-render instead, a
    // busy pane could never be acknowledged by staying on it. The latest
    // callback is the one that fires.
    const calls: string[] = []
    const { rerender } = renderHook(
      ({ tick }: { tick: number }) => useAcknowledgeAfterDwell(true, true, () => calls.push(`ack@${tick}`)),
      { initialProps: { tick: 0 } },
    )
    for (let tick = 1; tick <= 10; tick++) {
      advance(SEEN_DWELL_MS / 10 - 1)
      rerender({ tick })
    }
    advance(10)
    expect(calls).toEqual(['ack@10'])
  })
})
