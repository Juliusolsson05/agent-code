// The manage_connections card on RECORDED frames (hermes-headless
// research/corpus S26, v0.22.0): Hermes asks to install the n8n MCP server,
// which needs one value (N8N_MCP_SERVER_URL), and the turn waits on the card.
// Owner, 2026-10-14: the pane only said "Hermes is waiting for you to connect
// an account" and the turn sat there with no way to answer it.

import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it } from 'vitest'

import { setHermesConnectionService } from '@main/hermes/registry.js'
import type { HermesConnectionService } from '@main/hermes/service.js'
import { HermesSession } from '@providers/hermes/runtime/hermesSession.js'
import { HERMES_CONNECTION_RESPOND } from '@providers/hermes/runtime/requestAnswers.js'
import type { ConditionCustomAction } from '@shared/conditions-core/contract.js'
import type { HermesConnectionConditionState, ProviderConditionSnapshot } from '@shared/types/providerConditions.js'
import { FakeSocket, READY_FRAME } from 'hermes-headless/testing/fakeSocket'
import { latestRecording } from 'hermes-headless/testing/corpus'

const CAPS = { server_requests: ['approval', 'clarify', 'sudo', 'secret'], declines_not_shown: true }
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
const ring = { events: [], latest_seq: 0, truncated: false, count: 0, epoch: 'epoch-1', open_requests: [] }

let sockets: FakeSocket[] = []
beforeEach(() => {
  sockets = []
  const events = new EventEmitter()
  setHermesConnectionService({
    on: events.on.bind(events),
    off: events.off.bind(events),
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

function recordedS26() {
  const entries = latestRecording('S26', { release: 'v0.22.0' }).filter((entry) => entry.kind === 'ws')
  const created = entries.map((entry) => entry.frame.result as Record<string, unknown> | undefined)
    .find((result) => result && typeof result.stored_session_id === 'string' && result.message_count === 0)!
  const connection = entries.filter((entry) => entry.dir === 'in' && String((entry.frame.params as { type?: string } | undefined)?.type ?? '').startsWith('connection.')).map((entry) => entry.frame)
  return { created, connection }
}

async function withCard() {
  const { created, connection } = recordedS26()
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

const composed = (answer: unknown): ConditionCustomAction =>
  ({ kind: 'custom', id: '795252ea5041:n8n-official:composed', label: 'Connect', name: HERMES_CONNECTION_RESPOND, payload: { opId: '795252ea5041', answer } })

describe('a recorded connection request becomes a card the pane can answer (S26)', () => {
  it('shows what Hermes asked for: the server, its setup text, the value it needs, and the deadline', async () => {
    const { card } = await withCard()
    const state = card()!.state
    expect(state).toMatchObject({ visible: true, opId: '795252ea5041', deadlineAt: Math.round(1792016754.376252 * 1000) })
    expect(state.targets).toEqual([expect.objectContaining({
      name: 'n8n-official',
      kind: 'mcp',
      action: 'install',
      state: 'pending',
      requiredEnv: [expect.objectContaining({ name: 'N8N_MCP_SERVER_URL', required: true, secret: false })],
    })])
    expect(state.targets[0]!.instructions).toContain('In n8n Settings > Instance-level MCP')
    // A value is needed, so there is no one-click Connect; Skip and Continue are.
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
      // An operation that is not open.
      { ...composed({ targets: [{ name: 'n8n-official', status: 'skipped' }] }), payload: { opId: 'nope', answer: { targets: [{ name: 'n8n-official', status: 'skipped' }] } } },
    ]
    for (const action of refused) expect(await session.resolveCondition(action)).toEqual({ ok: false, reason: 'invalid-payload' })
    expect(socket.sent.some((frame) => frame.method === 'connection.respond')).toBe(false)
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
})
