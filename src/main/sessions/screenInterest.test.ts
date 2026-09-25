import { describe, expect, it } from 'vitest'

import { ScreenInterest } from './screenInterest.js'

// #762: screen frames leave main only while some renderer holds a lease. The
// failure this guards is a count that drifts: too low stops a debug panel's
// frames, too high forwards the 93%-of-IPC-bytes stream again forever.
describe('ScreenInterest', () => {
  it('wants a session while any lease on it is held, across owners', () => {
    const interest = new ScreenInterest()
    interest.acquire(1, 's')
    interest.acquire(2, 's')
    interest.release(1, 's')
    expect(interest.wants('s')).toBe(true)
    interest.release(2, 's')
    expect(interest.wants('s')).toBe(false)
  })

  it('ignores a release its owner does not hold, so it cannot cancel another owner', () => {
    const interest = new ScreenInterest()
    interest.acquire(1, 's')
    interest.release(2, 's')
    interest.release(1, 's')
    interest.release(1, 's')
    expect(interest.wants('s')).toBe(false)
    interest.acquire(2, 's')
    interest.release(1, 's')
    expect(interest.wants('s')).toBe(true)
  })

  it('drops everything an owner held when it goes away, and only that', () => {
    // A renderer that reloads or crashes never releases; main drops its
    // leases instead (ipc/session.ts), and another window's must survive.
    const interest = new ScreenInterest()
    interest.acquire(1, 'a')
    interest.acquire(1, 'a')
    interest.acquire(1, 'b')
    interest.acquire(2, 'b')
    interest.dropOwner(1)
    expect(interest.wants('a')).toBe(false)
    expect(interest.wants('b')).toBe(true)
    interest.dropOwner(1)
    expect(interest.wants('b')).toBe(true)
  })
})
