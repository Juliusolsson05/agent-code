import { act, renderHook } from '@testing-library/react'
import type { MutableRefObject } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { appendFeedDebugLog } from '@renderer/session-runtime/feedDebug'
import { emptyRuntime, type SessionRuntime } from '@renderer/session-runtime/state'
import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'
import type { SessionId } from '@renderer/workspace/types'

import { FEED_DEBUG_FLUSH_INTERVAL_MS, FEED_DEBUG_FLUSH_MAX_PENDING } from './feedDebugFlushPolicy'
import { useFeedDebugPersist } from './useFeedDebugPersist'

// #748: the hook re-runs on every runtimes replacement (dozens per second
// while streaming); appends must be paced by the flush interval and carry
// everything that arrived in between, without weakening the cursor rules.

const originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api')

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  if (originalApiDescriptor) {
    Object.defineProperty(window, 'api', originalApiDescriptor)
  } else {
    Reflect.deleteProperty(window, 'api')
  }
})

function ref<T>(current: T): MutableRefObject<T> {
  return { current }
}

function withEntries(runtime: SessionRuntime, count: number): SessionRuntime {
  let next = runtime
  for (let i = 0; i < count; i += 1) {
    next = appendFeedDebugLog(next, { layer: 'RENDER', kind: 'visible_rows', summary: `rows ${i}` })
  }
  return next
}

function makeRefs(runtimes: Record<SessionId, SessionRuntime>) {
  return {
    latestRuntimesRef: ref(runtimes),
    persistedFeedDebugIdRef: ref<Record<SessionId, number>>({}),
    inFlightFeedDebugIdRef: ref<Record<SessionId, number>>({}),
  } as unknown as WorkspaceRefs
}

function install(appendFeedDebugLog: ReturnType<typeof vi.fn>) {
  Object.defineProperty(window, 'api', { configurable: true, value: { appendFeedDebugLog } })
}

describe('useFeedDebugPersist pacing', () => {
  it('sends the first batch at once, then one paced batch carrying every entry that arrived in between', async () => {
    vi.useFakeTimers()
    const append = vi.fn().mockResolvedValue(undefined)
    install(append)
    let runtimes: Record<SessionId, SessionRuntime> = { s1: withEntries(emptyRuntime(), 1) }
    const refs = makeRefs(runtimes)
    const { rerender } = renderHook(({ r }) => useFeedDebugPersist(r, refs), { initialProps: { r: runtimes } })
    expect(append).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(refs.persistedFeedDebugIdRef.current.s1).toBe(1)

    // Streaming: 20 replacements inside the interval, one entry each.
    for (let i = 0; i < 20; i += 1) {
      runtimes = { s1: withEntries(runtimes.s1!, 1) }
      refs.latestRuntimesRef.current = runtimes
      rerender({ r: runtimes })
      await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    }
    expect(append).toHaveBeenCalledTimes(1)

    await act(async () => { await vi.advanceTimersByTimeAsync(FEED_DEBUG_FLUSH_INTERVAL_MS) })
    expect(append).toHaveBeenCalledTimes(2)
    const second = append.mock.calls[1]![0] as { entries: Array<{ id: number }> }
    expect(second.entries.map(e => e.id)).toEqual(Array.from({ length: 20 }, (_, i) => i + 2))
    expect(refs.persistedFeedDebugIdRef.current.s1).toBe(21)
  })

  it('forces a flush inside the interval once pending entries reach the ceiling', async () => {
    vi.useFakeTimers()
    const append = vi.fn().mockResolvedValue(undefined)
    install(append)
    let runtimes: Record<SessionId, SessionRuntime> = { s1: withEntries(emptyRuntime(), 1) }
    const refs = makeRefs(runtimes)
    const { rerender } = renderHook(({ r }) => useFeedDebugPersist(r, refs), { initialProps: { r: runtimes } })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(append).toHaveBeenCalledTimes(1)

    runtimes = { s1: withEntries(runtimes.s1!, FEED_DEBUG_FLUSH_MAX_PENDING) }
    refs.latestRuntimesRef.current = runtimes
    rerender({ r: runtimes })
    expect(append).toHaveBeenCalledTimes(2)
  })

  it('keeps failed entries pending and retries no sooner than the interval', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const append = vi.fn()
      .mockRejectedValueOnce(new Error('main not ready'))
      .mockResolvedValue(undefined)
    install(append)
    let runtimes: Record<SessionId, SessionRuntime> = { s1: withEntries(emptyRuntime(), 2) }
    const refs = makeRefs(runtimes)
    const { rerender } = renderHook(({ r }) => useFeedDebugPersist(r, refs), { initialProps: { r: runtimes } })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(append).toHaveBeenCalledTimes(1)
    expect(refs.persistedFeedDebugIdRef.current.s1).toBeUndefined()

    // A replacement right after the failure must not retry immediately.
    runtimes = { s1: withEntries(runtimes.s1!, 1) }
    refs.latestRuntimesRef.current = runtimes
    rerender({ r: runtimes })
    expect(append).toHaveBeenCalledTimes(1)

    await act(async () => { await vi.advanceTimersByTimeAsync(FEED_DEBUG_FLUSH_INTERVAL_MS) })
    expect(append).toHaveBeenCalledTimes(2)
    const retry = append.mock.calls[1]![0] as { entries: Array<{ id: number }> }
    expect(retry.entries.map(e => e.id)).toEqual([1, 2, 3])
    expect(refs.persistedFeedDebugIdRef.current.s1).toBe(3)
  })

  it('clears the pacing timer on unmount', async () => {
    vi.useFakeTimers()
    const append = vi.fn().mockResolvedValue(undefined)
    install(append)
    let runtimes: Record<SessionId, SessionRuntime> = { s1: withEntries(emptyRuntime(), 1) }
    const refs = makeRefs(runtimes)
    const { rerender, unmount } = renderHook(({ r }) => useFeedDebugPersist(r, refs), { initialProps: { r: runtimes } })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    runtimes = { s1: withEntries(runtimes.s1!, 1) }
    refs.latestRuntimesRef.current = runtimes
    rerender({ r: runtimes })
    unmount()
    await act(async () => { await vi.advanceTimersByTimeAsync(FEED_DEBUG_FLUSH_INTERVAL_MS * 2) })
    expect(append).toHaveBeenCalledTimes(1)
  })
})
