import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionManager } from '@main/sessionManager.js'

// The sub-agent watcher polls real directories. The stand-in keeps only the
// tap's emit callback, so a test can play a fleet change the way the real
// watcher would report one.
const watcher = vi.hoisted(() => ({ emit: null as null | ((sessionId: string, map: Record<string, unknown>) => void) }))
vi.mock('@main/subagents/index.js', () => ({
  SubAgentWatcherManager: class {
    constructor(emit: (sessionId: string, map: Record<string, unknown>) => void) { watcher.emit = emit }
    observeParentEntry() {}
    stop() {}
    stopAll() {}
  },
}))

import { SessionFeedTap } from './sessionFeedTap.js'
import type { SessionFeedTapChannel } from './sessionFeedTap.js'

// SessionFeedTap is where main decides event ORDER before anything crosses a
// transport (#1177). Before it, the desktop forwarder and the remote feed each
// decided order on their own, and the phone's copy had none of the semantic
// barriers. The contract this suite owns is therefore not "the barriers
// exist" (semanticEventCoalescer.test.ts pins those) but "every sink receives
// the SAME ordered sequence", which is what makes the phone's order the
// desktop's order by construction.

type Recorded = Array<{ channel: SessionFeedTapChannel; kind: string }>

function describeEvent(channel: SessionFeedTapChannel, payload: unknown): string {
  if (channel === 'semantic-event') return (payload as { event: { type: string } }).event.type
  if (channel === 'jsonl-entries') return (payload as { entries: Array<{ entry: { id: string } }> }).entries.map(e => e.entry.id).join(',')
  if (channel === 'screen') return (payload as { plain: string }).plain
  return ''
}

function record(tap: SessionFeedTap, options?: { rawPty?: boolean }): Recorded {
  const seen: Recorded = []
  tap.addSink((channel, payload) => seen.push({ channel, kind: describeEvent(channel, payload) }), options)
  return seen
}

let active: SessionFeedTap | null = null

afterEach(() => {
  active?.dispose()
  active = null
})

function makeTap(): { manager: SessionManager & EventEmitter; tap: SessionFeedTap } {
  const manager = new EventEmitter() as SessionManager & EventEmitter
  active = new SessionFeedTap(manager)
  return { manager, tap: active }
}

const screen = (plain: string) => ({ sessionId: 'pane', plain, markdown: '', recent: plain, recentMarkdown: '', picker: { visible: false, items: [] } })
const textDelta = (textSoFar: string) => ({ sessionId: 'pane', event: { type: 'text_delta', turnId: 't1', blockIndex: 0, textSoFar } })

describe('SessionFeedTap', () => {
  it('delivers one barrier-ordered sequence identically to every sink', () => {
    const { manager, tap } = makeTap()
    // The window sink opts into raw PTY and the remote sink does not; the
    // option must change WHICH channels a sink sees, never their order.
    const desktop = record(tap, { rawPty: true })
    const remote = record(tap)

    // A cumulative preview sits in the 100 ms semantic window; the committed
    // row that supersedes it must not overtake it.
    manager.emit('semantic-event', textDelta('draft'))
    manager.emit('screen', screen('frame-1'))
    manager.emit('jsonl-entry', { sessionId: 'pane', file: '/t.jsonl', entry: { id: 'row-1' } as never })
    // A structural semantic event is a barrier: the screen snapshot and the
    // buffered JSONL row (still waiting for setImmediate) cross first.
    manager.emit('semantic-event', { sessionId: 'pane', event: { type: 'turn_completed', turnId: 't1' } })
    // History boundary: pending preview and rows of the old generation first.
    manager.emit('semantic-event', textDelta('next'))
    manager.emit('jsonl-entry', { sessionId: 'pane', file: '/t.jsonl', entry: { id: 'row-2' } as never })
    manager.emit('history-boundary', { sessionId: 'pane', type: 'reset', generation: 2, snapshotByteLength: 0, file: '/t.jsonl' })
    // Removal flushes every window before the runtime disappears.
    manager.emit('semantic-event', textDelta('last'))
    manager.emit('screen', screen('frame-2'))
    manager.emit('removed', { sessionId: 'pane' })
    manager.emit('exit', { sessionId: 'pane', exitCode: 0 })

    const expected: Recorded = [
      { channel: 'semantic-event', kind: 'text_delta' },
      { channel: 'screen', kind: 'frame-1' },
      { channel: 'jsonl-entries', kind: 'row-1' },
      { channel: 'semantic-event', kind: 'turn_completed' },
      { channel: 'semantic-event', kind: 'text_delta' },
      { channel: 'jsonl-entries', kind: 'row-2' },
      { channel: 'history-boundary', kind: '' },
      { channel: 'semantic-event', kind: 'text_delta' },
      { channel: 'screen', kind: 'frame-2' },
      { channel: 'removed', kind: '' },
      { channel: 'exit', kind: '' },
    ]
    expect(desktop).toEqual(expected)
    expect(remote).toEqual(expected)
  })

  it('keeps a throwing sink from costing another sink its delivery, and raises where a listener would', () => {
    // One coalescer flush fans out to every sink in one loop. A remote failure
    // must not strand the desktop's copy, and it must surface where a
    // throwing EventEmitter listener always did — synchronously, back to the
    // emitter's caller — not as an uncaught exception, which main's crash
    // hooks treat as fatal.
    const { manager, tap } = makeTap()
    tap.addSink(() => { throw new Error('socket gone') })
    const desktop = record(tap)
    expect(() =>
      manager.emit('conditions', { sessionId: 'pane', snapshot: { provider: 'claude', conditions: {} } as never }),
    ).toThrow('socket gone')
    expect(desktop.map(e => e.channel)).toEqual(['conditions'])
  })

  it('seeds a late sink with the live fleet, but never with an exited session\'s', () => {
    // The shared watcher emits only on change, so a sink attached later (the
    // phone, enabled after agents started) is primed from the tap's snapshot.
    // A dead process owns no live fleet: the remote server's cache drops its
    // copy on exit, and a seed that outlived it showed a stale fleet.
    const { manager, tap } = makeTap()
    watcher.emit!('pane', { child: { status: 'running' } })
    expect(tap.getSubAgentsSnapshot('pane')?.subAgents).toEqual({ child: { status: 'running' } })
    manager.emit('exit', { sessionId: 'pane', exitCode: 0 })
    expect(tap.getSubAgentsSnapshot('pane')).toBeNull()
  })

  // Moved from the deleted jsonlCoalescer.test.ts: the burst buffer is tap
  // state now, and the wire-shape contract it pinned is unchanged.
  describe('jsonl observation sidecars', () => {
    it('does not add an undefined Codex-only field to provider-neutral entries', () => {
      const { manager, tap } = makeTap()
      const payloads: Array<{ entries: Array<Record<string, unknown>> }> = []
      tap.addSink((channel, payload) => {
        if (channel === 'jsonl-entries') payloads.push(payload as never)
      })
      manager.emit('jsonl-entry', { sessionId: 'pane', entry: { type: 'user' } as never, file: '/recorded/claude.jsonl' })
      tap.flushSession('pane')
      expect(payloads[0]!.entries[0]).toEqual({ entry: { type: 'user' }, file: '/recorded/claude.jsonl' })
      expect(Object.hasOwn(payloads[0]!.entries[0]!, 'observation')).toBe(false)
    })

    it('preserves an observed Codex rollout generation and ordinal', () => {
      const { manager, tap } = makeTap()
      const payloads: Array<{ entries: Array<Record<string, unknown>> }> = []
      tap.addSink((channel, payload) => {
        if (channel === 'jsonl-entries') payloads.push(payload as never)
      })
      manager.emit('jsonl-entry', {
        sessionId: 'pane',
        entry: { type: 'session_meta' } as never,
        file: '/recorded/codex.jsonl',
        observation: { fileGenerationId: '16777234:991882', rolloutByteOffset: 0 },
      })
      tap.flushSession('pane')
      expect(payloads[0]!.entries[0]!.observation).toEqual({ fileGenerationId: '16777234:991882', rolloutByteOffset: 0 })
    })
  })
})
