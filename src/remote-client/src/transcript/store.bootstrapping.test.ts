import { describe, expect, it, vi } from 'vitest'
import type { WebSocketSessionFeed } from '../WebSocketSessionFeed'
import type { HistoryChunkResult } from '../wire'
import { TranscriptStore } from './store'

// Bootstrapping lifecycle: the flag exists so Feed can suspend per-append
// auto-scroll and the lazy-mount cascade during the INITIAL backfill burst
// (the same contract the desktop's resume path has). These tests pin the
// lifecycle: set when the initial request starts, cleared on EVERY settle
// path (success, benign failure, hard failure), and never set by
// older-page pagination — interactive paging preserves scroll position
// itself and must not look like a replay burst.

const FILE = '/synthetic/transcript.jsonl'
const EPOCH = Date.parse('2026-01-01T00:00:00Z')
const raw = (i: number): Record<string, unknown> => ({
  type: 'assistant', uuid: `u-${i}`, timestamp: new Date(EPOCH + i).toISOString(),
  message: { role: 'assistant', content: [{ type: 'text', text: `synthetic ${i}` }] },
})

function fixture(loadHistory: ReturnType<typeof vi.fn>) {
  const listeners = new Map<string, Set<(value: unknown) => void>>()
  const list = [{ sessionId: 'a', kind: 'claude', alive: true, cwd: '/synthetic', lastActivityAt: 0 }]
  const methods = { loadHistory, getSessionList: () => list }
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
  return new TranscriptStore(feed, () => EPOCH)
}

describe('bootstrapping flag', () => {
  it('is true while the initial backfill is pending and clears on success', async () => {
    let release!: (chunk: HistoryChunkResult) => void
    const loadHistory = vi.fn().mockImplementation(
      () => new Promise(resolve => {
        release = (chunk: HistoryChunkResult) => resolve(chunk)
      }),
    )
    const store = fixture(loadHistory)
    try {
      const unsub = store.subscribe('a', () => {})
      // Hold the load's own promise. This used to be `void store.load…()`,
      // so `await pending` waited exactly one microtask and passed only while
      // the store settled within that one tick; reading through the
      // SessionFeed contract (#1177) adds a tick and exposed it.
      const pending = store.loadInitialHistory('a')
      expect(store.getSnapshot('a').bootstrapping).toBe(true)
      release({ entries: [raw(0), raw(1)], file: FILE, hasMore: false })
      await pending
      expect(store.getSnapshot('a').bootstrapping).toBe(false)
      unsub()
    } finally {
      store.dispose()
    }
  })

  it('clears on a hard failure (the flag must never wedge the feed suspended)', async () => {
    const loadHistory = vi.fn().mockRejectedValue(new Error('boom'))
    const store = fixture(loadHistory)
    try {
      const unsub = store.subscribe('a', () => {})
      await store.loadInitialHistory('a')
      expect(store.getSnapshot('a').bootstrapping).toBe(false)
      expect(store.getSnapshot('a').historyError).toBe('boom')
      unsub()
    } finally {
      store.dispose()
    }
  })

  it('is not set by older-page pagination', async () => {
    const loadHistory = vi
      .fn()
      .mockResolvedValueOnce({
        entries: [raw(1)],
        file: FILE,
        hasMore: true,
        offsets: [0],
        totalEntries: 2,
      })
      .mockResolvedValueOnce({ entries: [raw(0)], file: FILE, hasMore: false })
    const store = fixture(loadHistory)
    try {
      const unsub = store.subscribe('a', () => {})
      await store.loadInitialHistory('a')
      expect(store.getSnapshot('a').bootstrapping).toBe(false)
      await store.loadOlderHistory('a')
      expect(store.getSnapshot('a').bootstrapping).toBe(false)
      unsub()
    } finally {
      store.dispose()
    }
  })
})
