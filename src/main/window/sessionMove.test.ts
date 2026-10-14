import { describe, expect, it } from 'vitest'

import { SESSION_MOVE_DEADLINE_MS, SessionMoveCoordinator } from '@main/window/sessionMove'
import type { SessionWindowLease } from '@main/window/sessionWindowRouter'

// The coordinator's job is routing AUTHORITY: who may start, settle and undo a
// move, and that an undo touches only the exact claims it made. These tests
// drive it against a small in-memory router with the same identity semantics
// as SessionWindowRouter (a lease is a fresh frozen object per claim/transfer,
// and "current" means identity with the owner map).

type Sent = { windowId: string; channel: string; payload: unknown }

function harness(options: { windows?: string[]; ready?: string[]; undeliverable?: string[] } = {}) {
  const windows = options.windows ?? ['A', 'B', 'C']
  const ready = new Set(options.ready ?? windows)
  const generations = new Map(windows.map(id => [id, 1]))
  const owners = new Map<string, SessionWindowLease>()
  let revision = 0
  const lease = (sessionId: string, windowId: string): SessionWindowLease =>
    Object.freeze({ sessionId, windowId, rendererGeneration: generations.get(windowId) ?? 0, revision: ++revision })
  const sent: Sent[] = []
  const gaps: string[] = []
  const timers = new Map<number, () => void>()
  let nextTimer = 1
  let nextId = 1
  const coordinator = new SessionMoveCoordinator({
    ownerOf: id => owners.get(id) ?? null,
    claim: (id, windowId) => {
      const old = owners.get(id)
      if (old && old.windowId !== windowId && generations.has(old.windowId)) return null
      const made = lease(id, windowId)
      owners.set(id, made)
      return made
    },
    transfer: (id, windowId) => {
      if (!owners.has(id) || !generations.has(windowId)) return null
      const made = lease(id, windowId)
      owners.set(id, made)
      return made
    },
    markGap: id => { gaps.push(id) },
    release: made => {
      if (owners.get(made.sessionId) !== made) return false
      owners.delete(made.sessionId)
      return true
    },
    isWindowReady: id => ready.has(id) && generations.has(id),
    rendererGeneration: id => generations.get(id) ?? null,
    windowNumber: id => (generations.has(id) ? windows.indexOf(id) + 1 : null),
    send: (windowId, channel, payload) => {
      if (!generations.has(windowId) || options.undeliverable?.includes(windowId)) return false
      sent.push({ windowId, channel, payload })
      return true
    },
    setTimer: callback => {
      const handle = nextTimer++
      timers.set(handle, callback)
      return handle
    },
    clearTimer: handle => { timers.delete(handle as number) },
    newId: () => `move-${nextId++}`,
  })
  return {
    coordinator,
    owners,
    sent,
    gaps,
    own: (id: string, windowId: string) => owners.set(id, lease(id, windowId)),
    closeWindow: (id: string) => generations.delete(id),
    reloadWindow: (id: string) => generations.set(id, (generations.get(id) ?? 0) + 1),
    fireDeadline: () => {
      const pending = [...timers.values()]
      timers.clear()
      for (const callback of pending) callback()
    },
    channels: (windowId: string) => sent.filter(item => item.windowId === windowId).map(item => item.channel),
  }
}

const request = (sessionIds: string[], targetWindowId = 'B') => ({ targetWindowId, sessionIds, packet: '{"opaque":true}' })

describe('SessionMoveCoordinator', () => {
  it('moves routing to the target before offering, and drops nothing in the source until the target confirms', () => {
    const h = harness()
    h.own('agent', 'A')
    const started = h.coordinator.start('A', request(['agent', 'parked-child']))

    expect(started).toEqual({ ok: true, moveId: 'move-1', targetWindowNumber: 2 })
    // The owned session was transferred and the unowned (parked) one claimed,
    // both for B, so B receives everything emitted from here on and A cannot
    // wake the parked child mid-move.
    expect(h.owners.get('agent')?.windowId).toBe('B')
    expect(h.owners.get('parked-child')?.windowId).toBe('B')
    expect(h.sent).toEqual([{ windowId: 'B', channel: 'workspace:receive-sessions',
      payload: { moveId: 'move-1', sourceWindowId: 'A', sessionIds: ['agent', 'parked-child'], packet: '{"opaque":true}' } }])
    // The source has heard nothing yet: it must keep its rows until B's save.
    expect(h.channels('A')).toEqual([])

    h.coordinator.complete('B', 'move-1')
    expect(h.sent.at(-1)).toEqual({ windowId: 'A', channel: 'workspace:sessions-moved-out',
      payload: { moveId: 'move-1', sessionIds: ['agent', 'parked-child'], targetWindowNumber: 2 } })
    expect(h.coordinator.pendingCount()).toBe(0)
  })

  it.each([
    ['same window', 'A', [] as string[], 'same-window'],
    ['an unready target', 'C', [] as string[], 'target-unavailable'],
    ['a session another window shows', 'B', ['agent'], 'foreign-owner'],
  ])('refuses %s up front, moving no routing', (_label, target, foreign, reason) => {
    const h = harness({ ready: ['A', 'B'] })
    for (const id of foreign) h.own(id, 'C')
    h.own('mine', 'A')
    const result = h.coordinator.start('A', request(['mine', ...foreign], target))
    expect(result).toMatchObject({ ok: false, reason })
    expect(h.owners.get('mine')?.windowId).toBe('A')
    expect(h.sent).toEqual([])
  })

  it('refuses a second move of a session that is already moving', () => {
    const h = harness()
    h.own('agent', 'A')
    expect(h.coordinator.start('A', request(['agent'])).ok).toBe(true)
    // From the target's side too: B now owns it, and a re-send must not race
    // the first move's confirm and rollback.
    expect(h.coordinator.start('B', request(['agent'], 'C'))).toMatchObject({ ok: false, reason: 'already-moving' })
  })

  it('ignores a confirmation from any window but the target, or from a reloaded target renderer', () => {
    const h = harness()
    h.own('agent', 'A')
    h.coordinator.start('A', request(['agent']))

    h.coordinator.complete('C', 'move-1')
    h.coordinator.complete('A', 'move-1')
    // A reloaded renderer never saw the offer, so its "saved" proves nothing.
    h.reloadWindow('B')
    h.coordinator.complete('B', 'move-1')

    expect(h.channels('A')).toEqual([])
    expect(h.coordinator.pendingCount()).toBe(1)
  })

  it('on refusal, hands routing back to the source and releases what it claimed', () => {
    const h = harness()
    h.own('agent', 'A')
    h.coordinator.start('A', request(['agent', 'parked-child']))

    h.coordinator.refuse('B', 'move-1', 'This window already shows that agent.')

    expect(h.owners.get('agent')?.windowId).toBe('A')
    // The source must resync what the target received meanwhile.
    expect(h.gaps).toEqual(['agent'])
    // It was unowned before the move, so it is unowned again rather than
    // pinned to the source, which never claimed it.
    expect(h.owners.has('parked-child')).toBe(false)
    expect(h.sent.at(-1)).toEqual({ windowId: 'A', channel: 'workspace:session-move-failed',
      payload: { moveId: 'move-1', message: 'This window already shows that agent.' } })
  })

  it('rolls back only claims that are still its own', () => {
    const h = harness()
    h.own('agent', 'A')
    h.coordinator.start('A', request(['agent']))
    // Something newer claimed it meanwhile (here: a transfer to C, standing in
    // for a later handoff). The rollback must not undo that.
    h.own('agent', 'C')

    h.coordinator.refuse('B', 'move-1', 'refused')
    expect(h.owners.get('agent')?.windowId).toBe('C')
  })

  it('at the deadline, rolls back and tells BOTH windows, and a late confirmation is ignored', () => {
    const h = harness()
    h.own('agent', 'A')
    h.coordinator.start('A', request(['agent']))
    expect(SESSION_MOVE_DEADLINE_MS).toBeGreaterThan(1000)

    h.fireDeadline()

    expect(h.owners.get('agent')?.windowId).toBe('A')
    // B may be showing the merged rows without ever having saved them (a
    // read-only store); it must remove them or keep dead panes forever.
    expect(h.channels('B')).toEqual(['workspace:receive-sessions', 'workspace:session-move-cancelled'])
    expect(h.channels('A')).toEqual(['workspace:session-move-failed'])

    h.coordinator.complete('B', 'move-1')
    expect(h.channels('A')).toEqual(['workspace:session-move-failed'])
  })

  it('releases rather than transfers back when the source window is gone', () => {
    const h = harness()
    h.own('agent', 'A')
    h.coordinator.start('A', request(['agent']))
    h.closeWindow('A')

    h.coordinator.refuse('B', 'move-1', 'refused')
    expect(h.owners.has('agent')).toBe(false)
  })

  it('rejects malformed requests without touching routing', () => {
    const h = harness()
    h.own('agent', 'A')
    for (const bad of [
      { targetWindowId: 'B', sessionIds: [], packet: '' },
      { targetWindowId: 'B', sessionIds: [42 as unknown as string], packet: '' },
      { targetWindowId: '', sessionIds: ['agent'], packet: '' },
      { targetWindowId: 'B', sessionIds: ['agent'], packet: 7 as unknown as string },
    ]) {
      expect(h.coordinator.start('A', bad)).toMatchObject({ ok: false, reason: 'invalid-request' })
    }
    expect(h.owners.get('agent')?.windowId).toBe('A')
  })

  // #1481 review: the target shows the moved agent in its focused lane, and
  // waking a parked one there re-claims it (session:recover), rotating the
  // lease. If the move then expires, the target drops its rows, so routing
  // must not stay with it.
  it('also rolls back a claim the TARGET refreshed during the move', () => {
    const h = harness()
    h.coordinator.start('A', request(['parked']))
    h.own('parked', 'B')
    h.fireDeadline()
    expect(h.owners.has('parked')).toBe(false)

    const live = harness()
    live.own('agent', 'A')
    live.coordinator.start('A', request(['agent']))
    live.own('agent', 'B')
    live.fireDeadline()
    expect(live.owners.get('agent')?.windowId).toBe('A')
    expect(live.gaps).toEqual(['agent'])
  })

  it('rolls routing back when the offer cannot be delivered to the target', () => {
    const h = harness({ undeliverable: ['B'] })
    h.own('agent', 'A')
    expect(h.coordinator.start('A', request(['agent']))).toMatchObject({ ok: false, reason: 'target-unavailable' })
    expect(h.owners.get('agent')?.windowId).toBe('A')
    expect(h.coordinator.pendingCount()).toBe(0)
  })

  it('lets a moved agent move again once the first move has settled', () => {
    const h = harness()
    h.own('agent', 'A')
    h.coordinator.start('A', request(['agent']))
    h.coordinator.complete('B', 'move-1')
    // Back again: the first move must have released its in-flight marker.
    expect(h.coordinator.start('B', request(['agent'], 'A'))).toMatchObject({ ok: true })
    expect(h.owners.get('agent')?.windowId).toBe('A')
  })
})
