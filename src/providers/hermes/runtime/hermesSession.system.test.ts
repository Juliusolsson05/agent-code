// HermesSession on RECORDED frames (#1482): the AgentSession contract the
// rest of Agent Code consumes, driven by hermes-headless over a fake socket
// that replays what a real `hermes serve` v0.21.7 sent (hermes-headless
// research/corpus S3/S4/S5/S13).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setHermesConnectionService } from '@main/hermes/registry.js'
import type { HermesConnectionService } from '@main/hermes/service.js'
import { HermesSession, type HermesEntryPayload } from '@providers/hermes/runtime/hermesSession.js'
import { HERMES_ANSWER } from '@providers/hermes/runtime/requestAnswers.js'
import type { ConditionCustomAction } from '@shared/conditions-core/contract.js'
import type { ProviderConditionSnapshot } from '@shared/types/providerConditions.js'
import { FakeSocket, READY_FRAME } from 'hermes-headless/testing/fakeSocket'
import { inboundFrames, latestRecording } from 'hermes-headless/testing/corpus'

const CAPS = { server_requests: ['approval', 'clarify', 'sudo', 'secret'], declines_not_shown: true }
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
const eventFrame = (params: Record<string, unknown>) => ({ jsonrpc: '2.0', method: 'event', params })
const ring = (events: Array<Record<string, unknown>> = []) => ({ events, latest_seq: events.at(-1)?.seq ?? 0, truncated: false, count: events.length, epoch: 'epoch-1', open_requests: [] })

function recorded(scenario: string) {
  const frames = inboundFrames(latestRecording(scenario))
  const created = frames.map((frame) => frame.result as Record<string, unknown> | undefined)
    .find((result) => result && typeof result.stored_session_id === 'string' && result.message_count === 0)!
  const sid = String(created.session_id)
  const events = frames
    .filter((frame) => frame.method === 'event' && (frame.params as { session_id?: string }).session_id === sid)
    .map((frame) => frame.params as Record<string, unknown>)
  return { frames, created, sid, events }
}

let sockets: FakeSocket[] = []
const reports = { backend: [] as unknown[], reachability: [] as boolean[] }

beforeEach(() => {
  sockets = []
  reports.backend = []
  reports.reachability = []
  setHermesConnectionService({
    dialFor: () => async () => {
      const socket = new FakeSocket()
      sockets.push(socket)
      return socket
    },
    reportBackend: (_id: string, contract: unknown) => reports.backend.push(contract),
    reportReachability: (_id: string, reachable: boolean) => reports.reachability.push(reachable),
  } as unknown as HermesConnectionService)
})
afterEach(() => {
  vi.restoreAllMocks()
})

async function waitForSocket(index: number): Promise<FakeSocket> {
  for (let attempt = 0; attempt < 100 && !sockets[index]; attempt += 1) await flush()
  return sockets[index]
}

type Captured = { name: string; args: unknown[] }

async function startedSession(scenario: string) {
  const data = recorded(scenario)
  const session = new HermesSession({ cwd: '/Users/someone/project', remoteConnectionId: 'conn-1' })
  const captured: Captured[] = []
  for (const name of ['semantic-event', 'jsonl-entry', 'history-boundary', 'conditions', 'input-readiness', 'provider-session-changed', 'process-state', 'started', 'exit']) {
    session.on(name, (...args: unknown[]) => captured.push({ name, args }))
  }
  const starting = session.start()
  const socket = await waitForSocket(0)
  socket.push(READY_FRAME())
  await socket.answerCall('client.capabilities', CAPS)
  await socket.answerCall('session.create', data.created)
  await socket.answerCall('session.events.since', ring())
  await starting
  const of = (name: string) => captured.filter((entry) => entry.name === name).map((entry) => entry.args[0])
  return { ...data, session, socket, captured, of }
}

describe('HermesSession (AgentSession contract on recorded frames)', () => {
  it('binds the pane to the created conversation and reports the backend contract', async () => {
    const { of, created, socket } = await startedSession('S3')
    expect(of('provider-session-changed')).toEqual([expect.objectContaining({ providerSessionId: created.stored_session_id, reason: 'hermes-created' })])
    const boundaries = of('history-boundary') as Array<{ type: string; generation: number }>
    expect(boundaries.map((boundary) => boundary.type)).toEqual(['reset', 'caught-up'])
    // Offset per lifetime: far above a fresh package counter (see generationBase).
    expect(boundaries[0].generation).toBeGreaterThan(1_000_000)
    expect(of('input-readiness').at(-1)).toEqual({ ready: true, reason: 'ready' })
    expect(reports.backend).toContain(8)
    // The pane's local folder never crosses the wire.
    expect(JSON.stringify(socket.sent)).not.toContain('/Users/someone/project')
  })

  it('streams a recorded tool turn as fold events and commits its rows from history', async () => {
    const { of, socket, events, frames } = await startedSession('S4')
    for (const event of events) socket.push(eventFrame(event))
    const history = await socket.nextSent((frame) => frame.method === 'session.history')
    const resumed = frames.map((frame) => frame.result as Record<string, unknown> | undefined)
      .filter((result) => Array.isArray(result?.messages) && (result!.messages as unknown[]).length > 0).at(-1)!
    socket.push({ jsonrpc: '2.0', id: history.id, result: { count: (resumed.messages as unknown[]).length, messages: resumed.messages } })
    await flush()
    const semantic = of('semantic-event') as Array<{ type: string; source: string; toolUseId?: string }>
    expect(semantic.every((event) => event.source === 'hermes-ws')).toBe(true)
    expect(semantic.filter((event) => event.type === 'tool_result').map((event) => event.toolUseId)).toEqual(['call_tools_0_0', 'call_tools_0_1', 'call_tools_1_0'])
    const rows = of('jsonl-entry') as HermesEntryPayload[]
    expect(rows.map((row) => row.key)).toEqual(['row:1', 'tool:call_tools_0_0', 'tool:call_tools_0_1', 'tool:call_tools_1_0', 'row:7'])
    expect(rows.every((row) => row.hermes === 1)).toBe(true)
  })

  it('turns a recorded approval into a card and answers it through resolveCondition', async () => {
    const { of, socket, session } = await startedSession('S3')
    const approval = inboundFrames(latestRecording('S5')).find((frame) => frame.method === 'approval')!
    socket.push(approval)
    const snapshot = of('conditions').at(-1) as ProviderConditionSnapshot
    const record = snapshot.conditions['hermes.approval']!
    expect(record.state).toMatchObject({ visible: true, requestId: approval.id, command: expect.stringContaining('rm -r') })
    const once = record.actions.find((action) => action.kind === 'custom' && action.label === 'Allow once') as ConditionCustomAction
    expect(await session.resolveCondition(once)).toEqual({ ok: true })
    expect(socket.sent.at(-1)).toEqual({ jsonrpc: '2.0', id: approval.id, result: { choice: 'once' } })
    const cleared = of('conditions').at(-1) as ProviderConditionSnapshot
    expect(cleared.conditions['hermes.approval']).toBeUndefined()
  })

  it('refuses an answer the request did not offer, and one for a request that is gone', async () => {
    const { socket, session } = await startedSession('S3')
    const approval = inboundFrames(latestRecording('S5')).find((frame) => frame.method === 'approval')!
    socket.push(approval)
    const invented: ConditionCustomAction = { kind: 'custom', id: 'x', label: 'x', name: HERMES_ANSWER, payload: { requestId: approval.id, result: { choice: 'rm-everything' } } }
    expect(await session.resolveCondition(invented)).toEqual({ ok: false, reason: 'invalid-payload' })
    const stale: ConditionCustomAction = { ...invented, payload: { requestId: 'srq-gone', result: { choice: 'once' } } }
    expect(await session.resolveCondition(stale)).toEqual({ ok: false, reason: 'invalid-payload' })
  })

  it('runs a slash command and shows its output as a local notice (recorded S13)', async () => {
    const { of, socket, session } = await startedSession('S3')
    const s13 = inboundFrames(latestRecording('S13'))
    const usage = s13.map((frame) => frame.result as { output?: string } | undefined).find((result) => result?.output?.startsWith('Session Token Usage'))!
    const delivering = session.deliverPromptText('/usage')
    await socket.answerCall('slash.exec', usage)
    await delivering
    const notice = (of('jsonl-entry') as HermesEntryPayload[]).at(-1)!
    expect(notice.key.startsWith('notice:')).toBe(true)
    expect(String(notice.row.text)).toContain('Session Token Usage')
  })

  it('interrupts on Esc and detaches on stop without ending the conversation', async () => {
    const { of, socket, session, sid } = await startedSession('S3')
    session.write('\x1b')
    const interrupt = await socket.nextSent((frame) => frame.method === 'session.interrupt')
    expect(interrupt.params).toEqual({ session_id: sid })
    await session.stop()
    expect(of('exit')).toEqual([{ exitCode: 0 }])
    expect(socket.sent.some((frame) => frame.method === 'session.close')).toBe(false)
  })
})
