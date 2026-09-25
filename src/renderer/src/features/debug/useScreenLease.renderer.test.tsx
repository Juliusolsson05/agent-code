import { renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { useScreenLease } from './useScreenLease'

// #762: a debug surface receives screen frames only while it holds a lease.
// A lease that is never released keeps the 93%-of-IPC-bytes stream flowing
// for that session; one released early blanks the panel.
afterEach(() => { Reflect.deleteProperty(window, 'api') })

it('holds one lease per mounted session and moves it when the session changes', () => {
  const acquireScreenLease = vi.fn(async () => {})
  const releaseScreenLease = vi.fn(async () => {})
  Object.defineProperty(window, 'api', { configurable: true, value: { acquireScreenLease, releaseScreenLease } })

  const { rerender, unmount } = renderHook(({ id }: { id: string | null }) => useScreenLease(id), { initialProps: { id: 'a' as string | null } })
  expect(acquireScreenLease.mock.calls).toEqual([['a']])

  rerender({ id: 'b' })
  expect(releaseScreenLease.mock.calls).toEqual([['a']])
  expect(acquireScreenLease.mock.calls).toEqual([['a'], ['b']])

  rerender({ id: null })
  unmount()
  expect(releaseScreenLease.mock.calls).toEqual([['a'], ['b']])
  expect(acquireScreenLease).toHaveBeenCalledTimes(2)
})
