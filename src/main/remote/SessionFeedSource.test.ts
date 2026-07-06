import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

import { SessionFeedSource } from './SessionFeedSource.js'
import type { SessionManager } from '@main/sessionManager.js'

// SessionFeedSource is the remote subsystem's ONLY tap into SessionManager's
// event stream — a second subscriber alongside the renderer forwarder, never
// a replacement for it. These tests drive a bare EventEmitter standing in
// for the manager, which is honest: the source consumes nothing but `on()`
// and `getSessionKind()`.

function makeManager(): SessionManager & EventEmitter {
  const emitter = new EventEmitter() as SessionManager & EventEmitter
  ;(emitter as unknown as { getSessionKind: (id: string) => string | null }).getSessionKind =
    vi.fn(() => 'claude')
  return emitter
}

async function drainImmediates(): Promise<void> {
  // The source's jsonl coalescer flushes on setImmediate — one macrotask hop
  // lands after it.
  await new Promise(resolve => setImmediate(resolve))
}

describe('SessionFeedSource', () => {
  it('forwards feed-covered manager events as channel/payload pairs', () => {
    const manager = makeManager()
    const source = new SessionFeedSource(manager)
    const seen: Array<{ channel: string; payload: unknown }> = []
    source.onEvent((channel, payload) => seen.push({ channel, payload }))

    manager.emit('screen', { sessionId: 's1', plain: 'hi', markdown: '', recent: 'hi', recentMarkdown: '', picker: { visible: false, items: [] } })
    manager.emit('process-state', { sessionId: 's1', active: true, status: 'Working' })
    manager.emit('conditions', { sessionId: 's1', snapshot: { provider: 'claude', conditions: {} } })

    expect(seen.map(e => e.channel)).toEqual(['screen', 'process-state', 'conditions'])
    source.dispose()
  })

  it('does NOT forward raw PTY channels (terminal-data, agent-pty-data, pty-data)', () => {
    const manager = makeManager()
    const source = new SessionFeedSource(manager)
    const seen: string[] = []
    source.onEvent(channel => seen.push(channel))

    manager.emit('terminal-data', { sessionId: 's1', data: 'raw bytes' })
    manager.emit('agent-pty-data', { sessionId: 's1', data: 'raw bytes' })
    manager.emit('pty-data', { sessionId: 's1', data: 'raw bytes' })

    expect(seen).toEqual([])
    source.dispose()
  })

  it('coalesces jsonl entries into one burst per tick', async () => {
    const manager = makeManager()
    const source = new SessionFeedSource(manager)
    const bursts: unknown[] = []
    source.onEvent((channel, payload) => {
      if (channel === 'jsonl-entries') bursts.push(payload)
    })

    for (let i = 0; i < 5; i++) {
      manager.emit('jsonl-entry', { sessionId: 's1', entry: { i }, file: 'f.jsonl' })
    }
    expect(bursts).toEqual([])
    await drainImmediates()
    expect(bursts).toHaveLength(1)
    expect((bursts[0] as { entries: unknown[] }).entries).toHaveLength(5)
    source.dispose()
  })

  it('tracks the live session list from started/exit', () => {
    const manager = makeManager()
    const source = new SessionFeedSource(manager)

    manager.emit('started', { sessionId: 's1', kind: 'claude', projectDir: '/repo' })
    manager.emit('started', { sessionId: 's2', kind: 'codex' })
    expect(source.listSessions()).toEqual([
      { sessionId: 's1', kind: 'claude', cwd: '/repo', alive: true },
      { sessionId: 's2', kind: 'codex', cwd: null, alive: true },
    ])

    manager.emit('exit', { sessionId: 's1', exitCode: 0 })
    expect(source.listSessions().find(s => s.sessionId === 's1')?.alive).toBe(false)
    // removed drops the session entirely — it left the manager.
    manager.emit('removed', { sessionId: 's2' })
    expect(source.listSessions().map(s => s.sessionId)).toEqual(['s1'])
    source.dispose()
  })

  it('dispose unsubscribes everything (no forwarding after)', () => {
    const manager = makeManager()
    const source = new SessionFeedSource(manager)
    const seen: string[] = []
    source.onEvent(channel => seen.push(channel))
    source.dispose()
    manager.emit('screen', { sessionId: 's1', plain: '', markdown: '', recent: '', recentMarkdown: '', picker: { visible: false, items: [] } })
    expect(seen).toEqual([])
    expect(manager.listenerCount('screen')).toBe(0)
  })
})
