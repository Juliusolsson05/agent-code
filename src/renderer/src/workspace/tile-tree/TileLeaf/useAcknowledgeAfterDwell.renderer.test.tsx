import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useGoalLoopView } from '@renderer/features/goal-loop/viewState'
import { useTldrView } from '@renderer/features/tldr/viewState'
import { AgentTerminalOwnerVisibilityProvider } from '@renderer/workspace/terminal/AgentTerminalOwnership'

import { SEEN_DWELL_MS, useAcknowledgeAfterDwell } from './useAcknowledgeAfterDwell'

// #1172: when an unseen completion counts as seen. The workspace is driven with
// arrow keys, so focus sweeping across a pane must NOT clear it. Stopping on a
// watched pane must. Every "not actually watching" case the PR #1176 review
// found has its own test: hidden behind a takeover, app in the background, a
// peek overlay up, and a reused lane switching agents.

type Props = { sessionId: string; focused: boolean; unread: boolean }

// renderHook doesn't pass props to its wrapper, so the wrapper reads this.
let workspaceVisible = true

function mount(initial: Partial<Props> = {}) {
  const acknowledge = vi.fn()
  const view = renderHook(
    ({ sessionId, focused, unread }: Props) => useAcknowledgeAfterDwell({ sessionId, focused, unread, acknowledge }),
    {
      initialProps: { sessionId: 'a', focused: true, unread: true, ...initial },
      // The same context Reader/Spotlight/Settings and editor fullscreen use to
      // hide the retained workspace.
      wrapper: ({ children }: { children: ReactNode }) => (
        <AgentTerminalOwnerVisibilityProvider visible={workspaceVisible}>{children}</AgentTerminalOwnerVisibilityProvider>
      ),
    },
  )
  return { acknowledge, ...view }
}

function advance(ms: number) {
  act(() => { vi.advanceTimersByTime(ms) })
}

let windowHasFocus = true
function setWindowFocus(focused: boolean) {
  windowHasFocus = focused
  act(() => { window.dispatchEvent(new Event(focused ? 'focus' : 'blur')) })
}

describe('useAcknowledgeAfterDwell', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    windowHasFocus = true
    workspaceVisible = true
    vi.spyOn(document, 'hasFocus').mockImplementation(() => windowHasFocus)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    useTldrView.setState({ held: false, latched: false })
    useGoalLoopView.setState({ latched: false })
  })

  it('does not acknowledge a pane the user only passes through', () => {
    const { acknowledge, rerender } = mount({ focused: false })
    // An arrow-key hop: focused for a moment, then gone.
    rerender({ sessionId: 'a', focused: true, unread: true })
    advance(250)
    rerender({ sessionId: 'a', focused: false, unread: true })
    advance(SEEN_DWELL_MS * 2)
    expect(acknowledge).not.toHaveBeenCalled()
  })

  it('acknowledges once the user stays on the pane for the dwell', () => {
    const { acknowledge } = mount()
    advance(SEEN_DWELL_MS - 1)
    expect(acknowledge).not.toHaveBeenCalled()
    advance(1)
    expect(acknowledge).toHaveBeenCalledTimes(1)
  })

  it('restarts the dwell after leaving and coming back', () => {
    const { acknowledge, rerender } = mount()
    advance(SEEN_DWELL_MS - 100)
    rerender({ sessionId: 'a', focused: false, unread: true })
    rerender({ sessionId: 'a', focused: true, unread: true })
    // Two quick visits aren't one long look.
    advance(SEEN_DWELL_MS - 100)
    expect(acknowledge).not.toHaveBeenCalled()
    advance(100)
    expect(acknowledge).toHaveBeenCalledTimes(1)
  })

  it('acknowledges at once when the turn ends in a pane the user is already watching', () => {
    const { acknowledge, rerender } = mount({ unread: false })
    advance(SEEN_DWELL_MS + 500)
    // Synchronous, inside the commit that sets the marker, so the stripes never
    // reach the screen.
    rerender({ sessionId: 'a', focused: true, unread: true })
    expect(acknowledge).toHaveBeenCalledTimes(1)
  })

  it('counts only the rest of the dwell when the turn ends shortly after arriving', () => {
    const { acknowledge, rerender } = mount({ unread: false })
    advance(1000)
    rerender({ sessionId: 'a', focused: true, unread: true })
    advance(SEEN_DWELL_MS - 1000 - 1)
    expect(acknowledge).not.toHaveBeenCalled()
    advance(1)
    expect(acknowledge).toHaveBeenCalledTimes(1)
  })

  it('does nothing while there is no unread marker', () => {
    const { acknowledge } = mount({ unread: false })
    advance(SEEN_DWELL_MS * 3)
    expect(acknowledge).not.toHaveBeenCalled()
  })

  it('does not carry time spent on one agent over to the next in a reused lane', () => {
    // Tiled Dispatch lanes and Spotlight swap the agent under one mounted,
    // still-focused leaf.
    const { acknowledge, rerender } = mount({ sessionId: 'a', unread: false })
    advance(SEEN_DWELL_MS * 2)
    rerender({ sessionId: 'b', focused: true, unread: true })
    expect(acknowledge).not.toHaveBeenCalled()
    advance(SEEN_DWELL_MS)
    expect(acknowledge).toHaveBeenCalledTimes(1)
  })

  it('does not count a focused pane hidden behind Reader, Settings or the fullscreen editor', () => {
    workspaceVisible = false
    const { acknowledge } = mount()
    advance(SEEN_DWELL_MS * 3)
    expect(acknowledge).not.toHaveBeenCalled()
  })

  it('does not count time while the app window is in the background', () => {
    // Focused on the pane, then the user goes to the browser and the turn ends
    // there. That completion is exactly what the indicator exists for.
    const { acknowledge, rerender } = mount({ unread: false })
    advance(SEEN_DWELL_MS * 2)
    setWindowFocus(false)
    rerender({ sessionId: 'a', focused: true, unread: true })
    advance(SEEN_DWELL_MS * 3)
    expect(acknowledge).not.toHaveBeenCalled()

    // Coming back starts a fresh dwell. The earlier time doesn't count.
    setWindowFocus(true)
    expect(acknowledge).not.toHaveBeenCalled()
    advance(SEEN_DWELL_MS)
    expect(acknowledge).toHaveBeenCalledTimes(1)
  })

  it('does not count time while a TLDR, Goal or Goal Loop peek covers the panes', () => {
    for (const cover of [
      () => useTldrView.setState({ held: true }),
      () => useTldrView.setState({ latched: true }),
      () => useGoalLoopView.setState({ latched: true }),
    ]) {
      act(cover)
      const { acknowledge, unmount } = mount()
      advance(SEEN_DWELL_MS * 3)
      expect(acknowledge).not.toHaveBeenCalled()
      unmount()
      act(() => {
        useTldrView.setState({ held: false, latched: false })
        useGoalLoopView.setState({ latched: false })
      })
    }
  })

  it('acknowledges on time even while the pane re-renders constantly', () => {
    // A streaming pane re-renders many times a second, each time with a new
    // callback. Re-arming must recompute the same deadline from when watching
    // began. If it restarted from the re-render, a busy pane could never be
    // acknowledged by staying on it. The latest callback is the one that fires.
    const calls: string[] = []
    const { rerender } = renderHook(
      ({ tick }: { tick: number }) => useAcknowledgeAfterDwell({
        sessionId: 'a', focused: true, unread: true, acknowledge: () => calls.push(`ack@${tick}`),
      }),
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
