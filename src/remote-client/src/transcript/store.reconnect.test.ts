import { describe, expect, it, vi } from 'vitest'
import type { WebSocketSessionFeed } from '../WebSocketSessionFeed'
import type { HistoryChunkResult } from '../wire'
import { TranscriptStore } from './store'
import { REMOTE_HISTORY_TOO_LARGE } from '@shared/remoteOutputLimits'

// The real store/mapper/reducers consume a synthetic transport. Tests control
// response ordering directly so old-history-versus-reconnect races don't depend
// on kernel scheduling or on a running provider.
function fixture() {
  const listeners = new Map<string, Set<(value: unknown) => void>>()
  const list = [{ sessionId: 's', kind: 'claude', alive: true, cwd: '/synthetic', lastActivityAt: 0 }]
  const getHistory = vi.fn<(...args: unknown[]) => Promise<{ ok: true; chunk: HistoryChunkResult } | { ok: false; error: string }>>()
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
  getHistory.mockResolvedValue({ ok: false, error: 'No transcript yet' })
  const store = new TranscriptStore(feed)
  return { store, getHistory, list, emit: (name: string, value: unknown) => { for (const cb of listeners.get(name) ?? []) cb(value) } }
}
const entry = (i: number) => ({ type: 'user', uuid: `u-${i}`, message: { role: 'user', content: `synthetic-${i}` } })
const chunk = (start: number, end: number, hasMore = false): HistoryChunkResult => ({
  entries: Array.from({ length: end - start }, (_, i) => entry(start + i)),
  file: '/synthetic/transcript.jsonl', hasMore, totalEntries: end,
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}

describe('remote transcript reconnect recovery', () => {
  it('replaces a disconnected window, backfills a previously loaded view and pages across a gap larger than one page', async () => {
    const f = fixture()
    const unsub = f.store.subscribe('s', () => {})
    try {
      f.getHistory.mockResolvedValueOnce({ ok: true, chunk: chunk(0, 10) })
      await f.store.loadInitialHistory('s')
      f.emit('onConnectionState', 'closed')
      expect(f.store.getSnapshot('s').entries).toEqual([])
      f.getHistory.mockResolvedValueOnce({ ok: true, chunk: chunk(190, 310, true) })
      f.emit('onSessionList', f.list)
      await vi.waitFor(() => expect(f.store.getSnapshot('s').entries).toHaveLength(120))
      expect(f.store.getSnapshot('s').entries[0]?.uuid).toBe('u-190')
      // No stale prefix joined across the missing 180 records. The entire
      // durable range is reachable through normal older-history pagination.
      f.getHistory.mockResolvedValueOnce({ ok: true, chunk: chunk(0, 190) })
      await f.store.loadOlderHistory('s')
      expect(f.getHistory).toHaveBeenLastCalledWith('s', { beforeMarker: 'u-190', limit: 200 })
      expect(f.store.getSnapshot('s').entries.map(e => e.uuid)).toEqual(Array.from({ length: 310 }, (_, i) => `u-${i}`))
    } finally { unsub(); f.store.dispose() }
  })

  it('ignores an in-flight old history reply after disconnect, even for the same file', async () => {
    const f = fixture()
    f.store.subscribe('s', () => {})
    const old = deferred<{ ok: true; chunk: HistoryChunkResult }>()
    try {
      f.getHistory.mockReturnValueOnce(old.promise)
      const loading = f.store.loadInitialHistory('s')
      f.emit('onConnectionState', 'closed')
      f.getHistory.mockResolvedValueOnce({ ok: true, chunk: chunk(200, 210) })
      await f.store.loadInitialHistory('s')
      old.resolve({ ok: true, chunk: chunk(0, 10) })
      await loading
      expect(f.store.getSnapshot('s').entries.map(e => e.uuid)).toEqual(Array.from({ length: 10 }, (_, i) => `u-${200 + i}`))
    } finally { f.store.dispose() }
  })

  it('uses committed content after reconnect until a complete new semantic turn starts', () => {
    const f = fixture()
    try {
      f.store.subscribe('s', () => {})
      f.store.getSnapshot('s')
      f.emit('onConnectionState', 'closed')
      f.emit('onSessionSemanticEvent', { sessionId: 's', event: { type: 'block_started', source: 'proxy', turnId: 'lost-prefix', blockId: 'b', blockType: 'text' } })
      expect(f.store.getSnapshot('s').semanticTurn).toBeNull()
      f.emit('onSessionJsonlEntries', { sessionId: 's', entries: [{ entry: entry(1), file: '/synthetic/transcript.jsonl' }] })
      expect(f.store.getSnapshot('s').entries).toHaveLength(1)
      f.emit('onSessionSemanticEvent', { sessionId: 's', event: { type: 'turn_started', turnId: 'new-turn' } })
      expect(f.store.getSnapshot('s').semanticTurn?.turnId).toBe('new-turn')
    } finally { f.store.dispose() }
  })

  it('does not retry an oversized history record on every subsequent activity event', async () => {
    const f = fixture()
    const unsub = f.store.subscribe('s', () => {})
    try {
      f.getHistory.mockResolvedValue({ ok: false, error: REMOTE_HISTORY_TOO_LARGE })
      await f.store.loadInitialHistory('s')
      for (let i = 0; i < 50; i++) f.emit('onSessionList', f.list)
      expect(f.getHistory).toHaveBeenCalledTimes(1)
      expect(f.store.getSnapshot('s').historyError).toBe(REMOTE_HISTORY_TOO_LARGE)
    } finally { unsub(); f.store.dispose() }
  })

  it('does not re-backfill a view that unsubscribed before reconnect', async () => {
    const f = fixture()
    const unsub = f.store.subscribe('s', () => {})
    f.store.getSnapshot('s')
    unsub()
    f.emit('onConnectionState', 'closed')
    f.emit('onSessionList', f.list)
    expect(f.getHistory).not.toHaveBeenCalled()
    f.store.dispose()
  })
})
