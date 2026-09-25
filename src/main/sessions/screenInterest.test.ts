import { describe, expect, it } from 'vitest'

import { ScreenInterest } from './screenInterest.js'

// #762: screen frames leave main only while some renderer holds a lease. The
// failure this guards is a count that drifts: too low stops a debug panel's
// frames, too high forwards the 93%-of-IPC-bytes stream again forever.
describe('ScreenInterest', () => {
  it('wants a session while any lease on it is held, across owners', () => {
    const interest = new ScreenInterest()
    interest.acquire(1, 's', 'doc')
    interest.acquire(2, 's', 'doc')
    interest.release(1, 's', 'doc')
    expect(interest.wants('s')).toBe(true)
    interest.release(2, 's', 'doc')
    expect(interest.wants('s')).toBe(false)
  })

  it('ignores a release its owner does not hold, so it cannot cancel another owner', () => {
    const interest = new ScreenInterest()
    interest.acquire(1, 's', 'doc')
    interest.release(2, 's', 'doc')
    interest.release(1, 's', 'doc')
    interest.release(1, 's', 'doc')
    expect(interest.wants('s')).toBe(false)
    interest.acquire(2, 's', 'doc')
    interest.release(1, 's', 'doc')
    expect(interest.wants('s')).toBe(true)
  })

  it('never lets a release for a session the owner does not hold cancel another owner', () => {
    // Owner 1 holds 'a' only. Its release of 'b' must not go negative on its
    // own books and take owner 2's 'b' lease with it.
    const interest = new ScreenInterest()
    interest.acquire(1, 'a', 'doc')
    interest.acquire(2, 'b', 'doc')
    interest.release(1, 'b', 'doc')
    expect(interest.wants('b')).toBe(true)
    expect(interest.wants('a')).toBe(true)
  })

  it('drops a webContents\' leases when a new document takes one, and only then', () => {
    // A reload never runs the old page's cleanup; the new page's first lease
    // proves the old document is gone. A blocked navigation keeps the page and
    // its document id, so nothing is dropped (#1236 review).
    const interest = new ScreenInterest()
    interest.acquire(1, 'old-only', 'first-load')
    interest.acquire(1, 'shared', 'first-load')
    interest.acquire(1, 'shared', 'reloaded')
    expect(interest.wants('old-only')).toBe(false)
    expect(interest.wants('shared')).toBe(true)
    // The dead document's late release cannot touch the new one's lease.
    interest.release(1, 'shared', 'first-load')
    expect(interest.wants('shared')).toBe(true)
    interest.release(1, 'shared', 'reloaded')
    expect(interest.wants('shared')).toBe(false)
  })

  it('drops everything an owner held when it goes away, and only that', () => {
    // A renderer that reloads or crashes never releases; main drops its
    // leases instead (ipc/session.ts), and another window's must survive.
    const interest = new ScreenInterest()
    interest.acquire(1, 'a', 'doc')
    interest.acquire(1, 'a', 'doc')
    interest.acquire(1, 'b', 'doc')
    interest.acquire(2, 'b', 'doc')
    interest.dropOwner(1)
    expect(interest.wants('a')).toBe(false)
    expect(interest.wants('b')).toBe(true)
    interest.dropOwner(1)
    expect(interest.wants('b')).toBe(true)
  })
})
