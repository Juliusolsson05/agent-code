import { render } from '@testing-library/react'
import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useUsageHeaderSnapshot } from './useUsageHeaderSnapshot'

// The polling contract, tested from the outside.
//
// WHY this test exists at all: this hook's cost is invisible in the UI. A
// disabled consumer that still polls looks exactly like a disabled consumer
// that does not, until someone reads a CPU profile or an IPC log. The bulk
// provider-switch modal is a permanently mounted surface, so "does `enabled`
// really stop everything" is the one property that keeps a background timer
// from living for the life of the app.

const originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api')

afterEach(() => {
  vi.useRealTimers()
  if (originalApiDescriptor) Object.defineProperty(window, 'api', originalApiDescriptor)
  else Reflect.deleteProperty(window, 'api')
})

function Harness({ enabled }: { enabled: boolean }) {
  const { snapshot } = useUsageHeaderSnapshot(enabled)
  return <div data-testid="fetched">{snapshot === null ? 'none' : 'snapshot'}</div>
}

describe('useUsageHeaderSnapshot', () => {
  it('fetches nothing and schedules nothing while disabled, then polls once enabled', async () => {
    vi.useFakeTimers()
    const getUsageSnapshot = vi.fn().mockResolvedValue({
      fetchedAt: '2026-09-07T12:00:00Z',
      cache: { hit: false, ttlMs: 30_000 },
      providers: [],
    })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { getUsageSnapshot },
    })

    const mounted = render(<Harness enabled={false} />)
    expect(getUsageSnapshot).not.toHaveBeenCalled()

    // Two full poll intervals of wall clock with nothing scheduled. If the
    // effect had installed its interval before checking `enabled`, this is
    // where a permanently mounted modal would start costing IPC forever.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150_000)
    })
    expect(getUsageSnapshot).not.toHaveBeenCalled()

    // The visibility listener is part of the same effect: a hidden→visible
    // transition must not wake a disabled consumer either.
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(getUsageSnapshot).not.toHaveBeenCalled()

    await act(async () => {
      mounted.rerender(<Harness enabled />)
    })
    expect(getUsageSnapshot).toHaveBeenCalledTimes(1)
    expect(mounted.getByTestId('fetched').textContent).toBe('snapshot')

    // And enabling really did arm the interval, so the modal stays current
    // while it is open.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(getUsageSnapshot).toHaveBeenCalledTimes(2)

    // Disabling again tears it back down.
    await act(async () => {
      mounted.rerender(<Harness enabled={false} />)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150_000)
    })
    expect(getUsageSnapshot).toHaveBeenCalledTimes(2)
    mounted.unmount()
  })
})
