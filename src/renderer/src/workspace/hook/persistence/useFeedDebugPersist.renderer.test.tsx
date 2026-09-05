import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { appendFeedDebugLog } from '@renderer/session-runtime/feedDebug'
import { emptyRuntime, type SessionRuntime } from '@renderer/session-runtime/state'
import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'

import { useFeedDebugPersist } from './useFeedDebugPersist'

const originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api')
const append = vi.fn<(input: Parameters<Window['api']['appendFeedDebugLog']>[0]) => Promise<void>>()

beforeEach(() => {
  vi.useFakeTimers()
  append.mockReset().mockResolvedValue(undefined)
  Object.defineProperty(window, 'api', { configurable: true, value: { appendFeedDebugLog: append } })
})

afterEach(() => {
  // Teardown itself flushes diagnostics, so it must run while the fake API and
  // timer still belong to this test, including when an assertion fails early.
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  if (originalApiDescriptor) Object.defineProperty(window, 'api', originalApiDescriptor)
  else Reflect.deleteProperty(window, 'api')
})

function add(runtime: SessionRuntime, summary: string): SessionRuntime {
  return appendFeedDebugLog(runtime, { layer: 'STATE', kind: 'test', summary })
}

function makeRefs(runtimes: Record<string, SessionRuntime>): WorkspaceRefs {
  return {
    latestRuntimesRef: { current: runtimes },
    persistedFeedDebugIdRef: { current: {} },
    inFlightFeedDebugIdRef: { current: {} },
  } as unknown as WorkspaceRefs
}

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void } {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

async function advance(ms: number): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

describe('feed debug persistence cadence and durability', () => {
  it('coalesces continuously replaced runtimes into one ordered batch on the fixed tick', async () => {
    const refs = makeRefs({ a: emptyRuntime() })
    const { rerender } = renderHook(
      ({ runtimes }) => useFeedDebugPersist(runtimes, refs),
      { initialProps: { runtimes: refs.latestRuntimesRef.current } },
    )

    // Continuous provider traffic must neither flush on every React effect nor
    // postpone the timer indefinitely as a trailing debounce would.
    for (let index = 0; index < 20; index += 1) {
      refs.latestRuntimesRef.current = { a: add(refs.latestRuntimesRef.current.a!, `row ${index}`) }
      rerender({ runtimes: refs.latestRuntimesRef.current })
      await advance(40)
    }
    await advance(199)
    expect(append).not.toHaveBeenCalled()
    await advance(1)
    expect(append).toHaveBeenCalledExactlyOnceWith({
      sessionId: 'a', entries: refs.latestRuntimesRef.current.a!.feedDebugLog,
    })
    expect(refs.persistedFeedDebugIdRef.current.a).toBe(20)
  })

  it('holds a slow session reservation while other sessions continue flushing', async () => {
    const pending = deferred()
    append.mockImplementation(({ sessionId }) => sessionId === 'a' ? pending.promise : Promise.resolve())
    const refs = makeRefs({ a: add(emptyRuntime(), 'a1'), b: add(emptyRuntime(), 'b1') })
    renderHook(() => useFeedDebugPersist(refs.latestRuntimesRef.current, refs))
    await advance(1000)
    expect(append).toHaveBeenCalledTimes(2)
    refs.latestRuntimesRef.current = {
      a: add(refs.latestRuntimesRef.current.a!, 'a2'),
      b: add(refs.latestRuntimesRef.current.b!, 'b2'),
    }
    await advance(3000)
    expect(append.mock.calls.filter(([input]) => input.sessionId === 'a')).toHaveLength(1)
    expect(append.mock.calls.filter(([input]) => input.sessionId === 'b')).toHaveLength(2)
    expect(refs.persistedFeedDebugIdRef.current.a).toBeUndefined()
    expect(refs.inFlightFeedDebugIdRef.current.a).toBe(1)
    expect(refs.persistedFeedDebugIdRef.current.b).toBe(2)

    await act(async () => { pending.resolve(); await pending.promise })
    expect(refs.persistedFeedDebugIdRef.current.a).toBe(1)
    expect(refs.inFlightFeedDebugIdRef.current.a).toBeUndefined()
    expect(append).toHaveBeenCalledTimes(3)
    await advance(999)
    expect(append).toHaveBeenCalledTimes(3)
    await advance(1)
    expect(append).toHaveBeenLastCalledWith({
      sessionId: 'a', entries: [refs.latestRuntimesRef.current.a!.feedDebugLog[1]],
    })
  })

  it('retries rejected rows on the next tick without new runtime traffic', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const pending = deferred()
    append.mockReturnValueOnce(pending.promise)
    const refs = makeRefs({ a: add(add(emptyRuntime(), 'already durable'), 'pending') })
    refs.persistedFeedDebugIdRef.current.a = 1
    renderHook(() => useFeedDebugPersist(refs.latestRuntimesRef.current, refs))
    await advance(1000)
    expect(refs.inFlightFeedDebugIdRef.current.a).toBe(2)
    await act(async () => { pending.reject(new Error('disk unavailable')); await Promise.resolve() })
    expect(refs.persistedFeedDebugIdRef.current.a).toBe(1)
    expect(refs.inFlightFeedDebugIdRef.current.a).toBeUndefined()
    expect(append).toHaveBeenCalledTimes(1)
    await advance(999)
    expect(append).toHaveBeenCalledTimes(1)
    await advance(1)
    expect(append).toHaveBeenCalledTimes(2)
    expect(append.mock.calls[1]).toEqual(append.mock.calls[0])
    expect(append.mock.calls[1]![0].entries.map(entry => entry.id)).toEqual([2])
    expect(refs.persistedFeedDebugIdRef.current.a).toBe(2)
  })

  it('leaves empty and already durable sessions quiet', async () => {
    const refs = makeRefs({ empty: emptyRuntime(), durable: add(emptyRuntime(), 'saved') })
    refs.persistedFeedDebugIdRef.current.durable = 1
    const { unmount } = renderHook(() => useFeedDebugPersist(refs.latestRuntimesRef.current, refs))
    await advance(3000)
    unmount()
    expect(append).not.toHaveBeenCalled()
  })

  it('flushes the latest refs once on unmount and removes the interval', async () => {
    const refs = makeRefs({ a: emptyRuntime() })
    const { unmount } = renderHook(() => useFeedDebugPersist(refs.latestRuntimesRef.current, refs))
    refs.latestRuntimesRef.current = { a: add(emptyRuntime(), 'last record') }
    unmount()
    expect(append).toHaveBeenCalledExactlyOnceWith({
      sessionId: 'a', entries: refs.latestRuntimesRef.current.a!.feedDebugLog,
    })
    // A ref update after teardown exposes leaked timer ownership even if the
    // previous final batch was acknowledged and would otherwise look quiet.
    refs.latestRuntimesRef.current = { a: add(refs.latestRuntimesRef.current.a!, 'after teardown') }
    await advance(3000)
    expect(append).toHaveBeenCalledTimes(1)
  })

  it('does not overlap an unresolved write or drain new rows after unmount', async () => {
    const pending = deferred()
    append.mockReturnValueOnce(pending.promise)
    const refs = makeRefs({ a: add(emptyRuntime(), 'first') })
    const { unmount } = renderHook(() => useFeedDebugPersist(refs.latestRuntimesRef.current, refs))
    await advance(1000)
    refs.latestRuntimesRef.current = { a: add(refs.latestRuntimesRef.current.a!, 'later') }
    unmount()
    expect(append).toHaveBeenCalledTimes(1)
    await act(async () => { pending.resolve(); await pending.promise })
    await advance(3000)
    expect(append).toHaveBeenCalledTimes(1)
    expect(refs.persistedFeedDebugIdRef.current.a).toBe(1)
  })
})
