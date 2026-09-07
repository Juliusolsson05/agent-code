import { describe, expect, it, vi } from 'vitest'
import type { WebSocketSessionFeed } from '../WebSocketSessionFeed'
import type { HistoryChunkResult } from '../wire'
import { TranscriptStore } from './store'
import { estimateLiveEntriesBytes, MAX_LIVE_ENTRY_BYTES, TRIM_TO_LIVE_ENTRY_BYTES } from '@renderer/session-runtime/liveEntryWindow'

const FILE = '/synthetic/transcript.jsonl'
const EPOCH = Date.parse('2026-01-01T00:00:00Z')
const raw = (i: number, bytes = 0): Record<string, unknown> => ({
  type: 'assistant', uuid: `u-${i}`, timestamp: new Date(EPOCH + i).toISOString(),
  message: { role: 'assistant', content: [
    { type: 'text', text: bytes ? 'x'.repeat(bytes) : `synthetic ${i}` },
    { type: 'tool_use', id: `tool-${i}`, name: 'Read', input: { path: `/synthetic/${i}` } },
  ] },
})
const range = (start: number, end: number, bytes = 0) => Array.from({ length: end - start }, (_, i) => raw(start + i, bytes))
const page = (entries: Array<Record<string, unknown>>, hasMore = false, offsets?: number[]): HistoryChunkResult => ({ entries, file: FILE, hasMore, offsets })

function fixture(kind = 'claude') {
  const listeners = new Map<string, Set<(value: unknown) => void>>()
  let now = EPOCH
  const list = ['a', 'b', 'c'].map(sessionId => ({ sessionId, kind, alive: true, cwd: '/synthetic', lastActivityAt: 0 }))
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
  const store = new TranscriptStore(feed, () => now)
  const emit = (name: string, value: unknown) => { for (const cb of listeners.get(name) ?? []) cb(value) }
  return {
    store, list, getHistory, emit,
    advance: (ms: number) => { now += ms },
    live: (entries: Array<Record<string, unknown>>, sessionId = 'a') => emit('onSessionJsonlEntries', { sessionId, entries: entries.map(entry => ({ entry, file: FILE })) }),
    semantic: (event: unknown, sessionId = 'a') => emit('onSessionSemanticEvent', { sessionId, event }),
    view: async (sessionId = 'a') => { const unsub = store.subscribe(sessionId, () => {}); await store.loadInitialHistory(sessionId); return unsub },
  }
}
// Collection cardinalities establish retention, not browser heap usage. Inspect
// only identity sets; observable snapshots below check actual rendered bodies.
function bookkeeping(store: TranscriptStore, id = 'a') {
  return (Reflect.get(store, 'sessions') as Map<string, { seen: Set<string>; trimmed: Set<string>; liveMapper: unknown }>).get(id)!
}

describe('view-owned remote transcript retention', () => {
  it('retains no transcript bodies, indexes, identities or semantic state for several unviewed sessions', async () => {
    const f = fixture()
    try {
      // Port of #805: 4096 unique tool/text entries, 32 MiB logical ASCII text
      // per session. These are synthetic bodies, never private transcripts.
      for (const { sessionId } of f.list) {
        for (let start = 0; start < 4096; start += 128) f.live(range(start, start + 128, 8192), sessionId)
        f.semantic({ type: 'turn_started', turnId: 'unviewed' }, sessionId)
        f.semantic({ type: 'block_started', blockId: 'b', blockType: 'text', text: 'x'.repeat(8192) }, sessionId)
        const t = f.store.getSnapshot(sessionId)
        expect(t.entries).toHaveLength(0)
        expect(t.toolUseIndex.size).toBe(0)
        expect(t.toolResultIndex.size).toBe(0)
        expect(t.semanticTurn).toBeNull()
        expect(t.semanticHistory).toEqual([])
        expect(bookkeeping(f.store, sessionId).seen.size).toBe(0)
        expect(bookkeeping(f.store, sessionId).liveMapper).toBeNull()
      }
      await f.store.loadInitialHistory('a')
      expect(f.getHistory).not.toHaveBeenCalled()
    } finally { f.store.dispose() }
  })

  it('releases the last view, invalidates pending history and backfills on reselect while preserving status', async () => {
    const f = fixture()
    try {
      const leave = await f.view()
      const leaveSecond = f.store.subscribe('a', () => {})
      f.live(range(0, 20))
      f.semantic({ type: 'turn_started', turnId: 'old' })
      f.emit('onSessionProcessState', { sessionId: 'a', active: true, status: 'Working' })
      leave()
      expect(f.store.getSnapshot('a').entries).toHaveLength(20)
      leaveSecond()
      expect(f.store.getSnapshot('a').entries).toHaveLength(0)
      expect(f.store.getSnapshot('a').workingStatus).toBe('Working')
      expect(bookkeeping(f.store).seen.size).toBe(0)
      expect(bookkeeping(f.store).trimmed.size).toBe(0)
      expect(bookkeeping(f.store).liveMapper).toBeNull()

      let resolve!: (result: { ok: true; chunk: HistoryChunkResult }) => void
      f.getHistory.mockReturnValueOnce(new Promise(r => { resolve = r }))
      const pendingView = f.store.subscribe('a', () => {})
      const pending = f.store.loadInitialHistory('a')
      pendingView()
      resolve({ ok: true, chunk: page(range(0, 20)) })
      await pending
      expect(f.store.getSnapshot('a').entries).toHaveLength(0)
      f.getHistory.mockResolvedValueOnce({ ok: true, chunk: { ...page(range(200, 210), true), file: '/synthetic/rolled-while-unviewed.jsonl' } })
      await f.view()
      expect(f.store.getSnapshot('a').entries.map(e => e.uuid)).toEqual(range(200, 210).map(e => e.uuid))
      f.semantic({ type: 'block_started', turnId: 'old', blockId: 'suffix', blockType: 'text' })
      expect(f.store.getSnapshot('a').semanticTurn).toBeNull()
      f.semantic({ type: 'turn_started', turnId: 'new' })
      expect(f.store.getSnapshot('a').semanticTurn?.turnId).toBe('new')
      f.emit('onSessionList', [])
      expect((Reflect.get(f.store, 'sessions') as Map<string, unknown>).size).toBe(0)
    } finally { f.store.dispose() }
  })

  it('trims sustained live entries and indexes, rejects old replay, and restores trimmed history in order', async () => {
    const f = fixture()
    try {
      const leave = await f.view()
      f.live(range(0, 2100))
      let t = f.store.getSnapshot('a')
      expect(t.entries.map(e => e.uuid)).toEqual(range(600, 2100).map(e => e.uuid))
      expect(t.totalEntries).toBe(2100)
      expect(t.toolUseIndex.size).toBe(1500)
      expect(t.toolUseIndex.has('tool-0')).toBe(false)
      const version = t.toolIndexVersion
      f.live(range(0, 600))
      expect(f.store.getSnapshot('a').entries).toHaveLength(1500)
      expect(f.store.getSnapshot('a').totalEntries).toBe(2100)
      f.getHistory.mockResolvedValueOnce({ ok: true, chunk: page(range(400, 600), true) })
      await f.store.loadOlderHistory('a')
      expect(f.getHistory).toHaveBeenLastCalledWith('a', { beforeMarker: 'u-600', limit: 200 })
      t = f.store.getSnapshot('a')
      expect(t.entries.map(e => e.uuid)).toEqual(range(400, 2100).map(e => e.uuid))
      expect(t.toolUseIndex.has('tool-400')).toBe(true)
      expect(t.toolIndexVersion).toBeGreaterThan(version)
      expect(bookkeeping(f.store).trimmed.has('u-400')).toBe(false)
      // History the user just requested is protected from immediate eviction.
      f.live(range(2100, 2600))
      expect(f.store.getSnapshot('a').entries).toHaveLength(2200)
      f.advance(30_001)
      f.live(range(2600, 2601))
      t = f.store.getSnapshot('a')
      expect(t.entries.map(e => e.uuid)).toEqual(range(1101, 2601).map(e => e.uuid))
      expect(t.toolUseIndex.size).toBe(1500)
      leave()
      expect(bookkeeping(f.store).seen.size).toBe(0)
      expect(bookkeeping(f.store).trimmed.size).toBe(0)
    } finally { f.store.dispose() }
  })

  it('uses a byte budget even below the count trigger', async () => {
    const f = fixture()
    try {
      await f.view()
      f.live(range(0, 300, 128 * 1024))
      const t = f.store.getSnapshot('a')
      expect(300 * 128 * 1024).toBeGreaterThan(MAX_LIVE_ENTRY_BYTES)
      expect(t.entries.length).toBeLessThan(300)
      expect(estimateLiveEntriesBytes(t.entries)).toBeLessThanOrEqual(TRIM_TO_LIVE_ENTRY_BYTES)
      expect(t.toolUseIndex.size).toBe(t.entries.length)
      expect(t.hasOlderHistory).toBe(true)
    } finally { f.store.dispose() }
  })

  it('preserves cross-boundary tool pairs and the newest result when older history repeats a tool id', async () => {
    const f = fixture()
    const result = (i: number, text: string) => ({ type: 'user', uuid: `r-${i}`, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-100', content: text }] } })
    try {
      await f.view()
      f.live([...range(0, 2100), result(2100, 'latest')])
      const t = f.store.getSnapshot('a')
      expect(t.entries[0]?.uuid).toBe('u-100')
      expect(t.toolUseIndex.has('tool-100')).toBe(true)
      expect(t.toolResultIndex.get('tool-100')?.content).toBe('latest')
      f.getHistory.mockResolvedValueOnce({ ok: true, chunk: page([...range(0, 100), result(99, 'historical')]) })
      await f.store.loadOlderHistory('a')
      expect(f.store.getSnapshot('a').toolResultIndex.get('tool-100')?.content).toBe('latest')
    } finally { f.store.dispose() }
  })

  it('keeps committed owners while their semantic turn remains a paint input', async () => {
    const f = fixture()
    try {
      await f.view()
      f.semantic({ type: 'turn_started', turnId: 'owned' })
      const started = f.store.getSnapshot('a').semanticTurn!.startedAt
      const rows = range(0, 2100)
      for (let i = 100; i < rows.length; i++) rows[i].timestamp = new Date(started + i).toISOString()
      f.live(rows)
      expect(f.store.getSnapshot('a').entries[0]?.uuid).toBe('u-100')
      expect(f.store.getSnapshot('a').semanticTurn?.turnId).toBe('owned')
      f.semantic({ type: 'turn_completed', turnId: 'owned' })
      f.live([{ ...raw(2100), timestamp: new Date(started + 2100).toISOString() }])
      expect(f.store.getSnapshot('a').entries[0]?.uuid).toBe('u-100')
      expect(f.store.getSnapshot('a').semanticHistory.some(t => t.turnId === 'owned')).toBe(true)
    } finally { f.store.dispose() }
  })

  it('carries exact history offsets through a trim and older pagination', async () => {
    const f = fixture()
    try {
      f.getHistory.mockResolvedValueOnce({ ok: true, chunk: page(range(0, 2000), true, Array.from({ length: 2000 }, (_, i) => 100 + i * 80)) })
      await f.view()
      f.live(range(2000, 2100))
      expect(f.store.getSnapshot('a').entries[0]?.uuid).toBe('u-600')
      f.getHistory.mockResolvedValueOnce({ ok: true, chunk: page(range(400, 600), true, Array.from({ length: 200 }, (_, i) => 100 + (i + 400) * 80)) })
      await f.store.loadOlderHistory('a')
      expect(f.getHistory).toHaveBeenLastCalledWith('a', { beforeMarker: 'u-600', beforeOffset: 48100, limit: 200 })
      f.getHistory.mockResolvedValueOnce({ ok: true, chunk: page(range(200, 400)) })
      await f.store.loadOlderHistory('a')
      expect(f.getHistory).toHaveBeenLastCalledWith('a', { beforeMarker: 'u-400', beforeOffset: 32100, limit: 200 })
      expect(f.store.getSnapshot('a').entries.map(e => e.uuid)).toEqual(range(200, 2100).map(e => e.uuid))
    } finally { f.store.dispose() }
  })
  it('advances an all-duplicate history page by its exact offset rather than repeating an ambiguous marker', async () => {
    const f = fixture()
    try {
      f.getHistory.mockResolvedValueOnce({ ok: true, chunk: page([raw(9)], true, [900]) })
      await f.view()
      f.getHistory.mockResolvedValueOnce({ ok: true, chunk: page([raw(9)], true, [500]) })
      await f.store.loadOlderHistory('a')
      f.getHistory.mockResolvedValueOnce({ ok: true, chunk: page(range(0, 9), false) })
      await f.store.loadOlderHistory('a')
      expect(f.getHistory).toHaveBeenLastCalledWith('a', { beforeMarker: 'u-9', beforeOffset: 500, limit: 200 })
      expect(f.store.getSnapshot('a').entries.map(e => e.uuid)).toEqual(range(0, 10).map(e => e.uuid))
      expect(f.store.getSnapshot('a').hasOlderHistory).toBe(false)
    } finally { f.store.dispose() }
  })

  it('preserves OpenCode raw-record fan-out, cursor and tool ownership across trim and reload', async () => {
    const f = fixture('opencode')
    const message = (i: number) => ({
      info: { role: 'assistant', id: `m-${i}`, time: { created: EPOCH + i, completed: EPOCH + i + 1 } },
      parts: [{ type: 'tool', callID: `call-${i}`, tool: 'Read', state: { status: 'completed', input: { path: '/synthetic' }, output: `result ${i}` } }],
    })
    try {
      await f.view()
      f.live(Array.from({ length: 1051 }, (_, i) => message(i)))
      const t = f.store.getSnapshot('a')
      expect(t.entries).toHaveLength(1500)
      expect(t.entries[0]?.uuid).toBe('m-301')
      expect(t.entries[1]?.uuid).toBe('m-301:result:call-301')
      expect(t.toolUseIndex.size).toBe(750)
      expect(t.toolResultIndex.size).toBe(750)
      expect(t.toolResultIndex.has('call-0')).toBe(false)
      f.getHistory.mockResolvedValueOnce({ ok: true, chunk: page([message(300)], true, [12345]) })
      await f.store.loadOlderHistory('a')
      expect(f.getHistory).toHaveBeenLastCalledWith('a', { beforeMarker: 'm-301', limit: 200 })
      expect(f.store.getSnapshot('a').entries.slice(0, 4).map(e => e.uuid)).toEqual(['m-300', 'm-300:result:call-300', 'm-301', 'm-301:result:call-301'])
    } finally { f.store.dispose() }
  })

  it('does not carry a Codex live mapper turn cursor through an unviewed interval', async () => {
    const f = fixture('codex')
    const codexMessage = (id: string) => ({ type: 'response_item', timestamp: new Date(EPOCH).toISOString(), payload: { type: 'message', id, role: 'assistant', content: [{ type: 'output_text', text: id }] } })
    try {
      const leave = await f.view()
      f.live([{ type: 'turn_context', payload: { turn_id: 'old-turn' } }, codexMessage('old')])
      const oldMapper = bookkeeping(f.store).liveMapper
      expect(oldMapper).not.toBeNull()
      leave()
      f.live([{ type: 'turn_context', payload: { turn_id: 'unviewed-turn' } }])
      expect(bookkeeping(f.store).liveMapper).toBeNull()
      await f.view()
      f.live([codexMessage('new')])
      expect(bookkeeping(f.store).liveMapper).not.toBe(oldMapper)
      expect((bookkeeping(f.store).liveMapper as { getTurnCursor(): string | null }).getTurnCursor()).toBeNull()
      expect(f.store.getSnapshot('a').entries).toHaveLength(1)
    } finally { f.store.dispose() }
  })

})
