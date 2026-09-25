import { renderHook } from '@testing-library/react'
import { expect, it, vi } from 'vitest'

import { usePaneToast } from './helpers'

// #1262 review A: an async action can finish after its pane was closed. A
// toast for that pane used to recreate a runtime row for the dead id, and the
// dismiss timer wrote it again, so the row was never removed.
it('shows no toast for a pane that is no longer in the workspace', () => {
  vi.useFakeTimers()
  try {
    const updateRuntime = vi.fn()
    const timers = { current: {} as Record<string, ReturnType<typeof setTimeout>> }
    const stateRef = { current: { sessions: { live: {} } } }
    const { result } = renderHook(() => usePaneToast(timers as never, updateRuntime, stateRef as never))
    result.current('gone', 'late message')
    vi.runAllTimers()
    expect(updateRuntime).not.toHaveBeenCalled()
    result.current('live', 'shown')
    expect(updateRuntime).toHaveBeenCalledWith('live', { paneToast: 'shown' })
  } finally {
    vi.useRealTimers()
  }
})
