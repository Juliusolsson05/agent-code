import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { expect, it, vi } from 'vitest'
import type { SessionManager } from '@main/sessionManager.js'
import type { LspManager } from '@main/lspManager.js'

const wire = vi.hoisted(() => ({ receive: (_channel: string, _payload: unknown) => {} }))
vi.mock('@main/window/windowRegistry.js', () => ({
  sendToSessionWindow: (_id: string, channel: string, payload: unknown) => wire.receive(channel, payload),
  broadcastToWindows: vi.fn(), releaseSession: vi.fn(),
}))
vi.mock('@main/subagents/index.js', () => ({ SubAgentWatcherManager: class { observeParentEntry() {} stop() {} stopAll() {} } }))

import { wireSessionForwarder } from './forwarder.js'
import { screenInterest, screenTailHistory } from './screenInterest.js'
import { SessionFeedSource } from '@main/remote/SessionFeedSource.js'
import { SessionFeedTap } from './sessionFeedTap.js'

it('delivers understood records before a fatal error to both real sinks', async () => {
  // The shared tap deliberately buffers committed entries until setImmediate.
  // An error in the same drain must flush that buffer first, otherwise clients
  // receive the error followed by older successful records and clear its state.
  // Renderer state assertions belong to the IPC DOM harness; this test owns the
  // actual main-process wire contract rather than reproducing a renderer reducer.
  const manager = new EventEmitter() as SessionManager & EventEmitter
  manager.list = () => []
  // The remote feed drops frames for PLAIN shell terminals (#865), which have
  // no transcript a phone could show. An OpenCode Terminal pane must not be
  // caught by that filter: its kind is the provider ('opencode') and only its
  // runtime is terminal, so both lookups answer 'opencode' here. If a future
  // change made either one report 'terminal' for this pane, every committed
  // record below would vanish from the phone with no error — so this stub is
  // a deliberate assertion about the filter, not incidental scaffolding.
  manager.getSessionKind = () => 'opencode'
  manager.getSpawnKind = () => 'opencode'
  // One tap, two sinks — the production shape (main/index.ts).
  const tap = new SessionFeedTap(manager)
  const remote = new SessionFeedSource(manager, tap)
  const remoteEvents: Array<{ channel: string; payload: unknown }> = []
  const desktopEvents: Array<{ channel: string; payload: unknown }> = []
  remote.onEvent((channel, payload) => remoteEvents.push({ channel, payload }))
  wire.receive = (channel, payload) => desktopEvents.push({ channel, payload })
  const forwarder = wireSessionForwarder(manager, new EventEmitter() as LspManager, tap)
  const entry = { info: { id: 'msg_1', role: 'assistant' }, parts: [{ type: 'text', text: 'Last understood answer' }] }
  try {
    manager.emit('jsonl-entry', { sessionId: 'pane', file: 'provider:session', entry })
    manager.emit('jsonl-error', { sessionId: 'pane', error: new Error('event_version_unsupported') })
    forwarder.flush()
    await new Promise(resolve => setImmediate(resolve))
    expect(desktopEvents).toEqual([
      { channel: 'session:jsonl-entries', payload: { sessionId: 'pane', entries: [{ entry, file: 'provider:session' }] } },
      { channel: 'session:jsonl-error', payload: { sessionId: 'pane', message: 'event_version_unsupported' } },
    ])
    expect(remoteEvents).toEqual(desktopEvents.map(event => ({ ...event, channel: event.channel.replace('session:', '') })))
  } finally {
    wire.receive = () => {}
    remote.dispose()
    manager.emit('removed', { sessionId: 'pane' })
    forwarder.flush()
    manager.removeAllListeners()
  }
})

it('flushes the old session\'s buffered rows before a provider-session change crosses to the desktop', async () => {
  // Pi /new: rows of the session being left may still sit in the 100 ms
  // jsonl batch. The identity must move only after they land, or the renderer
  // would file the old session's last rows under the new identity.
  const manager = new EventEmitter() as SessionManager & EventEmitter
  manager.list = () => []
  manager.getSessionKind = () => 'pi'
  manager.getSpawnKind = () => 'pi'
  const desktopEvents: Array<{ channel: string; payload: unknown }> = []
  wire.receive = (channel, payload) => desktopEvents.push({ channel, payload })
  const forwarder = wireSessionForwarder(manager, new EventEmitter() as LspManager)
  const oldRow = { type: 'message', id: 'a1', parentId: 'u1', line: 5, message: { role: 'assistant', content: [] } }
  try {
    manager.emit('jsonl-entry', { sessionId: 'pane', file: '/s/old.jsonl', entry: oldRow })
    manager.emit('provider-session-changed', { sessionId: 'pane', providerSessionId: 'new-id', transcriptFile: '/s/new.jsonl', reason: 'new' })
    expect(desktopEvents.map(event => event.channel)).toEqual(['session:jsonl-entries', 'session:provider-session-changed'])
    expect(desktopEvents[1]!.payload).toEqual({ sessionId: 'pane', providerSessionId: 'new-id', transcriptFile: '/s/new.jsonl', reason: 'new' })
  } finally {
    wire.receive = () => {}
    manager.emit('removed', { sessionId: 'pane' })
    forwarder.flush()
    manager.removeAllListeners()
  }
})

it('broadcasts a managed-skill warning to every window, carrying domain names only (#1133)', async () => {
  // Broadcast, not session routing: the skill fault is machine-wide, and the
  // session router would quarantine (and record a false routing gap for) a
  // warning about an id no window has claimed yet. The payload is the renderer's
  // entire input. The sessionId stays in main, and the reconcile error never
  // reaches this event in the first place.
  const { broadcastToWindows } = await import('@main/window/windowRegistry.js')
  vi.mocked(broadcastToWindows).mockClear()
  const manager = new EventEmitter() as SessionManager & EventEmitter
  wireSessionForwarder(manager, new EventEmitter() as LspManager)
  try {
    manager.emit('managed-skills-unavailable', { sessionId: 'pane', skills: ['tldr', 'goal'] })
    expect(broadcastToWindows).toHaveBeenCalledWith('managed-skills:unavailable', { skills: ['tldr', 'goal'] })
  } finally {
    manager.removeAllListeners()
  }
})

it('forwards screen frames only to a leased session, and records every frame for debug bundles (#762)', () => {
  // session:screen was 93% of recorded IPC bytes and nothing live reads it.
  // An unleased session's frames stay in main; the tail history still sees
  // them, because a debug bundle must not depend on a panel having been open.
  const manager = new EventEmitter() as SessionManager & EventEmitter
  manager.list = () => []
  const sent: string[] = []
  wire.receive = (channel, payload) => {
    if (channel === 'session:screen') sent.push((payload as { plain: string }).plain)
  }
  const forwarder = wireSessionForwarder(manager, new EventEmitter() as LspManager)
  // A real frame: the recorded Claude Code 2.1.278 screen from the #1113
  // capture (idle, then with a composer draft). What the gate forwards is
  // exactly what the provider painted.
  const recorded = JSON.parse(readFileSync(
    new URL('../../../testing/fixtures/image-absorption/wrapped-image-pill-2026-09-21.json', import.meta.url), 'utf8',
  )) as { deliveries: { wrapped: { baseline: { screen: string }; after: { screen: string } } } }
  const idle = recorded.deliveries.wrapped.baseline.screen
  const drafted = recorded.deliveries.wrapped.after.screen
  // `recent` is the wider window (Codex scrollback) and is what the history
  // must record, so it differs from `plain` here to pin that (#1236 review C).
  const frame = (screen: string) => ({ sessionId: 'pane', plain: screen.slice(-200), markdown: screen, recent: screen, recentMarkdown: screen })
  try {
    manager.emit('screen', frame(idle))
    forwarder.flush()
    expect(sent).toEqual([])

    screenInterest.acquire(7, 'pane')
    manager.emit('screen', frame(drafted))
    forwarder.flush()
    expect(sent).toEqual([drafted.slice(-200)])

    screenInterest.release(7, 'pane')
    manager.emit('screen', frame(idle))
    forwarder.flush()
    expect(sent).toEqual([drafted.slice(-200)])

    // Every frame reached the tail history, forwarded or not (idle, drafted,
    // idle again: the dedupe only collapses consecutive repeats).
    expect(screenTailHistory.samples('pane')).toHaveLength(3)
    expect(screenTailHistory.samples('pane')[1]!.content.length).toBeGreaterThan(drafted.slice(-200).trimEnd().length)
    manager.emit('removed', { sessionId: 'pane' })
    forwarder.flush()
    expect(screenTailHistory.samples('pane')).toEqual([])
  } finally {
    screenInterest.dropOwner(7)
    wire.receive = () => {}
    manager.removeAllListeners()
  }
})
