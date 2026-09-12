import { EventEmitter } from 'node:events'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { afterEach, beforeEach, expect, vi } from 'vitest'
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

const clients: WebSocket[] = []
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
  clients.push(ws)
  const frames: unknown[] = []
  ws.on('message', data => frames.push(JSON.parse(String(data))))
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve({ ws, frames }))
    ws.once('error', reject)
  })
}

/** Wait until the frame list satisfies a predicate — event-driven, no sleeps. */
function waitFor(frames: unknown[], pred: (frames: unknown[]) => boolean): Promise<void> {
  const deadline = performance.now() + 3000
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      if (pred(frames)) resolve()
      else if (performance.now() >= deadline) reject(new Error('waitFor timeout'))
      else setImmediate(tick)
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
  await restartServer()
})

afterEach(async () => {
  // A failing server teardown must not strand the independent sockets, feed
  // subscriptions or directory. Register clients at connect(), before open can
  // fail, and attempt every release even when an earlier one rejects.
  const failures: unknown[] = []
  const releases = [
    ...clients.splice(0).map(client => () => client.terminate()),
    () => server?.stop(),
    () => feedSource?.dispose(),
    // registry.touch() persists asynchronously and may still finish a rename.
    () => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }),
  ]
  for (const release of releases) {
    try { await release() } catch (error) { failures.push(error) }
  }
  if (failures.length) throw new AggregateError(failures, 'remote fixture cleanup failed')
})

async function openAuthed(): Promise<{ ws: WebSocket; frames: unknown[]; token: string }> {
  const token = await pairDevice()
  const { ws, frames } = await connect(token)
  await waitFor(frames, f => framesOfType(f, 'session-list').length > 0)
  return { ws, frames, token }
}

export { dir, manager, registry, pairing, feedSource, server, baseUrl, pairDevice, connect, waitFor, framesOfType, openAuthed, restartServer }

async function restartServer(): Promise<void> {
  await server?.stop()
  feedSource?.dispose()
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
}
