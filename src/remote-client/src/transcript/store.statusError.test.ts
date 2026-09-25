import { describe, expect, it, vi } from 'vitest'
import type { WebSocketSessionFeed } from '../WebSocketSessionFeed'
import type { HistoryChunkResult } from '../wire'
import { TranscriptStore } from './store'

// jsonl-error consumption: the channel has ridden the wire since v1, but no
// phone consumer existed — an OpenCode provider_session_switched notice or
// an SSE/SQLite channel failure simply vanished and the session looked
// frozen. The store now records the failure string as per-session
// statusError for the unified status surface.

const FILE = '/synthetic/transcript.jsonl'
const EPOCH = Date.parse('2026-01-01T00:00:00Z')

function fixture() {
  const listeners = new Map<string, Set<(value: unknown) => void>>()
  const list = [{ sessionId: 'a', kind: 'opencode', alive: true, cwd: '/synthetic', lastActivityAt: 0 }]
  const loadHistory = vi.fn().mockResolvedValue({ entries: [], file: FILE, hasMore: false } satisfies HistoryChunkResult)
  const methods = { loadHistory, getSessionList: () => list }
  const feed = new Proxy(methods, {
    get(target, key: string) {
      if (key in target) return target[key as keyof typeof target]
      return (cb: (value: unknown) => void) => {
        let set = listeners.get(key)
        if (!set) listeners.set(key, (set = new Set()))
        set.add(cb)
        return () => set.delete(cb)
      }
    },
  }) as unknown as WebSocketSessionFeed
  const store = new TranscriptStore(feed, () => EPOCH)
  const emit = (name: string, value: unknown) => {
    for (const cb of listeners.get(name) ?? []) cb(value)
  }
  return { store, emit }
}

describe('jsonl-error status', () => {
  it('records a live-channel failure as statusError, distinct from historyError', () => {
    const { store, emit } = fixture()
    try {
      const unsub = store.subscribe('a', () => {})
      expect(store.getSnapshot('a').statusError).toBeNull()
      emit('onSessionJsonlError', { sessionId: 'a', message: 'provider session switched: follow ses_new' })
      expect(store.getSnapshot('a').statusError).toBe(
        'provider session switched: follow ses_new',
      )
      // historyError stays its own concern (backfill), untouched.
      expect(store.getSnapshot('a').historyError).toBeNull()
      unsub()
    } finally {
      store.dispose()
    }
  })

  it('clears on exit alongside the other live-channel state', () => {
    const { store, emit } = fixture()
    try {
      const unsub = store.subscribe('a', () => {})
      emit('onSessionJsonlError', { sessionId: 'a', message: 'SSE disconnected' })
      expect(store.getSnapshot('a').statusError).toBe('SSE disconnected')
      emit('onSessionExit', { sessionId: 'a', exitCode: 0 })
      expect(store.getSnapshot('a').statusError).toBeNull()
      unsub()
    } finally {
      store.dispose()
    }
  })

  it('clears a late live channel\'s fault once it reports connected, and nothing else (#1177)', () => {
    // The phone never subscribed to transcript-diagnostic, so an OpenCode
    // Terminal whose server was merely late kept "server never answered" on
    // screen forever while the desktop had already cleared it.
    const { store, emit } = fixture()
    try {
      const unsub = store.subscribe('a', () => {})
      const fault = 'OpenCode Terminal live channel (provider_server_unreachable): the TUI server never answered'
      emit('onSessionJsonlError', { sessionId: 'a', message: fault })
      // A connected report for a DIFFERENT provider's channel is not this fault's.
      emit('onSessionTranscriptDiagnostic', { sessionId: 'a', diagnostic: { kind: 'pi-terminal-live-state', connected: true } })
      expect(store.getSnapshot('a').statusError).toBe(fault)
      emit('onSessionTranscriptDiagnostic', { sessionId: 'a', diagnostic: { kind: 'opencode-terminal-live-state', connected: true } })
      expect(store.getSnapshot('a').statusError).toBeNull()

      // Any other transcript error is somebody else's to clear.
      emit('onSessionJsonlError', { sessionId: 'a', message: 'SSE disconnected' })
      emit('onSessionTranscriptDiagnostic', { sessionId: 'a', diagnostic: { kind: 'opencode-terminal-live-state', connected: true } })
      expect(store.getSnapshot('a').statusError).toBe('SSE disconnected')
      unsub()
    } finally {
      store.dispose()
    }
  })
})
