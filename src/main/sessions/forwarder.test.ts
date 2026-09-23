import { EventEmitter } from 'node:events'
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
import { SessionFeedSource } from '@main/remote/SessionFeedSource.js'

it('delivers understood records before a fatal error through both real coalescers', async () => {
  // Both subscribers deliberately buffer committed entries until setImmediate.
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
  const remote = new SessionFeedSource(manager)
  const remoteEvents: Array<{ channel: string; payload: unknown }> = []
  const desktopEvents: Array<{ channel: string; payload: unknown }> = []
  remote.onEvent((channel, payload) => remoteEvents.push({ channel, payload }))
  wire.receive = (channel, payload) => desktopEvents.push({ channel, payload })
  const forwarder = wireSessionForwarder(manager, new EventEmitter() as LspManager)
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
