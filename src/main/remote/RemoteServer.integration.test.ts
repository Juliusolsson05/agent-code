import { EventEmitter } from 'node:events'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DevicePairing } from './auth/DevicePairing.js'
import { DeviceRegistry } from './auth/deviceRegistry.js'
import { SessionFeedSource } from './SessionFeedSource.js'
import { LanTransport } from './transport/LanTransport.js'
import { RemoteServer } from './RemoteServer.js'
import type { RemoteSessionControl } from './RemoteServer.js'

// End-to-end over real sockets: pairing over HTTP, authenticated WS,
// feed fan-out, and the scope gate applied to a live connection. The
// manager is a bare EventEmitter + spies — RemoteServer must consume
// nothing more (RemoteSessionControl is the structural proof).

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
  emitter.resolveCondition = vi.fn(async () => ({ ok: true as const }))
  emitter.deliverPromptToAgent = vi.fn(async () => ({
    ok: true as const,
    acceptance: { kind: 'transport' as const, acceptedAt: 123 },
  }))
  emitter.getSessionKind = vi.fn(() => 'claude' as const)
  return emitter
}

let dir: string
let manager: FakeManager
let registry: DeviceRegistry
let pairing: DevicePairing
let feedSource: SessionFeedSource
let server: RemoteServer
let baseUrl: string

async function pairDevice(name = 'test phone'): Promise<string> {
  const { code } = pairing.issuePairingCode()
  const res = await fetch(`${baseUrl}/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, deviceName: name }),
  })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { token: string }
  return body.token
}

function connect(token: string): Promise<{ ws: WebSocket; frames: unknown[] }> {
  const wsUrl = baseUrl.replace(/^http/, 'ws')
  const ws = new WebSocket(`${wsUrl}/ws?token=${encodeURIComponent(token)}`)
  const frames: unknown[] = []
  ws.on('message', data => frames.push(JSON.parse(String(data))))
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve({ ws, frames }))
    ws.once('error', reject)
  })
}

/** Wait until the frame list satisfies a predicate — event-driven, no sleeps. */
function waitFor(frames: unknown[], pred: (frames: unknown[]) => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('waitFor timeout')), 3000)
    const tick = (): void => {
      if (pred(frames)) {
        clearTimeout(deadline)
        resolve()
      } else {
        setImmediate(tick)
      }
    }
    tick()
  })
}

function framesOfType(frames: unknown[], type: string): Array<Record<string, unknown>> {
  return frames.filter(
    (f): f is Record<string, unknown> =>
      typeof f === 'object' && f !== null && (f as { type?: unknown }).type === type,
  )
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'remote-server-'))
  manager = makeManager()
  registry = new DeviceRegistry(join(dir, 'devices.json'))
  await registry.load()
  pairing = new DevicePairing({ secret: randomBytes(32), registry })
  feedSource = new SessionFeedSource(manager as never)
  server = new RemoteServer({
    manager,
    feedSource,
    pairing,
    registry,
    transport: new LanTransport({ port: 0 }),
  })
  const { url } = await server.start()
  // The LAN URL uses the machine's LAN IP; loopback is fine for tests.
  baseUrl = url.replace(/\/\/[\d.]+:/, '//127.0.0.1:')
})

afterEach(async () => {
  await server.stop()
  feedSource.dispose()
  // registry.touch() persists fire-and-forget; a write can race this rm and
  // leave a fresh .tmp file mid-delete (ENOTEMPTY). Retrying absorbs it.
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })
})

describe('pairing endpoint', () => {
  it('redeems a live code and rejects a bogus one', async () => {
    const token = await pairDevice('Julius iPhone')
    expect(pairing.verifyToken(token).ok).toBe(true)

    const bad = await fetch(`${baseUrl}/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'NOPE1234', deviceName: 'x' }),
    })
    expect(bad.status).toBe(403)
  })
})

describe('websocket auth', () => {
  it('rejects upgrades without a valid token', async () => {
    const wsUrl = baseUrl.replace(/^http/, 'ws')
    const ws = new WebSocket(`${wsUrl}/ws?token=garbage`)
    const outcome = await new Promise<string>(resolve => {
      ws.once('open', () => resolve('open'))
      ws.once('error', () => resolve('rejected'))
    })
    expect(outcome).toBe('rejected')
  })

  it('greets an authenticated socket with hello + session-list', async () => {
    const token = await pairDevice()
    const { ws, frames } = await connect(token)
    await waitFor(frames, f => framesOfType(f, 'session-list').length > 0)
    expect(framesOfType(frames, 'hello')).toHaveLength(1)
    ws.close()
  })
})

describe('event fan-out', () => {
  it('broadcasts manager events and replays cached state to late joiners', async () => {
    const token = await pairDevice()
    const screen = {
      sessionId: 's1', plain: 'hello', markdown: '', recent: 'hello',
      recentMarkdown: '', picker: { visible: false, items: [] },
    }
    manager.emit('started', { sessionId: 's1', kind: 'claude', projectDir: '/repo' })

    const live = await connect(token)
    await waitFor(live.frames, f => framesOfType(f, 'session-list').length > 0)
    manager.emit('screen', screen)
    await waitFor(live.frames, f =>
      framesOfType(f, 'session-event').some(e => e.channel === 'screen'),
    )
    live.ws.close()

    // Late joiner: connected AFTER the screen event — must still receive the
    // cached screen so an idle session isn't a blank pane on the phone.
    const late = await connect(token)
    await waitFor(late.frames, f =>
      framesOfType(f, 'session-event').some(e => e.channel === 'screen'),
    )
    late.ws.close()
  })

  it('primes pre-enable state from the manager snapshot caches', async () => {
    // The headline scenario the review caught: an agent blocked on a
    // permission prompt BEFORE the user enabled remote. The manager's
    // snapshot caches are the only source for that state; the server must
    // seed its late-joiner caches from them at start().
    await server.stop()
    ;(manager.list as ReturnType<typeof vi.fn>).mockReturnValue(['pre'])
    ;(manager.getScreenSnapshot as ReturnType<typeof vi.fn>).mockReturnValue({
      plain: 'pre-enable output', markdown: '', recent: 'pre-enable output',
      recentMarkdown: '', picker: { visible: false, items: [] },
    })
    ;(manager.getConditionsSnapshot as ReturnType<typeof vi.fn>).mockReturnValue({
      provider: 'claude', ts: 1,
      conditions: {
        'claude.permission-prompt': {
          kind: 'claude.permission-prompt', state: { visible: true },
          actions: [{ kind: 'pty', id: 'yes', label: 'Yes', data: '1\r' }],
        },
      },
    })
    ;(manager.getBackendSnapshot as ReturnType<typeof vi.fn>).mockReturnValue({
      sessionId: 'pre',
      kind: 'claude',
      cwd: '/repo',
      lifecycle: 'live',
      input: { ready: false, revision: 3, reason: 'replaying-history' },
    })
    feedSource.dispose()
    feedSource = new SessionFeedSource(manager as never)
    server = new RemoteServer({
      manager, feedSource, pairing, registry,
      transport: new LanTransport({ port: 0 }),
    })
    const { url } = await server.start()
    baseUrl = url.replace(/\/\/[\d.]+:/, '//127.0.0.1:')
    const token = await pairDevice()

    const { ws, frames } = await connect(token)
    await waitFor(frames, f =>
      framesOfType(f, 'session-event').some(e => e.channel === 'conditions') &&
      framesOfType(f, 'session-event').some(e => e.channel === 'screen') &&
      framesOfType(f, 'session-event').some(e => e.channel === 'input-readiness'),
    )
    // And the primed condition's pty action must be actionable.
    ws.send(JSON.stringify({
      token, id: 'r1',
      message: {
        type: 'permission-reply', sessionId: 'pre',
        action: { kind: 'pty', id: 'yes', label: 'Yes', data: '1\r' },
      },
    }))
    await waitFor(frames, f => framesOfType(f, 'reply').length > 0)
    // The third arg is the write's ORIGIN, and it is asserted rather than
    // relaxed away: this is the phone-client path, and `remote` is one of the
    // few attributions the write boundary can make for free. If a refactor
    // dropped the label, every remote keystroke would silently journal as a
    // local renderer write — a wrong answer to the one question the
    // input.write event exists to answer.
    expect(manager.write).toHaveBeenCalledWith('pre', '1\r', 'remote')
    ws.close()
  })
})

describe('inbound scope enforcement on a live socket', () => {
  async function openAuthed(): Promise<{ ws: WebSocket; frames: unknown[]; token: string }> {
    const token = await pairDevice()
    const { ws, frames } = await connect(token)
    await waitFor(frames, f => framesOfType(f, 'session-list').length > 0)
    return { ws, frames, token }
  }

  it('send-prompt routes EVERY kind through the provider prompt-delivery discipline', async () => {
    // Not a bare bracketed-paste write: deliverPromptToAgent hands the text
    // to the provider's own delivery module (paste → await absorption →
    // Enter), which is the desktop's swallowed-Enter protection. The reply
    // arrives only after real delivery.
    const { ws, frames, token } = await openAuthed()
    ws.send(JSON.stringify({
      token, id: 'r1',
      message: { type: 'send-prompt', sessionId: 's1', text: 'do the thing' },
    }))
    await waitFor(frames, f => framesOfType(f, 'reply').length > 0)
    expect(manager.deliverPromptToAgent).toHaveBeenCalledWith('s1', 'do the thing')
    expect(manager.write).not.toHaveBeenCalled()
    expect(framesOfType(frames, 'reply')[0]).toMatchObject({ id: 'r1', ok: true })
    ws.close()
  })

  it('submit and interrupt write their control bytes', async () => {
    const { ws, frames, token } = await openAuthed()
    ws.send(JSON.stringify({ token, id: 'a', message: { type: 'submit', sessionId: 's1' } }))
    ws.send(JSON.stringify({ token, id: 'b', message: { type: 'interrupt', sessionId: 's1' } }))
    await waitFor(frames, f => framesOfType(f, 'reply').length >= 2)
    expect(manager.submitStagedPrompt).toHaveBeenCalledWith('s1')
    expect(manager.write).toHaveBeenCalledWith('s1', '\x1b', 'remote')
    ws.close()
  })

  it('custom permission-reply routes through resolveCondition', async () => {
    const { ws, frames, token } = await openAuthed()
    const action = { kind: 'custom', id: 'q', label: 'Answer', name: 'claude.auq', payload: { a: 1 } }
    ws.send(JSON.stringify({
      token, id: 'r1',
      message: { type: 'permission-reply', sessionId: 's1', action },
    }))
    await waitFor(frames, f => framesOfType(f, 'reply').length > 0)
    expect(manager.resolveCondition).toHaveBeenCalledWith('s1', action)
    ws.close()
  })

  it('pty permission-reply only applies when it matches a LIVE condition action', async () => {
    const { ws, frames, token } = await openAuthed()
    const offered = { kind: 'pty', id: 'yes', label: 'Yes', data: '1\r' }

    // No live condition yet → rejected, nothing written.
    ws.send(JSON.stringify({
      token, id: 'r1',
      message: { type: 'permission-reply', sessionId: 's1', action: offered },
    }))
    await waitFor(frames, f => framesOfType(f, 'reply').length >= 1)
    expect(framesOfType(frames, 'reply')[0]?.ok).toBe(false)
    expect(manager.write).not.toHaveBeenCalled()

    // Provider raises a permission prompt offering that exact action.
    manager.emit('conditions', {
      sessionId: 's1',
      snapshot: {
        provider: 'claude', ts: 1,
        conditions: {
          'claude.permission-prompt': {
            kind: 'claude.permission-prompt', state: { visible: true }, actions: [offered],
          },
        },
      },
    })
    await waitFor(frames, f =>
      framesOfType(f, 'session-event').some(e => e.channel === 'conditions'),
    )
    ws.send(JSON.stringify({
      token, id: 'r2',
      message: { type: 'permission-reply', sessionId: 's1', action: offered },
    }))
    await waitFor(frames, f => framesOfType(f, 'reply').length >= 2)
    expect(manager.write).toHaveBeenCalledWith('s1', '1\r', 'remote')
    ws.close()
  })

  it('out-of-scope message types get an error reply and never touch the manager', async () => {
    const { ws, frames, token } = await openAuthed()
    ws.send(JSON.stringify({
      token, id: 'r1',
      message: { type: 'exec', sessionId: 's1', command: 'rm -rf /' },
    }))
    await waitFor(frames, f => framesOfType(f, 'reply').length > 0)
    expect(framesOfType(frames, 'reply')[0]?.ok).toBe(false)
    expect(manager.write).not.toHaveBeenCalled()
    expect(manager.resolveCondition).not.toHaveBeenCalled()
    ws.close()
  })

  it('get-history serves the newest chunk from the cached transcript file', async () => {
    // Write a real jsonl transcript and point the manager's file cache at
    // it — the exact shape RemoteServer reads for a live session.
    const transcript = join(dir, 'session.jsonl')
    const lines = Array.from({ length: 5 }, (_, i) =>
      JSON.stringify({
        type: 'user',
        uuid: `u-${i}`,
        message: { role: 'user', content: `prompt ${i}` },
      }),
    )
    await writeFile(transcript, lines.join('\n') + '\n', 'utf8')
    ;(manager.resolveTranscriptFile as ReturnType<typeof vi.fn>).mockResolvedValue(transcript)

    const { ws, frames, token } = await openAuthed()
    ws.send(JSON.stringify({
      token, id: 'h1',
      message: { type: 'get-history', sessionId: 's1', limit: 3 },
    }))
    await waitFor(frames, f => framesOfType(f, 'reply').length > 0)
    const reply = framesOfType(frames, 'reply')[0] as {
      ok: boolean
      result: { entries: Array<{ uuid: string }>; hasMore: boolean; totalEntries: number }
    }
    expect(reply.ok).toBe(true)
    // Newest `limit` records, in file order.
    expect(reply.result.entries.map(e => e.uuid)).toEqual(['u-2', 'u-3', 'u-4'])
    expect(reply.result.hasMore).toBe(true)
    expect(reply.result.totalEntries).toBe(5)

    // Older page anchored on the first entry of the previous chunk.
    ws.send(JSON.stringify({
      token, id: 'h2',
      message: { type: 'get-history', sessionId: 's1', beforeMarker: 'u-2', limit: 3 },
    }))
    await waitFor(frames, f => framesOfType(f, 'reply').length >= 2)
    const older = framesOfType(frames, 'reply')[1] as {
      ok: boolean
      result: { entries: Array<{ uuid: string }>; hasMore: boolean }
    }
    expect(older.ok).toBe(true)
    expect(older.result.entries.map(e => e.uuid)).toEqual(['u-0', 'u-1'])
    expect(older.result.hasMore).toBe(false)
    ws.close()
  })

  it('get-history fails cleanly before any transcript exists', async () => {
    const { ws, frames, token } = await openAuthed()
    ws.send(JSON.stringify({
      token, id: 'h1',
      message: { type: 'get-history', sessionId: 's1' },
    }))
    await waitFor(frames, f => framesOfType(f, 'reply').length > 0)
    expect(framesOfType(frames, 'reply')[0]).toMatchObject({
      ok: false, error: expect.stringContaining('no transcript'),
    })
    ws.close()
  })

  it('a revoked device is cut off mid-session', async () => {
    const { ws, frames, token } = await openAuthed()
    const verdict = pairing.verifyToken(token)
    if (!verdict.ok) throw new Error('setup failed')
    await registry.revoke(verdict.deviceId)

    ws.send(JSON.stringify({ token, id: 'r1', message: { type: 'submit', sessionId: 's1' } }))
    await waitFor(frames, f => framesOfType(f, 'reply').length > 0)
    expect(framesOfType(frames, 'reply')[0]?.ok).toBe(false)
    expect(manager.write).not.toHaveBeenCalled()
    ws.close()
  })
})
