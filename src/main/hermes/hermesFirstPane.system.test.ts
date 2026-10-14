// The first Hermes pane through the REAL main-side path (r7 P0, plan Stage F):
// HermesConnectionService (connections file, token store with a test codec,
// token broker, dial) → HermesSession → hermes-headless, against a server
// played from RECORDED traffic. Before this, the package live tier bypassed
// Agent Code and the app tests faked the service, so "signed in, pane does
// not start" (the owner's first day, 2026-10-14) could pass every suite.
//
// What is real: everything in main from the connection record to the
// AgentSession events. What is played: the HTTP exchanges and WS frames,
// from hermes-headless research/corpus (S3 v0.21.7 create, S25 v0.20.4).

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { SecretCodec } from '@main/keyVault/vaultStore.js'
import { setHermesConnectionService } from '@main/hermes/registry.js'
import { HermesConnectionService } from '@main/hermes/service.js'
import { HermesTokenStore } from '@main/hermes/tokenStore.js'
import { classifySpawnFailure } from '@main/ipc/session.js'
import { HermesSession } from '@providers/hermes/runtime/hermesSession.js'
import { RemoteProviderStartError } from '@shared/errors/remoteProviderStartError.js'
import { HERMES_INCOMPATIBLE_MESSAGE } from '@shared/types/session.js'
import { FakeSocket } from 'hermes-headless/testing/fakeSocket'
import { inboundFrames, latestRecording, recordingFor, type CorpusEntry } from 'hermes-headless/testing/corpus'

const codec: SecretCodec = {
  isEncryptionAvailable: () => true,
  encrypt: (plain) => Buffer.from(`enc:${plain}`, 'utf8'),
  decrypt: (cipher) => Buffer.from(cipher).toString('utf8').slice(4),
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

/** The recorded ws-ticket response of a scenario. */
function recordedTicket(entries: CorpusEntry[]): Response {
  const index = entries.findIndex((entry) => entry.dir === 'out' && entry.kind === 'http' && String(entry.frame.url).endsWith('/api/auth/ws-ticket'))
  const response = entries[index + 1]!.frame
  return new Response(JSON.stringify(response.body), { status: Number(response.status) })
}

let dir: string
let sockets: Array<{ socket: FakeSocket; url: string; protocols: string[] }>

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hermes-first-pane-'))
  sockets = []
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function signedInService(entries: CorpusEntry[]) {
  const service = new HermesConnectionService({
    stateDir: dir,
    codec,
    openExternal: () => undefined,
    fetchImpl: async (url) => {
      if (new URL(url).pathname === '/api/auth/ws-ticket') return recordedTicket(entries)
      throw new Error(`unexpected request ${url}`)
    },
    openSocket: async (url, protocols) => {
      const socket = new FakeSocket()
      sockets.push({ socket, url, protocols })
      return socket
    },
  })
  await service.initialize()
  const connection = await service.add({ name: 'VPS', baseUrl: 'https://hermes.example' })
  // Signed in (the browser hand-off itself is covered by hermesCredentials.test.ts).
  await new HermesTokenStore(join(dir, 'hermes', 'tokens'), codec).set(connection.id, 'https://hermes.example', {
    accessToken: 'access', refreshToken: 'refresh', expiresAt: Date.now() + 3_600_000, provider: 'basic', userId: 'owner',
  })
  setHermesConnectionService(service)
  return { service, connectionId: connection.id }
}

async function socketAt(index: number) {
  for (let tick = 0; tick < 200 && !sockets[index]; tick += 1) await flush()
  return sockets[index]!
}

describe('the first Hermes pane, through the real main-side path', () => {
  it('opens a conversation (recorded S3) with the ticket in the subprotocol, never the URL', async () => {
    const entries = latestRecording('S3')
    const frames = inboundFrames(entries)
    const ready = frames.find((frame) => (frame.params as { type?: string } | undefined)?.type === 'gateway.ready')!
    const created = frames.map((frame) => frame.result as Record<string, unknown> | undefined).find((result) => result && result.message_count === 0 && typeof result.stored_session_id === 'string')!
    const { connectionId } = await signedInService(entries)
    const session = new HermesSession({ cwd: '/', remoteConnectionId: connectionId })
    const changed: unknown[] = []
    session.on('provider-session-changed', (event: unknown) => changed.push(event))
    const starting = session.start()
    const { socket, url, protocols } = await socketAt(0)
    expect(url).toBe('wss://hermes.example/api/ws')
    expect(protocols[0]).toBe('hermes-gateway-v1')
    expect(protocols[1]).toMatch(/^hermes-gateway-ticket\./)
    socket.push(ready)
    await socket.answerCall('client.capabilities', { server_requests: ['approval', 'clarify', 'sudo', 'secret'] })
    await socket.answerCall('session.create', created)
    await socket.answerCall('session.events.since', { events: [], latest_seq: 0, truncated: false, count: 0, epoch: 'e', open_requests: [] })
    await starting
    expect(changed).toEqual([expect.objectContaining({ providerSessionId: created.stored_session_id, reason: 'hermes-created' })])
    // The first message goes out queued-safe (H2).
    const delivering = session.deliverPromptText('hello').catch(() => undefined)
    const submit = await socket.nextSent((frame) => frame.method === 'prompt.submit')
    expect(submit.params).toMatchObject({ text: 'hello', queued: true })
    socket.push({ jsonrpc: '2.0', id: submit.id, result: { status: 'streaming', user_row_id: 1 } })
    await delivering
    await session.stop()
  })

  it('tells the user to update Hermes when the server is too old (recorded S25, v0.20.4)', async () => {
    const entries = recordingFor('S25', 'v0.20.4')
    const frames = inboundFrames(entries)
    const ready = frames.find((frame) => (frame.params as { type?: string } | undefined)?.type === 'gateway.ready')!
    const refusal = frames.find((frame) => (frame.error as { code?: number } | undefined)?.code === -32601)!
    const { connectionId } = await signedInService(entries)
    const session = new HermesSession({ cwd: '/', remoteConnectionId: connectionId })
    const starting = session.start().catch((error: unknown) => error)
    const { socket } = await socketAt(0)
    socket.push(ready)
    const call = await socket.nextSent((frame) => frame.method === 'client.capabilities')
    socket.push({ ...refusal, id: call.id })
    const error = await starting
    expect(error).toBeInstanceOf(RemoteProviderStartError)
    expect((error as RemoteProviderStartError).detail).toMatchObject({ rpcCode: -32601, method: 'client.capabilities' })
    // What crosses IPC to the pane: the curated sentence, not "Session failed to start".
    expect(classifySpawnFailure(error, false).message).toBe(HERMES_INCOMPATIBLE_MESSAGE)
  })
})
