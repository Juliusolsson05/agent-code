import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

import { SessionFeedSource } from './SessionFeedSource.js'
import { SessionFeedTap } from '@main/sessions/sessionFeedTap.js'
import type { SessionManager } from '@main/sessionManager.js'

// SessionFeedSource is the remote SINK over the shared SessionFeedTap (#1177):
// ordering and coalescing are the tap's (pinned in sessionFeedTap.test.ts);
// what this suite owns is the remote-only policy layered on top — the session
// list, the terminal gate, and `removed` forwarding. These tests drive a bare
// EventEmitter standing in for the manager, which is honest: tap and source
// consume nothing but `on()`/`off()`, `list()`, `getSessionKind()`,
// `getSpawnKind()` (the gate's pre-registration fallback), `getSpawnCwd()` and
// `getLastActivityAt()`.

function makeManager(live: string[] = []): SessionManager & EventEmitter {
  const emitter = new EventEmitter() as SessionManager & EventEmitter
  const anyEmitter = emitter as unknown as Record<string, unknown>
  anyEmitter.getSessionKind = vi.fn(() => 'claude')
  anyEmitter.list = vi.fn(() => live)
  anyEmitter.getSpawnCwd = vi.fn(() => null)
  // WHY default to null rather than mirroring getSessionKind: real callers
  // only need getSpawnKind for the pre-registration window where
  // getSessionKind is still null (see SessionFeedSource.emit's gate) — tests
  // that don't care about that window should see the fallback stay inert.
  anyEmitter.getSpawnKind = vi.fn(() => null)
  anyEmitter.getLastActivityAt = vi.fn(() => null)
  return emitter
}

function makeSource(manager: SessionManager & EventEmitter): SessionFeedSource & { feedTap: SessionFeedTap } {
  // A real tap, not a stub: the source is only meaningful over the tap's
  // actual delivery, and the tap is cheap to build over an EventEmitter.
  const tap = new SessionFeedTap(manager)
  const source = new SessionFeedSource(manager, tap)
  const dispose = source.dispose.bind(source)
  return Object.assign(source, {
    feedTap: tap,
    dispose: () => {
      dispose()
      tap.dispose()
    },
  })
}

async function drainImmediates(): Promise<void> {
  // The source's jsonl coalescer flushes on setImmediate — one macrotask hop
  // lands after it.
  await new Promise(resolve => setImmediate(resolve))
}

describe('SessionFeedSource', () => {
  it('forwards feed-covered manager events as channel/payload pairs', () => {
    const manager = makeManager()
    const source = makeSource(manager)
    const seen: Array<{ channel: string; payload: unknown }> = []
    source.onEvent((channel, payload) => seen.push({ channel, payload }))

    manager.emit('screen', { sessionId: 's1', plain: 'hi', markdown: '', recent: 'hi', recentMarkdown: '', picker: { visible: false, items: [] } })
    manager.emit('process-state', { sessionId: 's1', active: true, status: 'Working' })
    manager.emit('conditions', { sessionId: 's1', snapshot: { provider: 'claude', conditions: {} } })
    manager.emit('transcript-diagnostic', { sessionId: 's1', diagnostic: { kind: 'late' } })
    // Screen and process-state are latest-per-session snapshots the tap holds
    // for its 100 ms window (the phone used to get every repaint uncoalesced);
    // conditions and the diagnostic cross directly.
    expect(seen.map(e => e.channel)).toEqual(['conditions', 'transcript-diagnostic'])
    source.feedTap.flush()
    expect(seen.map(e => e.channel)).toEqual(['conditions', 'transcript-diagnostic', 'screen', 'process-state'])
    source.dispose()
  })

  it('does NOT forward raw PTY channels, even though the tap emits them to a sink that asked', () => {
    const manager = makeManager()
    const source = makeSource(manager)
    const seen: string[] = []
    source.onEvent(channel => seen.push(channel))
    // Without a sink that opted in, "the remote saw nothing" could just mean
    // the tap never emitted — the desktop-shaped sink proves the bytes flowed.
    const desktop: string[] = []
    source.feedTap.addSink(channel => desktop.push(channel), { rawPty: true })

    manager.emit('terminal-data', { sessionId: 's1', data: 'raw bytes' })
    manager.emit('agent-pty-data', { sessionId: 's1', data: 'raw bytes' })
    manager.emit('terminal-foreground', { sessionId: 's1', foreground: null })
    manager.emit('pty-data', { sessionId: 's1', data: 'raw bytes' })

    expect(desktop).toEqual(['terminal-data', 'agent-pty-data', 'terminal-foreground'])
    expect(seen).toEqual([])
    source.dispose()
  })

  it('coalesces jsonl entries into one burst per tick', async () => {
    const manager = makeManager()
    const source = makeSource(manager)
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
    const source = makeSource(manager)

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
    const source = makeSource(manager)
    expect(source.listSessions().map(s => s.sessionId).sort()).toEqual(['pre-1', 'pre-2'])
    source.dispose()
  })

  it('never tracks terminal sessions (seeded or started)', () => {
    const manager = makeManager(['term-1'])
    ;(manager.getSessionKind as ReturnType<typeof vi.fn>).mockReturnValue('terminal')
    const source = makeSource(manager)
    expect(source.listSessions()).toEqual([])

    manager.emit('started', { sessionId: 'term-2', kind: 'terminal' })
    expect(source.listSessions()).toEqual([])
    source.dispose()
  })

  it("emits 'removed' for tracked sessions (removed-without-exit paths)", () => {
    const manager = makeManager()
    const source = makeSource(manager)
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

  it('never forwards any frame for a terminal session, whatever the channel (#866)', () => {
    // The listing filter only ever ran on `started`; input-readiness, exit and
    // process-state still relayed terminal ids, which a client could then act on.
    const manager = makeManager()
    ;(manager.getSessionKind as unknown as ReturnType<typeof vi.fn>)
      .mockImplementation((sessionId: string) => (sessionId === 'shell' ? 'terminal' : 'claude'))
    const source = makeSource(manager)
    const seen: Array<[string, unknown]> = []
    source.onEvent((channel, payload) => seen.push([channel, (payload as { sessionId?: unknown }).sessionId]))

    manager.emit('input-readiness', { sessionId: 'shell', input: { ready: true } })
    manager.emit('process-state', { sessionId: 'shell', active: true })
    manager.emit('exit', { sessionId: 'shell', exitCode: 0 })
    manager.emit('input-readiness', { sessionId: 'agent', input: { ready: true } })

    expect(seen).toEqual([['input-readiness', 'agent']])
    source.dispose()
  })

  it('gates on getSpawnKind during the pre-registration window (#866)', () => {
    // A spawning terminal emits its first input-readiness frame BEFORE
    // SessionManager registers the RegistryEntry that getSessionKind reads
    // (sessionManager.ts: spawnInfo set ~:2484 / 'starting' emitted ~:2501,
    // both before the terminal's registry insert ~:3113). getSessionKind
    // returns null for 'shell' during that window; only getSpawnKind knows
    // it's a terminal. Without the fallback this frame would leak through
    // and get stuck forever in RemoteServer.lastInputReadiness, since the
    // session's later exit/removed events ARE filtered once it IS registered.
    const manager = makeManager()
    ;(manager.getSessionKind as unknown as ReturnType<typeof vi.fn>).mockReturnValue(null)
    ;(manager.getSpawnKind as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (sessionId: string) => (sessionId === 'shell' ? 'terminal' : null),
    )
    const source = makeSource(manager)
    const seen: Array<[string, unknown]> = []
    source.onEvent((channel, payload) =>
      seen.push([channel, (payload as { sessionId?: unknown }).sessionId]),
    )

    manager.emit('input-readiness', { sessionId: 'shell', ready: false, reason: 'starting' })
    manager.emit('input-readiness', { sessionId: 'agent', ready: false, reason: 'starting' })

    expect(seen).toEqual([['input-readiness', 'agent']])
    source.dispose()
  })

  it('dispose detaches only this sink; the shared tap keeps feeding the desktop', () => {
    // The tap is main's, shared with the desktop forwarder. Disabling remote
    // must not unsubscribe it or stop its watchers — only remove this sink.
    const manager = makeManager()
    const tap = new SessionFeedTap(manager)
    const source = new SessionFeedSource(manager, tap)
    const seen: string[] = []
    const desktop: string[] = []
    source.onEvent(channel => seen.push(channel))
    tap.addSink(channel => desktop.push(channel))
    source.dispose()
    manager.emit('conditions', { sessionId: 's1', snapshot: { provider: 'claude', conditions: {} } })
    expect(seen).toEqual([])
    expect(desktop).toEqual(['conditions'])
    tap.dispose()
    expect(manager.listenerCount('conditions')).toBe(0)
  })
})
