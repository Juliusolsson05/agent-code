import { describe, expect, it, vi } from 'vitest'

import { createSessionDataDispatcher } from './sessionDataDispatcher'

describe('sessionDataDispatcher', () => {
  it('keeps duplicate callback registrations independently owned', () => {
    let emit!: (event: { sessionId: string; data: string }) => void
    const dispatcher = createSessionDataDispatcher(handler => {
      emit = handler
      return () => {}
    })
    const handler = vi.fn()
    const unsubscribe = dispatcher.subscribe('shared', handler)
    dispatcher.subscribe('shared', handler)
    unsubscribe()
    emit({ sessionId: 'shared', data: 'still owned' })
    expect(handler).toHaveBeenCalledExactlyOnceWith('still owned')
    dispatcher.dispose()
  })

  it('does not resurrect a failed registration when channel setup is retried', () => {
    let emit!: (event: { sessionId: string; data: string }) => void
    let fail = true
    const dispatcher = createSessionDataDispatcher(handler => {
      if (fail) throw new Error('preload unavailable')
      emit = handler
      return () => {}
    })
    const stale = vi.fn()
    expect(() => dispatcher.subscribe('session', stale)).toThrow('preload unavailable')
    fail = false
    const current = vi.fn()
    dispatcher.subscribe('session', current)
    emit({ sessionId: 'session', data: 'retried' })
    expect(stale).not.toHaveBeenCalled()
    expect(current).toHaveBeenCalledExactlyOnceWith('retried')
    dispatcher.dispose()
  })

  it('uses one channel subscription and invokes only handlers for the owning session', () => {
    let emit: ((event: { sessionId: string; data: string }) => void) | null = null
    const stop = vi.fn()
    const subscribeToChannel = vi.fn(handler => {
      emit = handler
      return stop
    })
    const dispatcher = createSessionDataDispatcher(subscribeToChannel)
    const first = vi.fn()
    const second = vi.fn()

    dispatcher.subscribe('first', first)
    dispatcher.subscribe('second', second)

    expect(subscribeToChannel).toHaveBeenCalledTimes(1)
    emit!({ sessionId: 'second', data: 'owned bytes' })
    emit!({ sessionId: 'missing', data: 'discarded before host code' })
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledOnce()
    expect(second).toHaveBeenCalledWith('owned bytes')
    expect(stop).not.toHaveBeenCalled()
  })

  it('drops host closures on unsubscribe without churning the global listener', () => {
    let emit: ((event: { sessionId: string; data: string }) => void) | null = null
    const stop = vi.fn()
    const subscribeToChannel = vi.fn(handler => {
      emit = handler
      return stop
    })
    const dispatcher = createSessionDataDispatcher(subscribeToChannel)
    const stale = vi.fn()
    const unsubscribe = dispatcher.subscribe('session', stale)

    unsubscribe()
    unsubscribe()
    emit!({ sessionId: 'session', data: 'after unmount' })
    expect(stale).not.toHaveBeenCalled()
    expect(stop).not.toHaveBeenCalled()

    const remounted = vi.fn()
    dispatcher.subscribe('session', remounted)
    emit!({ sessionId: 'session', data: 'after remount' })
    expect(subscribeToChannel).toHaveBeenCalledTimes(1)
    expect(remounted).toHaveBeenCalledWith('after remount')

    dispatcher.dispose()
    dispatcher.dispose()
    expect(stop).toHaveBeenCalledTimes(1)
    expect(() => dispatcher.subscribe('late', vi.fn())).toThrow(/disposed/)
  })

  it('uses a stable callback snapshot when one consumer unmounts another', () => {
    let emit: ((event: { sessionId: string; data: string }) => void) | null = null
    const dispatcher = createSessionDataDispatcher(handler => {
      emit = handler
      return () => {}
    })
    const second = vi.fn()
    let unsubscribeSecond = () => {}
    const first = vi.fn(() => unsubscribeSecond())
    dispatcher.subscribe('shared', first)
    unsubscribeSecond = dispatcher.subscribe('shared', second)

    emit!({ sessionId: 'shared', data: 'current chunk' })
    emit!({ sessionId: 'shared', data: 'next chunk' })

    expect(first).toHaveBeenCalledTimes(2)
    expect(second).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledWith('current chunk')
  })
})
