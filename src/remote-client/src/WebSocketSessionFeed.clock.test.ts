import { afterEach, describe, expect, it, vi } from 'vitest'

import { WebSocketSessionFeed } from './WebSocketSessionFeed'
import type { WebSocketLike } from './WebSocketSessionFeed'

// Two clocks, one sort key (#1055 review).
//
// The server stamps when it last SAW activity; the phone stamps when it last
// RECEIVED a frame. Keeping whichever is newer is what stops a projection
// refresh from moving rows backwards — but across INDEPENDENT clocks that
// rule has no way back: a phone that was an hour fast when a session emitted
// would keep that row pinned above genuinely newer ones, reading "now", long
// after its clock was corrected. A stamp in the future is a clock artefact,
// and retiring it is the recovery path.

function mount(): { feed: WebSocketSessionFeed; deliver: (frame: unknown) => void } {
  let onMessage: ((event: { data: unknown }) => void) | null = null
  const socket: WebSocketLike = {
    readyState: 1,
    send: () => {},
    close: () => {},
    addEventListener: ((type: string, cb: unknown) => {
      if (type === 'message') onMessage = cb as (event: { data: unknown }) => void
      if (type === 'open') (cb as () => void)()
    }) as WebSocketLike['addEventListener'],
  }
  const feed = new WebSocketSessionFeed({ url: 'ws://127.0.0.1:1/ws', token: 't', createSocket: () => socket })
  return { feed, deliver: frame => onMessage?.({ data: JSON.stringify(frame) }) }
}

const list = (lastActivityAt: number, serverNow?: number) => ({
  type: 'session-list',
  sessions: [{ sessionId: 's1', kind: 'claude', cwd: '/repo', alive: true, lastActivityAt }],
  ...(serverNow === undefined ? {} : { serverNow }),
})

afterEach(() => vi.useRealTimers())

describe('recency across two clocks', () => {
  it('stops claiming a converted list when it reconnects to an older desktop', () => {
    // A rollback at the same endpoint: the next list carries no `serverNow`,
    // so nothing is converted and the display must take its wider tolerance
    // back. A latched flag kept promising conversion that was no longer
    // happening (#1055 review).
    const { feed, deliver } = mount()
    const stamp = Date.parse('2026-09-20T04:00:00.000Z')
    deliver(list(stamp, stamp))
    expect(feed.serverClockKnown()).toBe(true)
    deliver(list(stamp))
    expect(feed.serverClockKnown()).toBe(false)
  })

  it('converts a server frame into this device\'s time base', () => {
    // The server stamps with ITS clock and this client stamps local bumps
    // with the phone's, and the list sorts the mixture. Two devices two
    // minutes apart made a just-finished turn sort below one from three
    // minutes earlier (#1055 review). The frame carries the sender's `now`,
    // so the whole thing is converted on arrival.
    const { feed, deliver } = mount()
    vi.useFakeTimers()
    const phoneNow = Date.parse('2026-09-20T04:00:00.000Z')
    vi.setSystemTime(phoneNow)

    // The desktop is two minutes ahead and reports work it finished a second
    // ago: a raw stamp of phoneNow + 119s.
    deliver(list(phoneNow + 120_000 - 1_000, phoneNow + 120_000))
    expect(feed.getSessionList()[0]?.lastActivityAt).toBe(phoneNow - 1_000)
  })


  it('retires an inflated stamp on the next EVENT, with no list publication', () => {
    // The server only re-lists on a workspace change, which may never come.
    // Recovery cannot depend on it: a corrected clock must be able to fix the
    // ordering from ordinary traffic (#1055 review).
    const { feed, deliver } = mount()
    vi.useFakeTimers()
    const serverStamp = Date.parse('2026-09-20T04:00:00.000Z')

    vi.setSystemTime(serverStamp + 3_600_000)
    deliver(list(serverStamp))
    deliver({ type: 'session-event', channel: 'screen', payload: { sessionId: 's1', plain: 'working' } })
    const inflated = feed.getSessionList()[0]?.lastActivityAt ?? 0
    expect(inflated).toBeGreaterThan(serverStamp + 3_000_000)

    vi.setSystemTime(serverStamp + 60_000)
    deliver({ type: 'session-event', channel: 'screen', payload: { sessionId: 's1', plain: 'still working' } })
    expect(feed.getSessionList()[0]?.lastActivityAt).toBe(serverStamp + 60_000)
  })


  it('keeps the client stamp while it is plausible, and retires it once the clock is corrected', () => {
    const { feed, deliver } = mount()
    vi.useFakeTimers()
    const serverStamp = Date.parse('2026-09-20T04:00:00.000Z')

    // The phone is an hour fast when the session emits.
    vi.setSystemTime(serverStamp + 3_600_000)
    deliver(list(serverStamp))
    deliver({ type: 'session-event', channel: 'screen', payload: { sessionId: 's1', plain: 'working' } })
    const inflated = feed.getSessionList()[0]?.lastActivityAt ?? 0
    expect(inflated).toBeGreaterThan(serverStamp)

    // Another list frame while the clock is still fast: the local stamp is the
    // newer one and the row must not move backwards.
    deliver(list(serverStamp))
    expect(feed.getSessionList()[0]?.lastActivityAt).toBe(inflated)

    // The clock is corrected. The inflated stamp is now in the future, so the
    // server's value takes over instead of pinning this row forever.
    vi.setSystemTime(serverStamp + 60_000)
    deliver(list(serverStamp))
    expect(feed.getSessionList()[0]?.lastActivityAt).toBe(serverStamp)
  })
})
