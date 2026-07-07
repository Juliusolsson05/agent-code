import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

import { SessionFeedSource } from './SessionFeedSource.js'
import type { SessionManager } from '@main/sessionManager.js'

// SessionFeedSource is the remote subsystem's ONLY tap into SessionManager's
// event stream — a second subscriber alongside the renderer forwarder, never
// a replacement for it. These tests drive a bare EventEmitter standing in
// for the manager, which is honest: the source consumes nothing but `on()`
// and `getSessionKind()`.

function makeManager(live: string[] = []): SessionManager & EventEmitter {
  const emitter = new EventEmitter() as SessionManager & EventEmitter
  const anyEmitter = emitter as unknown as Record<string, unknown>
  anyEmitter.getSessionKind = vi.fn(() => 'claude')
  anyEmitter.list = vi.fn(() => live)
  anyEmitter.getSpawnCwd = vi.fn(() => null)
  anyEmitter.getLastActivityAt = vi.fn(() => null)
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
      { sessionId: 's1', kind: 'claude', cwd: '/repo', alive: true, lastActivityAt: null },
      { sessionId: 's2', kind: 'codex', cwd: null, alive: true, lastActivityAt: null },
    ])

    manager.emit('exit', { sessionId: 's1', exitCode: 0 })
    expect(source.listSessions().find(s => s.sessionId === 's1')?.alive).toBe(false)
    // removed drops the session entirely — it left the manager.
    manager.emit('removed', { sessionId: 's2' })
    expect(source.listSessions().map(s => s.sessionId)).toEqual(['s1'])
    source.dispose()
  })

  it('seeds already-live sessions at construction (pre-enable agents are visible)', () => {
    const manager = makeManager(['pre-1', 'pre-2'])
    const source = new SessionFeedSource(manager)
    expect(source.listSessions().map(s => s.sessionId).sort()).toEqual(['pre-1', 'pre-2'])
    source.dispose()
  })

  it('never tracks terminal sessions (seeded or started)', () => {
    const manager = makeManager(['term-1'])
    ;(manager.getSessionKind as ReturnType<typeof vi.fn>).mockReturnValue('terminal')
    const source = new SessionFeedSource(manager)
    expect(source.listSessions()).toEqual([])

    manager.emit('started', { sessionId: 'term-2', kind: 'terminal' })
    expect(source.listSessions()).toEqual([])
    source.dispose()
  })

  it("emits 'removed' for tracked sessions (removed-without-exit paths)", () => {
    const manager = makeManager()
    const source = new SessionFeedSource(manager)
    const seen: Array<{ channel: string; payload: unknown }> = []
    source.onEvent((channel, payload) => seen.push({ channel, payload }))

    manager.emit('started', { sessionId: 's1', kind: 'claude' })
    manager.emit('removed', { sessionId: 's1' })
    expect(seen.map(e => e.channel)).toEqual(['started', 'removed'])
    expect(source.listSessions()).toEqual([])
    // Untracked (e.g. terminal) removals stay silent.
    manager.emit('removed', { sessionId: 'never-tracked' })
    expect(seen.map(e => e.channel)).toEqual(['started', 'removed'])
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
