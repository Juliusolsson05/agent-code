import { describe, expect, it, vi } from 'vitest'
import type { WebSocketSessionFeed } from '../WebSocketSessionFeed'
import type { HistoryChunkResult } from '../wire'
import { TranscriptStore } from './store'

// The race behind #847, replayed deterministically. Over a real socket the
// handshake `session-list` is computed before a just-started session exists,
// and whether the client parses it before or after a view subscribes depends
// on TCP chunking. These tests pin the order that used to lose the view.
const FILE = '/synthetic/transcript.jsonl'
const raw = (i: number): Record<string, unknown> => ({
  type: 'user', uuid: `u-${i}`, timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
  message: { role: 'user', content: `synthetic ${i}` },
})
const page = (entries: Array<Record<string, unknown>>): HistoryChunkResult => ({ entries, file: FILE, hasMore: false })
const summary = (sessionId: string) => ({ sessionId, kind: 'claude', alive: true, cwd: '/synthetic', lastActivityAt: 0 })

function fixture() {
  const listeners = new Map<string, Set<(value: unknown) => void>>()
  let list: Array<ReturnType<typeof summary>> = []
  const getHistory = vi.fn<(...args: unknown[]) => Promise<{ ok: true; chunk: HistoryChunkResult } | { ok: false; error: string }>>()
    .mockResolvedValue({ ok: true, chunk: page([]) })
  const methods = { getHistory, getSessionList: () => list }
  const feed = new Proxy(methods, {
    get(target, key: string) {
      if (key in target) return target[key as keyof typeof target]
      return (cb: (value: unknown) => void) => {
        let set = listeners.get(key)
        if (!set) listeners.set(key, set = new Set())
        set.add(cb)
        return () => set.delete(cb)
      }
    },
  }) as unknown as WebSocketSessionFeed
  const store = new TranscriptStore(feed)
  const emit = (name: string, value: unknown) => { for (const cb of listeners.get(name) ?? []) cb(value) }
  return {
    store, getHistory,
    sessionList: (ids: string[]) => { list = ids.map(summary); emit('onSessionList', list) },
    live: (sessionId: string, entries: Array<Record<string, unknown>>) =>
      emit('onSessionJsonlEntries', { sessionId, entries: entries.map(entry => ({ entry, file: FILE })) }),
    states: () => Reflect.get(store, 'sessions') as Map<string, unknown>,
  }
}

describe('session-list frames against a mounted view (#847)', () => {
  it('keeps a subscribed session across an early empty list and backfills on the started patch', async () => {
    const f = fixture()
    f.getHistory.mockResolvedValue({ ok: true, chunk: page([raw(0), raw(1), raw(2)]) })
    const unsub = f.store.subscribe('s1', () => {})
    // The view reads its first snapshot before the handshake list lands, as
    // useSyncExternalStore does on mount and as the integration test does
    // through vi.waitFor.
    expect(f.store.getSnapshot('s1').entries).toEqual([])

    f.sessionList([])
    f.sessionList(['s1'])

    // Pre-fix: the empty list deleted the state AND the listener set, so the
    // started patch found nothing to backfill and getHistory was never called.
    await vi.waitFor(() => expect(f.getHistory).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(f.store.getSnapshot('s1').entries.map(e => e.uuid)).toEqual(['u-0', 'u-1', 'u-2']))
    unsub()
  })

  it('still delivers live entries to a view that an early list did not know about', () => {
    const f = fixture()
    const unsub = f.store.subscribe('s1', () => {})
    f.store.getSnapshot('s1')
    f.sessionList([])

    // Pre-fix: with the listener set gone the session counted as unviewed and
    // the entry was dropped, which is the `expected [] to equal ['u-live']`
    // signature on the issue.
    f.live('s1', [{ type: 'user', uuid: 'u-live', message: { role: 'user', content: 'do the thing' } }])
    expect(f.store.getSnapshot('s1').entries.map(e => e.uuid)).toEqual(['u-live'])
    unsub()
  })

  it('backfills a view that subscribed before the session existed anywhere', async () => {
    const f = fixture()
    f.getHistory.mockResolvedValue({ ok: true, chunk: page([raw(0)]) })
    const unsub = f.store.subscribe('s1', () => {})
    // No getSnapshot call, so no state exists when the list names the session.
    f.sessionList(['s1'])
    await vi.waitFor(() => expect(f.getHistory).toHaveBeenCalledWith('s1', expect.anything()))
    await vi.waitFor(() => expect(f.store.getSnapshot('s1').entries.map(e => e.uuid)).toEqual(['u-0']))
    unsub()
  })

  it('still evicts unviewed sessions the list no longer contains', () => {
    const f = fixture()
    f.sessionList(['gone', 'kept'])
    f.store.getSnapshot('gone')
    const unsub = f.store.subscribe('kept', () => {})
    f.store.getSnapshot('kept')
    expect(f.states().has('gone')).toBe(true)

    f.sessionList([])
    // The #805 retention guarantee: an unviewed session holds nothing once the
    // manager forgets it. A mounted view keeps its snapshot until it leaves.
    expect(f.states().has('gone')).toBe(false)
    expect(f.states().has('kept')).toBe(true)
    unsub()
    expect(f.store.getSnapshot('kept').entries).toEqual([])
  })
})
