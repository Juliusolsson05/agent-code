import { act, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ToastHostProvider, useGlobalToast } from './ToastHost'

// A shared-row stand-in: the whole point of this host is that components
// importing `@renderer/ui/GlobalToast` (aliased here) stop calling the
// no-op default context. The probe uses the exact call shape
// AskUserQuestionRow uses.
function Probe() {
  const { showToast } = useGlobalToast()
  return (
    <button type="button" onClick={() => showToast('Could not send your answer: boom')}>
      fail
    </button>
  )
}

describe('phone ToastHostProvider', () => {
  it('surfaces row-level failures as a visible status node', async () => {
    vi.useFakeTimers()
    const { getByText } = render(
      <ToastHostProvider>
        <Probe />
      </ToastHostProvider>,
    )
    act(() => {
      getByText('fail').click()
    })
    // The failure text is VISIBLE — the pre-host phone swallowed this into
    // the no-op default context and the user never learned their answer
    // didn't send.
    expect(screen.getByRole('status').textContent).toContain('Could not send your answer')
    // Auto-dismiss honors the default duration.
    act(() => {
      vi.advanceTimersByTime(2600)
    })
    expect(screen.queryByRole('status')).toBeNull()
    vi.useRealTimers()
  })
})
