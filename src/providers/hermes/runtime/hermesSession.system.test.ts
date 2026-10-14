// HermesSession on RECORDED frames (#1482): the AgentSession contract the
// rest of Agent Code consumes, driven by hermes-headless over a fake socket
// that replays what a real `hermes serve` v0.21.7 sent (hermes-headless
// research/corpus S3/S4/S5/S13).

import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setHermesConnectionService } from '@main/hermes/registry.js'
import { HermesSignedOutError } from '@main/hermes/tokenBroker.js'
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
// A dial that throws instead of opening a socket (set per test).
let dialFailure: Error | null = null
const reports = { backend: [] as unknown[], reachability: [] as boolean[] }
// The service's event side (HermesConnectionService emits 'disconnect').
let serviceEvents = new EventEmitter()
// /restart: what the unauthenticated status says, one value per poll.
let gatewayStates: Array<boolean | null> = []
// The thread lookup that preceded this spawn failed (service.defaultLaneKey).
let laneLookupFailed = false

beforeEach(() => {
  sockets = []
  dialFailure = null
  reports.backend = []
  reports.reachability = []
  serviceEvents = new EventEmitter()
  setHermesConnectionService({
    on: serviceEvents.on.bind(serviceEvents),
    off: serviceEvents.off.bind(serviceEvents),
    dialFor: () => async () => {
      if (dialFailure) throw dialFailure
      const socket = new FakeSocket()
      sockets.push(socket)
      return socket
    },
    reportBackend: (_id: string, contract: unknown) => reports.backend.push(contract),
    reportReachability: (_id: string, reachable: boolean) => reports.reachability.push(reachable),
    restFor: () => ({ restartGateway: async () => ({ ok: true, pid: 1, name: 'gateway-restart' }) }),
    consumeLaneLookupFailure: () => {
      const failed = laneLookupFailed
      laneLookupFailed = false
      return failed
    },
    gatewayRunning: async () => (gatewayStates.length > 1 ? gatewayStates.shift()! : gatewayStates[0] ?? null),
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

  it('removes a card Hermes withdraws (recorded S5 request.cancel on timeout)', async () => {
    const { of, socket } = await startedSession('S3')
    // S5 recorded four approvals; the one Hermes withdrew is the one whose
    // id the cancel names. Its session id is retargeted to the live pane
    // (mechanical mutation: the pane was created from S3).
    const frames = inboundFrames(latestRecording('S5'))
    const recordedCancel = frames.find((frame) => frame.method === 'event' && (frame.params as { type: string }).type === 'request.cancel')!.params as Record<string, unknown>
    const cancelledId = (recordedCancel.payload as { id: string }).id
    const approval = frames.find((frame) => frame.method === 'approval' && frame.id === cancelledId)!
    const liveSid = recorded('S3').sid
    socket.push({ ...approval, params: { ...(approval.params as object), session_id: liveSid } })
    expect((of('conditions').at(-1) as ProviderConditionSnapshot).conditions['hermes.approval']).toMatchObject({ state: { requestId: cancelledId } })
    const cancel = { ...recordedCancel, session_id: liveSid }
    socket.push(eventFrame(cancel))
    await flush()
    expect((of('conditions').at(-1) as ProviderConditionSnapshot).conditions['hermes.approval']).toBeUndefined()
  })

  it('shows one card per request id and counts the others waiting behind it', async () => {
    const { of, socket } = await startedSession('S3')
    const approval = inboundFrames(latestRecording('S5')).find((frame) => frame.method === 'approval')!
    // The same request delivered twice (live, then again from a replay ring)
    // is ONE request, not "+1 more waiting".
    socket.push(approval)
    socket.push(approval)
    const once = (of('conditions').at(-1) as ProviderConditionSnapshot).conditions['hermes.approval']!
    expect(once.state).toMatchObject({ requestId: approval.id, queued: 0 })
    // Mechanical mutation of the recording: a second, distinct request id.
    socket.push({ ...approval, id: `${String(approval.id)}-second` })
    const twice = (of('conditions').at(-1) as ProviderConditionSnapshot).conditions['hermes.approval']!
    // The OLDEST stays on screen; the new one waits behind it.
    expect(twice.state).toMatchObject({ requestId: approval.id, queued: 1 })
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

  it('answers a recorded sudo/secret request only with a string value', async () => {
    // Review a: the value validator had a surviving mutant (accept anything).
    // An object or an oversized value must never reach Hermes, which would
    // write it to the server's .env (secret) or a sudo prompt.
    const { socket, session } = await startedSession('S3')
    for (const method of ['sudo', 'secret'] as const) {
      const request = inboundFrames(latestRecording('S6')).find((frame) => frame.method === method)!
      socket.push(request)
      const answer = (result: unknown): ConditionCustomAction => ({ kind: 'custom', id: 'v', label: 'Send', name: HERMES_ANSWER, payload: { requestId: request.id, result } })
      expect(await session.resolveCondition(answer({ value: { nested: true } }))).toEqual({ ok: false, reason: 'invalid-payload' })
      expect(await session.resolveCondition(answer({ value: 'x'.repeat(4001) }))).toEqual({ ok: false, reason: 'invalid-payload' })
      expect(await session.resolveCondition(answer({ value: 'typed' }))).toEqual({ ok: true })
      expect(socket.sent.at(-1)).toEqual({ jsonrpc: '2.0', id: request.id, result: { value: 'typed' } })
    }
  })

  // Review a #2: a renderer reload adopts the live session in main and asks
  // the shared history loader for the conversation. With no Hermes source it
  // got an empty chunk and the rebuilt pane showed nothing. Driven through
  // the real loader entry point (it imports the main registry, hence the
  // generous timeout).
  it('serves the conversation to a renderer that reloads while the pane lives', async () => {
    const { session, socket, events, frames, created, of } = await startedSession('S4')
    for (const event of events) socket.push(eventFrame(event))
    const history = await socket.nextSent((frame) => frame.method === 'session.history')
    const resumed = frames.map((frame) => frame.result as Record<string, unknown> | undefined)
      .filter((result) => Array.isArray(result?.messages) && (result!.messages as unknown[]).length > 0).at(-1)!
    socket.push({ jsonrpc: '2.0', id: history.id, result: { count: (resumed.messages as unknown[]).length, messages: resumed.messages } })
    await flush()
    const emitted = of('jsonl-entry') as HermesEntryPayload[]
    const { loadInitialHistoryChunk, loadOlderHistoryChunk } = await import('@main/sessions/historyLoader.js')
    const stored = String(created.stored_session_id)
    const all = await loadInitialHistoryChunk({ kind: 'hermes', cwd: '/Users/someone/project', providerSessionId: stored, limit: 120 })
    // Exactly what the renderer folded the first time, in the same order.
    expect(all.entries).toEqual(emitted)
    // Paging by the mapper's marker (the row key) walks back without gaps.
    const newest = await loadInitialHistoryChunk({ kind: 'hermes', cwd: '/', providerSessionId: stored, limit: 2 })
    expect(newest).toMatchObject({ hasMore: true, entries: emitted.slice(-2) })
    // The renderer's cursor is the oldest row's key, as the mapper reports it.
    const older = await loadOlderHistoryChunk({ kind: 'hermes', cwd: '/', providerSessionId: stored, beforeMarker: emitted[3]!.key, limit: 10 })
    expect([...older.entries, ...newest.entries]).toEqual(emitted)
    // A stopped pane serves nothing: its next spawn resumes from the server.
    await session.stop()
    expect((await loadInitialHistoryChunk({ kind: 'hermes', cwd: '/', providerSessionId: stored, limit: 120 })).entries).toEqual([])
  }, 30_000)

  it('lets go of a live socket when its connection is signed out, without closing the conversation', async () => {
    const { of, socket, sid } = await startedSession('S3')
    serviceEvents.emit('disconnect', 'conn-1')
    await flush()
    expect(socket.readyState).toBe(3)
    expect(socket.sent.some((frame) => frame.method === 'session.close')).toBe(false)
    expect(String((of('jsonl-entry') as HermesEntryPayload[]).at(-1)!.row.text)).toMatch(/Signed out of this Hermes connection/)
    // No redial of a connection with no credentials.
    for (let tick = 0; tick < 20; tick += 1) await flush()
    expect(sockets).toHaveLength(1)
    expect(sid).toBeTruthy()
  })

  // Owner's debug bundle 2026-10-14T16-26-49: pane d9567053 sat dead for
  // 10m42s after the user signed in again, until a manual reload.
  it('re-attaches the same conversation by itself after the user signs in again', async () => {
    const { socket, created } = await startedSession('S3')
    serviceEvents.emit('disconnect', 'conn-1', 'signed-out')
    await flush()
    expect(socket.readyState).toBe(3)
    serviceEvents.emit('signed-in', 'conn-1')
    const next = await waitForSocket(1)
    expect(next).toBeDefined()
    next.push(READY_FRAME())
    await next.answerCall('client.capabilities', CAPS)
    // Same backend process (same epoch): the conversation is re-activated on
    // its runtime id, the cheap rung of the reconnect ladder.
    const activate = await next.nextSent((frame) => frame.method === 'session.activate')
    expect((activate.params as { session_id: string }).session_id).toBe(created.session_id)
  })

  it('stays away from a REMOVED connection even if a sign-in event arrives', async () => {
    await startedSession('S3')
    serviceEvents.emit('disconnect', 'conn-1', 'removed')
    await flush()
    serviceEvents.emit('signed-in', 'conn-1')
    for (let tick = 0; tick < 20; tick += 1) await flush()
    expect(sockets).toHaveLength(1)
  })

  // Round-1 review c1 #1. A server that keeps refusing the re-attach (here: an
  // RPC error on every resume after a restart) must see ONE retry chain: a
  // superseded socket closing mid-attempt used to schedule a second chain.
  it('runs one reconnect chain at a time while re-attaching keeps failing', async () => {
    const { socket } = await startedSession('S3')
    vi.spyOn(Math, 'random').mockReturnValue(0)
    let maxOpen = 0
    const failing = async (next: FakeSocket) => {
      next.push(READY_FRAME('epoch-restarted'))
      await next.answerCall('client.capabilities', CAPS)
      // Same epoch after the first failure, so an attempt may try
      // session.activate first; refuse that, then the resume it falls to.
      const first = await next.nextSent((frame) => frame.method === 'session.resume' || frame.method === 'session.activate')
      next.push({ jsonrpc: '2.0', id: first.id, error: { code: 5000, message: 'internal error' } })
      if (first.method === 'session.activate') {
        const resume = await next.nextSent((frame) => frame.method === 'session.resume')
        next.push({ jsonrpc: '2.0', id: resume.id, error: { code: 5000, message: 'internal error' } })
      }
    }
    socket.close(1006, 'network')
    for (let index = 1; index <= 8; index += 1) {
      const next = await waitForSocket(index)
      maxOpen = Math.max(maxOpen, sockets.filter((entry) => entry.readyState === 1).length)
      await failing(next)
      for (let tick = 0; tick < 5; tick += 1) await flush()
    }
    // Each attempt supersedes the last, so at most the newest is open.
    expect(maxOpen).toBe(1)
    // Only the eight sockets this test answered (a ninth may be dialling).
    const resumes = sockets.slice(1, 9).map((entry) => entry.sent.filter((frame) => frame.method === 'session.resume').length)
    expect(resumes.every((count) => count === 1)).toBe(true)
  })

  it('starts a new conversation, with a notice, when the old one was deleted while away', async () => {
    const { of, socket, created, captured } = await startedSession('S3')
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const next = recorded('S4').created
    socket.close(1006, 'network')
    const second = await waitForSocket(1)
    second.push(READY_FRAME('epoch-restarted'))
    await second.answerCall('client.capabilities', CAPS)
    const resume = await second.nextSent((frame) => frame.method === 'session.resume')
    second.push({ jsonrpc: '2.0', id: resume.id, error: { code: 4007, message: 'session not found' } })
    await second.answerCall('session.create', next)
    await second.answerCall('session.events.since', ring())
    for (let tick = 0; tick < 10; tick += 1) await flush()
    // The notice must come AFTER the reset that starts the new conversation,
    // or that reset wipes it before anyone sees it (round-2 review x1 #2).
    const order = captured.filter((entry) => entry.name === 'jsonl-entry' || entry.name === 'history-boundary')
      .map((entry) => entry.name === 'history-boundary' ? `boundary:${(entry.args[0] as { type: string }).type}` : 'row')
    expect(order.slice(-3)).toEqual(['boundary:reset', 'boundary:caught-up', 'row'])
    expect(String((of('jsonl-entry') as HermesEntryPayload[]).at(-1)!.row.text)).toContain(String(created.stored_session_id))
    expect(of('provider-session-changed').at(-1)).toMatchObject({ providerSessionId: next.stored_session_id })
    expect(sockets).toHaveLength(2)
  })

  it('takes down open cards when signed out, and says the connection was removed when it was', async () => {
    const { of, socket } = await startedSession('S3')
    const approval = inboundFrames(latestRecording('S5')).find((frame) => frame.method === 'approval')!
    socket.push(approval)
    expect((of('conditions').at(-1) as ProviderConditionSnapshot).conditions['hermes.approval']).toBeDefined()
    serviceEvents.emit('disconnect', 'conn-1', 'removed')
    await flush()
    expect((of('conditions').at(-1) as ProviderConditionSnapshot).conditions).toEqual({})
    expect(String((of('jsonl-entry') as HermesEntryPayload[]).at(-1)!.row.text)).toMatch(/connection was removed/)
  })

  // Round-2 review c2 #4: a restarted backend (new epoch, recorded S11 shape)
  // needs a resume on the new socket before any prompt can name the right
  // runtime. Input must stay closed until then, and a prompt sent meanwhile
  // is refused as retry-safe `not-ready`, never sent to the dead runtime.
  it('keeps input closed until a reconnect has re-attached the conversation', async () => {
    const { session, socket, of, created } = await startedSession('S3')
    vi.spyOn(Math, 'random').mockReturnValue(0)
    socket.close(1006, 'network')
    const second = await waitForSocket(1)
    second.push(READY_FRAME('epoch-restarted'))
    await second.answerCall('client.capabilities', CAPS)
    const resume = await second.nextSent((frame) => frame.method === 'session.resume')
    expect(of('input-readiness').at(-1)).toMatchObject({ ready: false })
    await expect(session.deliverPromptText('hello after sleep')).rejects.toMatchObject({ kind: 'not-ready' })
    expect(second.sent.some((frame) => frame.method === 'prompt.submit')).toBe(false)
    second.push({ jsonrpc: '2.0', id: resume.id, result: created })
    await second.answerCall('session.events.since', ring())
    for (let tick = 0; tick < 10; tick += 1) await flush()
    expect(of('input-readiness').at(-1)).toEqual({ ready: true, reason: 'ready' })
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

  it('/new rebinds the pane to the new conversation before its rows arrive', async () => {
    // Two REAL conversations: the pane starts on S3's, `/new` is answered
    // with S4's create result, so the stored ids genuinely differ.
    const { of, socket, session, created } = await startedSession('S3')
    const next = recorded('S4').created
    const delivering = session.deliverPromptText('/new')
    await socket.answerCall('session.close', { closed: true })
    await socket.answerCall('session.create', next)
    await socket.answerCall('session.events.since', ring())
    await delivering
    expect(of('provider-session-changed')).toEqual([
      expect.objectContaining({ providerSessionId: created.stored_session_id, reason: 'hermes-created' }),
      expect.objectContaining({ providerSessionId: next.stored_session_id, reason: 'hermes-new-conversation' }),
    ])
    expect(session.getProviderSessionId()).toBe(next.stored_session_id)
    // The reset that follows tells the renderer it is a different
    // conversation, so the old one's live turns are dropped too.
    const resets = (of('history-boundary') as Array<{ type: string; conversationChanged?: boolean }>).filter((entry) => entry.type === 'reset')
    expect(resets.map((entry) => entry.conversationChanged === true)).toEqual([false, true])
  })

  it('stops redialling once the connection is signed out, and says what to do', async () => {
    const { of, socket, captured } = await startedSession('S3')
    // Jitter 0: the first retry fires on the next tick instead of up to 300 ms later.
    vi.spyOn(Math, 'random').mockReturnValue(0)
    dialFailure = new HermesSignedOutError('conn-1')
    socket.close(1006, 'network')
    for (let attempt = 0; attempt < 50 && !of('jsonl-entry').length; attempt += 1) await flush()
    const notice = (of('jsonl-entry') as HermesEntryPayload[]).at(-1)!
    expect(String(notice.row.text)).toMatch(/Signed out of this Hermes connection/)
    expect(of('process-state').at(-1)).toEqual({ active: false, status: 'Signed out of Hermes' })
    // No further attempt is scheduled: a dead sign-in must not spin.
    const before = captured.length
    for (let tick = 0; tick < 20; tick += 1) await flush()
    expect(captured.length).toBe(before)
    expect(sockets).toHaveLength(1)
  })
})


// Review #1503: /restart said "back" from the OLD gateway still draining.
// Status sequences follow recorded S24 (running → stopped → starting/running).
describe('/restart', () => {
  async function restartWith(states: Array<boolean | null>) {
    gatewayStates = states
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] })
    try {
      const { session, of } = await (async () => {
        vi.useRealTimers()
        const started = await startedSession('S3')
        vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] })
        return started
      })()
      await session.deliverPromptText('/restart')
      for (let tick = 0; tick < 60; tick += 1) await vi.advanceTimersByTimeAsync(2_000)
      return (of('jsonl-entry') as HermesEntryPayload[]).map((row) => String(row.row.text ?? ''))
    } finally {
      vi.useRealTimers()
    }
  }

  it('waits for the gateway to go down before saying it is back', async () => {
    const notices = await restartWith([true, true, false, false, true])
    expect(notices.filter((text) => text.includes('gateway is back'))).toHaveLength(1)
    // Every status up to the final "running again" was read before saying so.
    expect(gatewayStates).toEqual([true])
    expect(notices.findIndex((text) => text.includes('gateway is back'))).toBeGreaterThan(notices.findIndex((text) => text.startsWith('Restarting')))
  })

  it('says the restart was not confirmed when the gateway never stops', async () => {
    const notices = await restartWith([true])
    expect(notices.some((text) => text.includes('gateway is back'))).toBe(false)
    expect(notices.some((text) => text.includes('did not confirm the restart'))).toBe(true)
  })
})

// Review #1503: a message that starts no turn must say so, or the composer
// keeps its optimistic "submitting" phase forever.
describe('what delivery reports when no turn starts', () => {
  it('a refused command and /restart report turnStarted: false; a plain message reports true', async () => {
    const { session, socket } = await startedSession('S3')
    expect(await session.deliverPromptText('/model gpt')).toEqual({ turnStarted: false })
    gatewayStates = [null]
    expect(await session.deliverPromptText('/restart')).toEqual({ turnStarted: false })
    const sending = session.deliverPromptText('hello')
    const submit = await socket.nextSent((frame) => frame.method === 'prompt.submit')
    socket.push({ jsonrpc: '2.0', id: submit.id, result: { status: 'streaming', user_row_id: 1 } })
    expect(await sending).toEqual({ turnStarted: true })
    await session.stop()
  })
})

describe('a separate chat opened because the Telegram thread lookup failed (review #1503)', () => {
  it('says so, once', async () => {
    laneLookupFailed = true
    const { of } = await startedSession('S3')
    const notices = (of('jsonl-entry') as HermesEntryPayload[]).map((row) => String(row.row.text ?? ''))
    expect(notices.filter((text) => text.includes('Could not look up your Telegram thread'))).toHaveLength(1)
  })
})
