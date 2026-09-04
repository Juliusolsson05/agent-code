import { act, renderHook } from '@testing-library/react'
import { StrictMode } from 'react'
import type { MutableRefObject } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { appendFeedDebugLog } from '@renderer/session-runtime/feedDebug'
import { emptyRuntime, type SessionRuntime } from '@renderer/session-runtime/state'
import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'
import type { SessionId } from '@renderer/workspace/types'

import {
  FEED_DEBUG_FLUSH_INTERVAL_MS,
  FEED_DEBUG_FLUSH_MAX_PENDING,
  FEED_DEBUG_FLUSH_MAX_PENDING_BYTES,
} from './feedDebugFlushPolicy'
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

function withEntries(runtime: SessionRuntime, count: number, data?: unknown): SessionRuntime {
  let next = runtime
  for (let i = 0; i < count; i += 1) {
    next = appendFeedDebugLog(next, { layer: 'RENDER', kind: 'visible_rows', summary: `rows ${i}`, data })
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

  it('forces a flush inside the interval when a few large entries reach the byte ceiling', async () => {
    // The #722 shape: hundreds of KB per entry. Waiting for the count
    // ceiling would let the byte-capped ring evict them unpersisted.
    vi.useFakeTimers()
    const append = vi.fn().mockResolvedValue(undefined)
    install(append)
    let runtimes: Record<SessionId, SessionRuntime> = { s1: withEntries(emptyRuntime(), 1) }
    const refs = makeRefs(runtimes)
    const { rerender } = renderHook(({ r }) => useFeedDebugPersist(r, refs), { initialProps: { r: runtimes } })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(append).toHaveBeenCalledTimes(1)

    const big = { rows: 'x'.repeat(FEED_DEBUG_FLUSH_MAX_PENDING_BYTES / 2) }
    runtimes = { s1: withEntries(runtimes.s1!, 3, big) }
    refs.latestRuntimesRef.current = runtimes
    rerender({ r: runtimes })
    expect(append).toHaveBeenCalledTimes(2)
    const forced = append.mock.calls[1]![0] as { entries: Array<{ id: number }> }
    expect(forced.entries).toHaveLength(3)
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

  it('paces entries that arrive while an append is in flight instead of draining on resolve', async () => {
    vi.useFakeTimers()
    let resolveFirst!: () => void
    const append = vi.fn()
      .mockImplementationOnce(() => new Promise<void>(resolve => { resolveFirst = resolve }))
      .mockResolvedValue(undefined)
    install(append)
    let runtimes: Record<SessionId, SessionRuntime> = { s1: withEntries(emptyRuntime(), 1) }
    const refs = makeRefs(runtimes)
    const { rerender } = renderHook(({ r }) => useFeedDebugPersist(r, refs), { initialProps: { r: runtimes } })
    expect(append).toHaveBeenCalledTimes(1)

    // Entries keep arriving while the first append is unresolved.
    for (let i = 0; i < 3; i += 1) {
      runtimes = { s1: withEntries(runtimes.s1!, 1) }
      refs.latestRuntimesRef.current = runtimes
      rerender({ r: runtimes })
    }
    await act(async () => {
      resolveFirst()
      await vi.advanceTimersByTimeAsync(100)
    })
    // Resolving must arm the timer, not drain immediately.
    expect(append).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(FEED_DEBUG_FLUSH_INTERVAL_MS) })
    expect(append).toHaveBeenCalledTimes(2)
    const paced = append.mock.calls[1]![0] as { entries: Array<{ id: number }> }
    expect(paced.entries.map(e => e.id)).toEqual([2, 3, 4])
  })

  it('flushes a removed session\'s trailing entries at once instead of losing them to the timer', async () => {
    // Session replacement / pane close delete the runtime while the pacing
    // timer is armed; the final entries (exit code, kill reason) must still
    // reach disk.
    vi.useFakeTimers()
    const append = vi.fn().mockResolvedValue(undefined)
    install(append)
    let runtimes: Record<SessionId, SessionRuntime> = { s1: withEntries(emptyRuntime(), 1) }
    const refs = makeRefs(runtimes)
    const { rerender } = renderHook(({ r }) => useFeedDebugPersist(r, refs), { initialProps: { r: runtimes } })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(append).toHaveBeenCalledTimes(1)

    runtimes = { s1: withEntries(runtimes.s1!, 2) }
    refs.latestRuntimesRef.current = runtimes
    rerender({ r: runtimes })
    expect(append).toHaveBeenCalledTimes(1)

    runtimes = {}
    refs.latestRuntimesRef.current = runtimes
    rerender({ r: runtimes })
    expect(append).toHaveBeenCalledTimes(2)
    const final = append.mock.calls[1]![0] as { entries: Array<{ id: number }> }
    expect(final.entries.map(e => e.id)).toEqual([2, 3])
    await act(async () => { await vi.advanceTimersByTimeAsync(FEED_DEBUG_FLUSH_INTERVAL_MS * 2) })
    expect(append).toHaveBeenCalledTimes(2)
  })

  it('flushes a removed session\'s trailing entries once its in-flight append resolves', async () => {
    vi.useFakeTimers()
    let resolveFirst!: () => void
    const append = vi.fn()
      .mockImplementationOnce(() => new Promise<void>(resolve => { resolveFirst = resolve }))
      .mockResolvedValue(undefined)
    install(append)
    let runtimes: Record<SessionId, SessionRuntime> = { s1: withEntries(emptyRuntime(), 1) }
    const refs = makeRefs(runtimes)
    const { rerender } = renderHook(({ r }) => useFeedDebugPersist(r, refs), { initialProps: { r: runtimes } })
    expect(append).toHaveBeenCalledTimes(1)

    runtimes = { s1: withEntries(runtimes.s1!, 1) }
    refs.latestRuntimesRef.current = runtimes
    rerender({ r: runtimes })
    runtimes = {}
    refs.latestRuntimesRef.current = runtimes
    rerender({ r: runtimes })
    expect(append).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveFirst()
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(append).toHaveBeenCalledTimes(2)
    const final = append.mock.calls[1]![0] as { entries: Array<{ id: number }> }
    expect(final.entries.map(e => e.id)).toEqual([2])
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

  it('paces a removed session\'s final-flush retries instead of spinning on a persistent rejection', async () => {
    // Review blocker: the rejection path re-invokes consider() with the
    // session gone from latestRuntimesRef, which re-enters the final
    // branch. Unpaced, a persistently failing append became one IPC round
    // trip + one console.warn per microtask — the retry storm this PR
    // exists to kill, resurrected on the removal path.
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const append = vi.fn()
      .mockResolvedValueOnce(undefined) // initial live batch (id 1)
      .mockRejectedValueOnce(new Error('disk full at close')) // final flush fails
      .mockRejectedValueOnce(new Error('disk full at close')) // paced retry fails too
      .mockResolvedValue(undefined)
    install(append)
    let runtimes: Record<SessionId, SessionRuntime> = { s1: withEntries(emptyRuntime(), 1) }
    const refs = makeRefs(runtimes)
    const { rerender } = renderHook(({ r }) => useFeedDebugPersist(r, refs), { initialProps: { r: runtimes } })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(append).toHaveBeenCalledTimes(1)

    runtimes = { s1: withEntries(runtimes.s1!, 2) }
    refs.latestRuntimesRef.current = runtimes
    rerender({ r: runtimes })
    runtimes = {}
    refs.latestRuntimesRef.current = runtimes
    rerender({ r: runtimes })
    // The FIRST final flush is immediate: removal is one append, not a stream.
    expect(append).toHaveBeenCalledTimes(2)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    // Rejection landed. No retry before the interval, however many microtasks run.
    expect(append).toHaveBeenCalledTimes(2)

    await act(async () => { await vi.advanceTimersByTimeAsync(FEED_DEBUG_FLUSH_INTERVAL_MS - 1) })
    expect(append).toHaveBeenCalledTimes(2)
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(append).toHaveBeenCalledTimes(3)

    // The paced retry also rejects; exactly one more after another interval,
    // then the success clears the cursors and stops the cycle.
    await act(async () => { await vi.advanceTimersByTimeAsync(FEED_DEBUG_FLUSH_INTERVAL_MS - 1) })
    expect(append).toHaveBeenCalledTimes(3)
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(append).toHaveBeenCalledTimes(4)
    expect(refs.persistedFeedDebugIdRef.current.s1).toBe(3)
    await act(async () => { await vi.advanceTimersByTimeAsync(FEED_DEBUG_FLUSH_INTERVAL_MS * 3) })
    expect(append).toHaveBeenCalledTimes(4)
  })

  it('recovers after a StrictMode-style double mount keeps the hook mounted', async () => {
    // The unmount-only effect runs its cleanup on React 18's dev
    // simulated unmount and MUST re-arm on the simulated remount, or
    // every later .then/.catch bails and pacing only recovers on a lucky
    // render. Render directly under StrictMode to exercise the same
    // effect → cleanup → effect sequence on one hook instance.
    vi.useFakeTimers()
    const append = vi.fn().mockResolvedValue(undefined)
    install(append)
    const runtimes: Record<SessionId, SessionRuntime> = { s1: withEntries(emptyRuntime(), 2) }
    const refs = makeRefs(runtimes)
    const { rerender } = renderHook(
      ({ r }) => useFeedDebugPersist(r, refs),
      { initialProps: { r: runtimes }, wrapper: StrictMode },
    )
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(append).toHaveBeenCalledTimes(1)
    // The resolve path after the simulated remount must still advance the
    // durable cursor; with a stuck unmountedRef it never would.
    expect(refs.persistedFeedDebugIdRef.current.s1).toBe(2)
  })
})
