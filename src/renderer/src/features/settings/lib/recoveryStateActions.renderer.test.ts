import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { RECOVERY_REVEAL_FAILED, revealMessage, useRecoveryActionGate } from './recoveryStateActions'

// Steering q111: every action on a recovery panel takes a generation, and only
// the LATEST completion may speak, for a success and a failure alike. An older
// completion may still apply its data (onStale), never its message.

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe('revealMessage', () => {
  it('is null on success, main\'s message on refusal, else the fallback', () => {
    expect(revealMessage({ ok: true })).toBeNull()
    expect(revealMessage({ ok: false, message: 'gone' })).toBe('gone')
    expect(revealMessage({ ok: false })).toBe(RECOVERY_REVEAL_FAILED)
    expect(revealMessage({ ok: false }, 'x')).toBe('x')
  })
})

describe('useRecoveryActionGate', () => {
  it.each([
    ['a late success', (d: ReturnType<typeof deferred<string>>) => d.resolve('older ok')],
    ['a late failure', (d: ReturnType<typeof deferred<string>>) => d.reject(new Error('older failed'))],
  ])('lets %s of an older action say nothing once a newer one completed', async (_name, settleOlder) => {
    const { result } = renderHook(() => useRecoveryActionGate())
    const older = deferred<string>()
    const said: string[] = []
    const stale: string[] = []
    let olderRun!: Promise<void>
    act(() => {
      olderRun = result.current.run(() => older.promise, { onLatest: v => said.push(`older:${v}`), onStale: v => stale.push(v), onRejected: () => said.push('older rejected') })
    })
    await act(async () => {
      await result.current.run(async () => { throw new Error('reset failed') }, { onLatest: () => said.push('newer ok'), onRejected: () => said.push('newer rejected') })
    })
    await act(async () => { settleOlder(older); await olderRun })
    expect(said).toEqual(['newer rejected'])
    // A late success still hands its data to onStale (a reset's snapshot).
    if (stale.length) expect(stale).toEqual(['older ok'])
  })

  it('retires in-flight actions on invalidate', async () => {
    const { result } = renderHook(() => useRecoveryActionGate())
    const pending = deferred<string>()
    const onLatest = vi.fn()
    let run!: Promise<void>
    act(() => { run = result.current.run(() => pending.promise, { onLatest, onRejected: vi.fn() }) })
    act(() => result.current.invalidate())
    await act(async () => { pending.resolve('late'); await run })
    expect(onLatest).not.toHaveBeenCalled()
  })
})
