// The manage_connections card on RECORDED frames (hermes-headless
// research/corpus, v0.22.0):
//   S26 — install n8n-official, which needs N8N_MCP_SERVER_URL; answered Skip.
//   S28 — install airtable (OAuth), answered Approve: the row goes
//         `initiated` with no link, then `failed`; Continue settles it.
// Owner, 2026-10-14: the pane only said "Hermes is waiting for you to connect
// an account" and the turn sat there with no way to answer it.
//
// Every recorded `deadline_at` is moved to "5 minutes from now" (a
// mechanical mutation): the recordings are from the past, and the pane drops
// a card whose deadline passed (the reconnect backstop).

import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setHermesConnectionService } from '@main/hermes/registry.js'
import type { HermesConnectionService } from '@main/hermes/service.js'
import { HermesSession } from '@providers/hermes/runtime/hermesSession.js'
import { HERMES_CONNECTION_RESPOND, validateConnectionAnswer } from '@providers/hermes/runtime/requestAnswers.js'
import type { ConditionCustomAction } from '@shared/conditions-core/contract.js'
import type { HermesConnectionConditionState, ProviderConditionSnapshot } from '@shared/types/providerConditions.js'
import { connectionOperation } from 'hermes-headless'
import { FakeSocket, READY_FRAME } from 'hermes-headless/testing/fakeSocket'
import { latestRecording } from 'hermes-headless/testing/corpus'

const CAPS = { server_requests: ['approval', 'clarify', 'sudo', 'secret'], declines_not_shown: true }
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
const ring = { events: [], latest_seq: 0, truncated: false, count: 0, epoch: 'epoch-1', open_requests: [] }

let sockets: FakeSocket[] = []
let serviceEvents = new EventEmitter()
beforeEach(() => {
  sockets = []
  serviceEvents = new EventEmitter()
  setHermesConnectionService({
    on: serviceEvents.on.bind(serviceEvents),
    off: serviceEvents.off.bind(serviceEvents),
    dialFor: () => async () => {
      const socket = new FakeSocket()
      sockets.push(socket)
      return socket
    },
    reportBackend: () => undefined,
    reportReachability: () => undefined,
    restFor: () => ({}),
    consumeLaneLookupFailure: () => false,
    gatewayRunning: async () => null,
  } as unknown as HermesConnectionService)
})
afterEach(() => {
  vi.restoreAllMocks()
})

type Frame = Record<string, unknown> & { params: { payload: Record<string, unknown> } }

function recorded(scenario: 'S26' | 'S28') {
  const entries = latestRecording(scenario, { release: 'v0.22.0' }).filter((entry) => entry.kind === 'ws')
  const created = entries.map((entry) => entry.frame.result as Record<string, unknown> | undefined)
    .find((result) => result && typeof result.stored_session_id === 'string' && result.message_count === 0)!
  const deadline = (Date.now() + 300_000) / 1000
  const connection = entries
    .filter((entry) => entry.dir === 'in' && String((entry.frame.params as { type?: string } | undefined)?.type ?? '').startsWith('connection.'))
    .map((entry) => {
      const frame = entry.frame as Frame
      return { ...frame, params: { ...frame.params, payload: { ...frame.params.payload, deadline_at: deadline } } } as Frame
    })
  return { created, connection }
}

async function withCard(scenario: 'S26' | 'S28' = 'S26') {
  const { created, connection } = recorded(scenario)
  const session = new HermesSession({ cwd: '/tmp/project', remoteConnectionId: 'conn-1' })
  const snapshots: ProviderConditionSnapshot[] = []
  session.on('conditions', (snapshot: ProviderConditionSnapshot) => snapshots.push(snapshot))
  const starting = session.start()
  for (let attempt = 0; attempt < 100 && !sockets[0]; attempt += 1) await flush()
  const socket = sockets[0]!
  await flush()
  socket.push(READY_FRAME())
  await socket.answerCall('client.capabilities', CAPS)
  await socket.answerCall('session.create', created)
  await socket.answerCall('session.events.since', ring)
  await starting
  socket.push(connection[0])
  const card = () => snapshots.at(-1)?.conditions['hermes.connection'] as { state: HermesConnectionConditionState; actions: ConditionCustomAction[] } | undefined
  return { session, socket, connection, card, created }
}

const composed = (answer: unknown, opId = '795252ea5041'): ConditionCustomAction =>
  ({ kind: 'custom', id: `${opId}:n8n-official:composed`, label: 'Connect', name: HERMES_CONNECTION_RESPOND, payload: { opId, answer } })

describe('a recorded connection request becomes a card the pane can answer (S26)', () => {
  it('shows what Hermes asked for: the server, its setup text, the value it needs, and the deadline', async () => {
    const { card } = await withCard()
    const state = card()!.state
    expect(state).toMatchObject({ visible: true, opId: '795252ea5041' })
    expect(state.targets).toEqual([expect.objectContaining({
      name: 'n8n-official',
      kind: 'mcp',
      action: 'install',
      state: 'pending',
      requiredEnv: [expect.objectContaining({ name: 'N8N_MCP_SERVER_URL', required: true, secret: false })],
    })])
    expect(state.targets[0]!.instructions).toContain('In n8n Settings > Instance-level MCP')
    // A value is needed, so the form approves it; one-click is Skip and Continue only.
    expect(card()!.actions.map((action) => action.label)).toEqual(['Skip', 'Continue without it'])
  })

  it('sends the typed value to Hermes through connection.respond, owned by this conversation', async () => {
    const { session, socket, created } = await withCard()
    const resolving = session.resolveCondition(composed({ targets: [{ name: 'n8n-official', status: 'approved', env: { N8N_MCP_SERVER_URL: 'https://n8n.example/mcp-server/http' } }] }))
    const call = await socket.nextSent((frame) => frame.method === 'connection.respond')
    expect(call.params).toEqual({
      op_id: '795252ea5041',
      owner: { session_id: created.session_id, type: 'session' },
      result: { targets: [{ name: 'n8n-official', status: 'approved', env: { N8N_MCP_SERVER_URL: 'https://n8n.example/mcp-server/http' } }] },
    })
    socket.push({ jsonrpc: '2.0', id: call.id, result: { status: 'ok', settled: false } })
    expect(await resolving).toEqual({ ok: true })
  })

  it('refuses answers the operation did not ask for', async () => {
    const { session, socket } = await withCard()
    const refused = [
      // The required value left empty.
      composed({ targets: [{ name: 'n8n-official', status: 'approved', env: { N8N_MCP_SERVER_URL: '  ' } }] }),
      // A value it never asked for.
      composed({ targets: [{ name: 'n8n-official', status: 'approved', env: { N8N_MCP_SERVER_URL: 'https://x', AWS_SECRET_ACCESS_KEY: 'x' } }] }),
      // A target that is not on the card.
      composed({ targets: [{ name: 'github', status: 'skipped' }] }),
      // Two answers for one row (approve, then cancel it).
      composed({ targets: [{ name: 'n8n-official', status: 'approved', env: { N8N_MCP_SERVER_URL: 'https://x' } }, { name: 'n8n-official', status: 'skipped' }] }),
      // An operation that is not open.
      composed({ targets: [{ name: 'n8n-official', status: 'skipped' }] }, 'nope'),
    ]
    for (const action of refused) expect(await session.resolveCondition(action)).toEqual({ ok: false, reason: 'invalid-payload' })
    expect(socket.sent.some((frame) => frame.method === 'connection.respond')).toBe(false)
  })

  it('refuses an answer to a row that is already resolved, and to a settled operation', async () => {
    const { session, socket, connection } = await withCard()
    socket.push(connection[1])
    // Recorded seq 1: the row is `skipped`, resolved.
    expect(await session.resolveCondition(composed({ targets: [{ name: 'n8n-official', status: 'skipped' }] }))).toEqual({ ok: false, reason: 'invalid-payload' })
    const settled = connectionOperation(connection[2]!.params.payload)!
    expect(settled.settled).toBe(true)
    expect(validateConnectionAnswer({ ...connectionOperation(connection[0]!.params.payload)!, settled: true }, { targets: [{ name: 'n8n-official', status: 'skipped' }] })).toBeNull()
  })

  it('Skip answers it, and the recorded updates take the card down once Hermes settles it', async () => {
    const { session, socket, connection, card } = await withCard()
    const skip = card()!.actions.find((action) => action.label === 'Skip')!
    const resolving = session.resolveCondition(skip)
    const call = await socket.nextSent((frame) => frame.method === 'connection.respond')
    expect((call.params as { result: unknown }).result).toEqual({ targets: [{ name: 'n8n-official', status: 'skipped' }] })
    socket.push({ jsonrpc: '2.0', id: call.id, result: { status: 'ok', settled: false } })
    await resolving
    socket.push(connection[1])
    expect(card()!.state.targets[0]).toMatchObject({ state: 'skipped', resolved: true })
    socket.push(connection[2])
    expect(card()).toBeUndefined()
  })

  it('a late older snapshot neither rolls the card back nor reopens a settled one', async () => {
    const { socket, connection, card } = await withCard()
    // The package already drops a frame at or below its envelope watermark,
    // so an old snapshot reaches the pane only with a NEW envelope seq (a
    // ring replayed after a resume reset the watermark). Mechanical
    // mutation: the recorded seq-0 snapshot re-sent with envelope seq 900+.
    const at = (index: number, envelopeSeq: number) => ({ ...connection[index]!, params: { ...connection[index]!.params, seq: envelopeSeq } })
    socket.push(connection[1])
    socket.push(at(0, 900))
    expect(card()!.state.targets[0]!.state).toBe('skipped')
    // Later frames keep climbing past the replay, as a live stream would.
    socket.push(at(2, 901))
    socket.push(at(0, 902))
    expect(card()).toBeUndefined()
  })

  it('takes the card down when the connection is signed out', async () => {
    const { card } = await withCard()
    expect(card()).toBeDefined()
    serviceEvents.emit('disconnect', 'conn-1', 'signed-out')
    await flush()
    expect(card()).toBeUndefined()
  })

  it('after a reconnect, Hermes\' pending_connection decides: restored if still open, gone if not', { timeout: 30_000 }, async () => {
    const { socket, connection, card, created } = await withCard()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const reconnectWith = async (index: number, pending: unknown) => {
      sockets[index - 1]!.close(1006, 'network')
      // The reconnect loop backs off on a real timer; poll for its dial.
      const next = await (async () => {
        for (let waited = 0; waited < 8_000 && !sockets[index]; waited += 20) await new Promise((resolve) => setTimeout(resolve, 20))
        return sockets[index]!
      })()
      await flush()
      next.push(READY_FRAME(`epoch-restarted-${index}`))
      await next.answerCall('client.capabilities', CAPS)
      const resume = await next.nextSent((frame) => frame.method === 'session.resume')
      next.push({ jsonrpc: '2.0', id: resume.id, result: { ...created, ...(pending ? { pending_connection: pending } : {}) } })
      await next.answerCall('session.events.since', ring)
      for (let tick = 0; tick < 10; tick += 1) await flush()
    }
    void socket
    // The operation settled while away: the snapshot has none → the card goes.
    await reconnectWith(1, null)
    expect(card()).toBeUndefined()
    // Still open (Hermes' "restore the card with the server's deadline").
    await reconnectWith(2, connection[0]!.params.payload)
    expect(card()!.state.opId).toBe('795252ea5041')
  })
})

describe('an approved OAuth install, as recorded (S28)', () => {
  it('offers one-click Install while pending, nothing while Hermes works, Try again once it failed', async () => {
    const { session, socket, connection, card } = await withCard('S28')
    expect(card()!.actions.map((action) => action.label)).toEqual(['Install', 'Skip', 'Continue without it'])
    const install = card()!.actions.find((action) => action.label === 'Install')!
    const resolving = session.resolveCondition(install)
    const call = await socket.nextSent((frame) => frame.method === 'connection.respond')
    // Exactly what the recorded client sent.
    expect((call.params as { result: unknown }).result).toEqual({ targets: [{ name: 'airtable', status: 'approved' }] })
    socket.push({ jsonrpc: '2.0', id: call.id, result: { status: 'ok', settled: false } })
    await resolving
    // Recorded: initiated, no link. Hermes is installing; approving again would do nothing.
    socket.push(connection[1])
    expect(card()!.state.targets[0]).toMatchObject({ state: 'initiated', connectUrl: null })
    expect(card()!.actions.map((action) => action.label)).toEqual(['Skip', 'Continue without it'])
    // Recorded: failed, with Hermes' reason. A retry is something Hermes acts on.
    socket.push(connection[2])
    expect(card()!.state.targets[0]!.detail).toContain('requires HTTP transport')
    expect(card()!.actions.map((action) => action.label)).toEqual(['Try again', 'Skip', 'Continue without it'])
  })
})
