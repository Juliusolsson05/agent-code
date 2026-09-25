import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import type { AgentProviderKind } from '@shared/types/providerKind'
import { applyFeedEvent, createReplayFoldState } from '@renderer/rendering/replay/reconstructSlices'
import type { WebSocketSessionFeed } from '../WebSocketSessionFeed'
import { TranscriptStore } from './store'

// The phone store and the desktop fold run the SAME ingest core since #1177
// (session-runtime/ingest/). Before that the phone mirrored the desktop's
// rules by hand and the mirror drifted: it prepended history blindly and
// handed the ledger a constant lastJsonlEntryAt. This suite is the
// regression net for that drift:
//
//   1. Parity on REAL transcripts. The replay fold (reconstructSlices.ts) is
//      the desktop's live admission in node form, and the phone store is the
//      phone's; fed the same bursts of a real Claude or Codex transcript, both
//      must admit the same rows in the same order with the same producer-time
//      cursor.
//   2. The behaviours the phone lacked, each pinned where it lives.

const ROOT = resolve(__dirname, '../../../../testing/fixtures/conversations')
const FILE = '/fixture/transcript.jsonl'

function transcripts(dir: string, limit: number): string[] {
  const found: string[] = []
  const walk = (at: string): void => {
    for (const name of readdirSync(at).sort()) {
      const path = join(at, name)
      if (statSync(path).isDirectory()) walk(path)
      else if (name.endsWith('.jsonl')) found.push(path)
    }
  }
  walk(dir)
  // Bounded well under the live window's trim threshold (liveEntryWindow.ts):
  // replay never trims, so a transcript long enough to trim would compare a
  // trimmed phone window with an untrimmed replay and prove nothing.
  // A transcript with no assistant message (a metadata-only Codex rollout)
  // maps to nothing on both sides and would compare two empty arrays.
  return found
    .filter(path => {
      const text = readFileSync(path, 'utf8')
      return text.split('\n').length < 600 && text.includes('"role":"assistant"')
    })
    .slice(0, limit)
}

function records(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(line => line.trim().length > 0)
    .flatMap(line => {
      try {
        return [JSON.parse(line) as Record<string, unknown>]
      } catch {
        return []
      }
    })
}

type Harness = {
  store: TranscriptStore
  emit: (listener: string, payload: unknown) => void
  loadHistory: ReturnType<typeof vi.fn>
}

function harness(kind: AgentProviderKind): Harness {
  const listeners = new Map<string, Set<(value: unknown) => void>>()
  const list = [{ sessionId: 's', kind, alive: true, cwd: '/fixture', lastActivityAt: 0 }]
  // No transcript on the host yet: the benign failure the store treats as
  // "live frames will populate the feed".
  const loadHistory = vi.fn().mockRejectedValue(new Error('no transcript yet'))
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
  const store = new TranscriptStore(feed)
  return {
    store,
    loadHistory,
    emit: (listener, payload) => {
      for (const cb of listeners.get(listener) ?? []) cb(payload)
    },
  }
}

describe('phone store and desktop fold admit the same rows', () => {
  const cases: Array<[AgentProviderKind, string]> = [
    ...transcripts(join(ROOT, 'claude/projects'), 4).map(path => ['claude', path] as [AgentProviderKind, string]),
    ...transcripts(join(ROOT, 'codex/sessions'), 3).map(path => ['codex', path] as [AgentProviderKind, string]),
  ]

  it('has real transcripts to compare (the suite is not vacuous)', () => {
    expect(cases.some(([kind]) => kind === 'claude')).toBe(true)
    expect(cases.some(([kind]) => kind === 'codex')).toBe(true)
  })

  it.each(cases)('%s %s', (kind, path) => {
    const raws = records(path)
    const replay = createReplayFoldState(kind, 's')
    const { store, emit } = harness(kind)
    const unsubscribe = store.subscribe('s', () => {})
    try {
      // Irregular burst sizes: the coalescer delivers whatever accumulated
      // in one tick, and a mapper's cross-line cursor (Codex turn ids) must
      // survive burst boundaries on both sides.
      for (let at = 0, size = 1; at < raws.length; at += size, size = (size % 7) + 1) {
        const burst = raws.slice(at, at + size).map(entry => ({ entry, file: FILE }))
        applyFeedEvent(replay, 'session:jsonl-entries', { sessionId: 's', entries: burst })
        emit('onSessionJsonlEntries', { sessionId: 's', entries: burst })
      }
      const phone = store.getSnapshot('s')
      expect(replay.entries.length).toBeGreaterThan(0)
      expect(phone.entries.map(e => e.uuid)).toEqual(replay.entries.map(e => e.uuid))
      expect(phone.lastJsonlEntryAt).toBe(replay.lastJsonlEntryAt)
    } finally {
      unsubscribe()
      store.dispose()
    }
  })
})

const EPOCH = Date.parse('2026-01-01T00:00:00Z')
const row = (id: string, minute: number): Record<string, unknown> => ({
  type: 'assistant',
  uuid: id,
  timestamp: new Date(EPOCH + minute * 60_000).toISOString(),
  message: { role: 'assistant', content: [{ type: 'text', text: id }] },
})

describe('phone behaviours that used to diverge from the desktop', () => {
  it('places an initial chunk against rows that arrived live first (#910 rule)', async () => {
    // The view already holds a and c live; the backfill brings [b, c] where
    // a < b < c. A blind prepend (the phone before #1177) painted b above a,
    // and uuid dedup made that order permanent.
    const { store, emit, loadHistory } = harness('claude')
    const unsubscribe = store.subscribe('s', () => {})
    try {
      emit('onSessionJsonlEntries', { sessionId: 's', entries: [{ entry: row('a', 1), file: FILE }, { entry: row('c', 3), file: FILE }] })
      loadHistory.mockResolvedValueOnce({ entries: [row('b', 2), row('c', 3)], file: FILE, hasMore: false })
      // The live frame above already queued one backfill that failed benignly;
      // this is the retry the next list frame would trigger.
      await vi.waitFor(() => expect(store.getSnapshot('s').loadingOlderHistory).toBe(false))
      await store.loadInitialHistory('s')
      expect(store.getSnapshot('s').entries.map(e => e.uuid)).toEqual(['a', 'b', 'c'])
    } finally {
      unsubscribe()
      store.dispose()
    }
  })
})
