import { EventEmitter } from 'node:events'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket as NodeWebSocket } from 'ws'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DevicePairing } from '@main/remote/auth/DevicePairing.js'
import { DeviceRegistry } from '@main/remote/auth/deviceRegistry.js'
import { SessionFeedSource } from '@main/remote/SessionFeedSource.js'
import { LanTransport } from '@main/remote/transport/LanTransport.js'
import { RemoteServer } from '@main/remote/RemoteServer.js'
import type { RemoteSessionControl } from '@main/remote/RemoteServer.js'

import { WebSocketSessionFeed } from './WebSocketSessionFeed'
import type { WebSocketLike } from './WebSocketSessionFeed'
import { TranscriptStore } from './transcript/store'

// The drift-catcher: real WebSocketSessionFeed against real RemoteServer over
// real sockets. wire.ts re-declares the protocol types instead of importing
// the server's zod schemas, and THIS suite is what keeps the two sides
// honest — a field rename on either side fails here, not on a phone.

type FakeManager = RemoteSessionControl & EventEmitter

function makeManager(): FakeManager {
  const emitter = new EventEmitter() as FakeManager
  emitter.list = vi.fn(() => [])
  emitter.getScreenSnapshot = vi.fn(() => null)
  emitter.getConditionsSnapshot = vi.fn(() => null)
  emitter.getBackendSnapshot = vi.fn(() => null)
  emitter.resolveTranscriptFile = vi.fn(async () => null)
  emitter.getSpawnCwd = vi.fn(() => null)
  emitter.getLastActivityAt = vi.fn(() => null)
  emitter.write = vi.fn(() => true)
  emitter.submitStagedPrompt = vi.fn(sessionId => emitter.write(sessionId, '\r'))
  emitter.resolveCondition = vi.fn(async () => ({ ok: true as const, state: { done: true } }))
  emitter.deliverPromptToAgent = vi.fn(async () => ({
    ok: true as const,
    acceptance: { kind: 'transport' as const, acceptedAt: 123 },
  }))
  emitter.getSessionKind = vi.fn(() => 'claude' as const)
  return emitter
}

let dir: string
let manager: FakeManager
let feedSource: SessionFeedSource
let server: RemoteServer
let token: string
let wsUrl: string
let feed: WebSocketSessionFeed | null = null

function makeFeed(overrides: Partial<{ token: string }> = {}): WebSocketSessionFeed {
  feed = new WebSocketSessionFeed({
    url: wsUrl,
    token: overrides.token ?? token,
    // Node has no global browser WebSocket with the exact event surface we
    // need; the ws package's client implements addEventListener/send/close
    // compatibly, which is the whole reason createSocket is injectable.
    createSocket: url => new NodeWebSocket(url) as unknown as WebSocketLike,
  })
  return feed
}

function waitForOpen(f: WebSocketSessionFeed): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('connect timeout')), 3000)
    const off = f.onConnectionState(state => {
      if (state === 'open') {
        clearTimeout(deadline)
        off()
        resolve()
      }
    })
  })
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'remote-feed-'))
  manager = makeManager()
  const registry = new DeviceRegistry(join(dir, 'devices.json'))
  await registry.load()
  const pairing = new DevicePairing({ secret: randomBytes(32), registry })
  feedSource = new SessionFeedSource(manager as never)
  server = new RemoteServer({
    manager,
    feedSource,
    pairing,
    registry,
    transport: new LanTransport({ port: 0 }),
  })
  const { url } = await server.start()
  const base = url.replace(/\/\/[\d.]+:/, '//127.0.0.1:')
  wsUrl = `${base.replace(/^http/, 'ws')}/ws`

  const { code } = pairing.issuePairingCode()
  const redeemed = await pairing.redeemPairingCode(code, 'integration phone')
  if (!redeemed.ok) throw new Error('pairing setup failed')
  token = redeemed.token
})

afterEach(async () => {
  feed?.dispose()
  feed = null
  await server.stop()
  feedSource.dispose()
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })
})

describe('WebSocketSessionFeed against a live RemoteServer', () => {
  it('receives session events through SessionFeed listeners', async () => {
    const f = makeFeed()
    await waitForOpen(f)

    const screens: string[] = []
    f.onSessionScreen(e => screens.push(e.plain))
    manager.emit('screen', {
      sessionId: 's1', plain: 'live from the mac', markdown: '',
      recent: 'live from the mac', recentMarkdown: '',
      picker: { visible: false, items: [] },
    })
    await vi.waitFor(() => expect(screens).toContain('live from the mac'))
  })

  it('transports versioned input readiness through the same feed contract', async () => {
    const f = makeFeed()
    await waitForOpen(f)

    const readiness: Array<{ ready: boolean; revision: number }> = []
    f.onSessionInputReadiness(e => readiness.push(e.input))
    manager.emit('input-readiness', {
      sessionId: 's1',
      input: { ready: true, revision: 7, reason: 'ready' },
    })

    await vi.waitFor(() => expect(readiness).toContainEqual({
      ready: true,
      revision: 7,
      reason: 'ready',
    }))
  })

  it('tracks the session list from started/exit events', async () => {
    const f = makeFeed()
    await waitForOpen(f)

    manager.emit('started', { sessionId: 's1', kind: 'claude', projectDir: '/repo' })
    await vi.waitFor(() =>
      expect(f.getSessionList().map(s => s.sessionId)).toContain('s1'),
    )
    manager.emit('exit', { sessionId: 's1', exitCode: 0 })
    await vi.waitFor(() =>
      expect(f.getSessionList().find(s => s.sessionId === 's1')?.alive).toBe(false),
    )
  })

  it('deliverPrompt round-trips to the manager and resolves ok', async () => {
    const f = makeFeed()
    await waitForOpen(f)

    const result = await f.deliverPrompt('s1', 'hello from the phone')
    expect(result).toMatchObject({ ok: true, acceptance: { kind: 'transport' } })
    // Through the provider prompt-delivery discipline — NOT a bare paste
    // write (see RemoteServer's send-prompt handler for the WHY).
    expect(manager.deliverPromptToAgent).toHaveBeenCalledWith('s1', 'hello from the phone')
    expect(manager.write).not.toHaveBeenCalled()
  })

  it('preserves retry-unsafe delivery metadata across the WebSocket reply', async () => {
    manager.deliverPromptToAgent = vi.fn(async () => ({
      ok: false as const,
      stage: 'after-enter' as const,
      code: 'acceptance-timeout' as const,
      message: 'uncertain',
      retrySafe: false,
      disposition: 'do-not-retry' as const,
      promptWritten: true,
      enterWritten: true,
    }))
    const f = makeFeed()
    await waitForOpen(f)
    await expect(f.deliverPrompt('s1', 'maybe')).resolves.toMatchObject({
      ok: false,
      code: 'acceptance-timeout',
      retrySafe: false,
      promptWritten: true,
    })
  })

  it('conservatively normalizes a pre-disposition server failure', async () => {
    manager.deliverPromptToAgent = vi.fn(async () => ({
      ok: false as const,
      stage: 'before-write' as const,
      code: 'not-ready' as const,
      message: 'legacy server still warming',
      retrySafe: true,
      promptWritten: false,
      enterWritten: false,
    } as never))
    const f = makeFeed()
    await waitForOpen(f)

    await expect(f.deliverPrompt('s1', 'retry later')).resolves.toMatchObject({
      ok: false,
      disposition: 'retry-same-session',
      retrySafe: true,
    })
  })

  it('sendInput translates submit/interrupt/paste and rejects raw bytes', async () => {
    const f = makeFeed()
    await waitForOpen(f)

    expect(await f.sendInput('s1', '\r')).toBe(true)
    // The third arg is the write's ORIGIN, and it is asserted rather than
    // relaxed away: this is the phone-client path, and `remote` is one of the
    // few attributions the write boundary can make for free. If a refactor
    // dropped the label, every remote keystroke would silently journal as a
    // local renderer write — a wrong answer to the one question the
    // input.write event exists to answer.
    // No origin asserted on this one: the '\r' comes from this file's own
    // `submitStagedPrompt` fake, which calls write directly. Production submits
    // do not reach the manager this way, so pinning an origin here would assert
    // the mock rather than the code.
    expect(manager.write).toHaveBeenCalledWith('s1', '\r')

    expect(await f.sendInput('s1', '\x1b')).toBe(true)
    expect(manager.write).toHaveBeenCalledWith('s1', '\x1b', 'remote')

    expect(await f.sendInput('s1', '\x1b[200~multi\nline\x1b[201~')).toBe(true)
    expect(manager.deliverPromptToAgent).toHaveBeenCalledWith('s1', 'multi\nline')

    await expect(f.sendInput('s1', 'ls -la')).rejects.toThrow(/not part of the v1/)
  })

  it('resolveCondition round-trips a custom action', async () => {
    const f = makeFeed()
    await waitForOpen(f)

    const result = await f.resolveCondition('s1', {
      kind: 'custom', id: 'q0', label: 'Answer', name: 'claude.auq', payload: { a: 1 },
    })
    expect(result).toEqual({ ok: true, state: { done: true } })
  })

  it('a bad token cannot connect but keeps retrying quietly', async () => {
    const f = makeFeed({ token: 'v1.bogus.1.sig' })
    const states: string[] = []
    f.onConnectionState(s => states.push(s))
    await vi.waitFor(() => expect(states).toContain('closed'))
    expect(states).not.toContain('open')
  })

  it('TranscriptStore folds live jsonl + semantic + backfill into a feed-ready snapshot', async () => {
    // The full phone pipeline over real sockets: raw jsonl frames map
    // through the desktop's own provider mapper, semantic deltas fold
    // through the desktop's foldSemanticEvent, and history prepends behind
    // live entries with the shared seen-set deduping the overlap.
    const transcript = join(dir, 'live.jsonl')
    const disk = [
      { type: 'user', uuid: 'u-old', message: { role: 'user', content: 'earlier prompt' } },
      { type: 'assistant', uuid: 'a-old', message: { role: 'assistant', content: [{ type: 'text', text: 'earlier answer' }] } },
      // Deliberately ALSO delivered live below — the seen-set must dedupe.
      { type: 'user', uuid: 'u-live', message: { role: 'user', content: 'do the thing' } },
    ]
    const recordedBundle = JSON.parse(
      readFileSync(
        join(
          process.cwd(),
          'testing/fixtures/rendering-bundles/2026-06-14T14-25-07-012-a8ad1ebb.json',
        ),
        'utf8',
      ),
    ) as { input: { entries: Array<Record<string, unknown>> } }
    const durableQueuedPrompt = recordedBundle.input.entries[13]!
    await writeFile(transcript, disk.map(d => JSON.stringify(d)).join('\n') + '\n', 'utf8')
    ;(manager.resolveTranscriptFile as ReturnType<typeof vi.fn>).mockResolvedValue(transcript)

    const f = makeFeed()
    const store = new TranscriptStore(f)
    await waitForOpen(f)

    manager.emit('started', { sessionId: 's1', kind: 'claude', projectDir: '/repo' })
    // Live entry arrives FIRST (before backfill) — the desktop-order case.
    manager.emit('jsonl-entry', {
      sessionId: 's1',
      entry: { type: 'user', uuid: 'u-live', message: { role: 'user', content: 'do the thing' } },
      file: transcript,
    })
    await vi.waitFor(() =>
      expect(store.getSnapshot('s1').entries.map(e => e.uuid)).toEqual(['u-live']),
    )

    // The phone store deliberately shares the desktop provider mapper. A
    // recorded queued-command attachment must therefore survive live remote
    // transport too; otherwise desktop reload would show the user bubble while
    // the same session on mobile silently dropped it.
    manager.emit('jsonl-entry', {
      sessionId: 's1',
      entry: durableQueuedPrompt,
      file: transcript,
    })
    await vi.waitFor(() =>
      expect(store.getSnapshot('s1').entries.map(e => e.uuid)).toEqual([
        'u-live',
        durableQueuedPrompt.uuid,
      ]),
    )

    // Backfill prepends the older records and skips the duplicate.
    await store.loadInitialHistory('s1')
    await vi.waitFor(() =>
      expect(store.getSnapshot('s1').entries.map(e => e.uuid)).toEqual([
        'u-old', 'a-old', 'u-live', durableQueuedPrompt.uuid,
      ]),
    )
    expect(store.getSnapshot('s1').hasOlderHistory).toBe(false)

    // Semantic stream: a live turn builds via the desktop fold. The phase
    // advances on stream_phase (what Claude/Codex adapters actually emit) —
    // the shared reducer deliberately does NOT bridge turn_started from
    // 'idle' (desktop-exact semantics; the desktop's bridge only fills the
    // optimistic submitting/requesting gap, which the phone doesn't set).
    manager.emit('semantic-event', {
      sessionId: 's1',
      event: { type: 'turn_started', turnId: 'turn-1' },
    })
    manager.emit('semantic-event', {
      sessionId: 's1',
      event: { type: 'stream_phase', phase: 'responding', turnId: 'turn-1' },
    })
    manager.emit('semantic-event', {
      sessionId: 's1',
      event: {
        type: 'block_started', turnId: 'turn-1', blockId: 'b1', blockType: 'text',
      },
    })
    manager.emit('semantic-event', {
      sessionId: 's1',
      event: { type: 'text_delta', turnId: 'turn-1', blockId: 'b1', text: 'streaming…' },
    })
    await vi.waitFor(() => {
      const snap = store.getSnapshot('s1')
      expect(snap.semanticTurn).not.toBeNull()
      expect(snap.phase.streamPhase).toBe('responding')
    })

    store.dispose()
  })

  it('commands fail cleanly while disconnected', async () => {
    const f = makeFeed()
    await waitForOpen(f)
    f.dispose()
    const result = await f.deliverPrompt('s1', 'too late')
    // The request was rejected locally, so preserving the draft is enough:
    // retrying after reconnect cannot duplicate anything in Claude.
    expect(result).toMatchObject({
      ok: false,
      stage: 'before-write',
      retrySafe: true,
      promptWritten: false,
      enterWritten: false,
    })
  })
})
