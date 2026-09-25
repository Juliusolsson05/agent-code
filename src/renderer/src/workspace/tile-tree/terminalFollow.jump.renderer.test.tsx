import { renderHook } from '@testing-library/react'
import type { Terminal } from '@xterm/xterm'
import { expect, it, vi } from 'vitest'

import { useTerminalFollow } from './terminalFollow'

// #843 part 2: a TUI on the alternate screen (OpenCode Terminal) owns its
// transcript scroll, so xterm's scrollToBottom cannot reach it, and the leaf
// also asks the provider to scroll itself. That request must go out once per
// NEW Jump to Latest, and never for the baseline a mount or a session switch
// takes: a pane that jumped on every remount would yank the user to the
// bottom whenever they switched lanes.
function fakeTerminal() {
  return { scrollToBottom: vi.fn(), buffer: { active: { type: 'normal', viewportY: 0, baseY: 0 } } } as unknown as Terminal
}

it('asks the provider to jump once per new request, never on mount or session switch', () => {
  const term = fakeTerminal()
  const onJumpToLatest = vi.fn()
  const hook = renderHook(props => useTerminalFollow(props), {
    initialProps: { sessionId: 'a', scrollToLatestRequest: 3, tailActive: false, termRef: { current: term }, onJumpToLatest },
  })
  expect(onJumpToLatest).not.toHaveBeenCalled()

  hook.rerender({ sessionId: 'a', scrollToLatestRequest: 4, tailActive: false, termRef: { current: term }, onJumpToLatest })
  expect(onJumpToLatest).toHaveBeenCalledTimes(1)
  expect(term.scrollToBottom).toHaveBeenCalledTimes(1)

  // A different session re-baselines instead of replaying the old request.
  hook.rerender({ sessionId: 'b', scrollToLatestRequest: 4, tailActive: false, termRef: { current: term }, onJumpToLatest })
  expect(onJumpToLatest).toHaveBeenCalledTimes(1)
  hook.rerender({ sessionId: 'b', scrollToLatestRequest: 5, tailActive: false, termRef: { current: term }, onJumpToLatest })
  expect(onJumpToLatest).toHaveBeenCalledTimes(2)
})
