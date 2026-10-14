// HermesSession in Telegram-thread mode (#1496) on RECORDED lane traffic
// (hermes-headless research/corpus T5: Hermes v0.22.0 with its real Telegram
// adapter). What the pane shows: the one-time "not on your phone" line, the
// held-prompt card with Send now / Cancel, and the /new refusal.

import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it } from 'vitest'

import { setHermesConnectionService } from '@main/hermes/registry.js'
import type { HermesConnectionService } from '@main/hermes/service.js'
import { HermesSession, type HermesEntryPayload } from '@providers/hermes/runtime/hermesSession.js'
import type { ProviderConditionSnapshot } from '@shared/types/providerConditions.js'
import { FakeSocket, READY_FRAME } from 'hermes-headless/testing/fakeSocket'
import { recordingFor, type CorpusEntry } from 'hermes-headless/testing/corpus'

const DM = 'agent:main:telegram:dm:111'
const CAPS = { server_requests: ['approval', 'clarify', 'sudo', 'secret'], declines_not_shown: true }
const RING = { events: [], latest_seq: 0, truncated: false, count: 0, epoch: 'epoch-1', open_requests: [] }
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

const entries: CorpusEntry[] = recordingFor('T5', 'v0.22.0')
const resultOf = (id: string) => entries.find((entry) => entry.dir === 'in' && entry.kind === 'ws' && entry.frame.id === id)!.frame.result as Record<string, unknown>
const listing = entries.find((entry) => entry.dir === 'in' && entry.kind === 'http' && /\/api\/sessions\?/.test(String(entry.frame.url)) && entry.frame.status === 200)!.frame.body as { sessions: unknown[] }

let socket: FakeSocket
let history: Record<string, unknown>

beforeEach(() => {
  socket = new FakeSocket()
  history = resultOf('r3')
  setHermesConnectionService({
    on: () => undefined,
    off: () => undefined,
    dialFor: () => async () => socket,
    restFor: () => ({
      listSessions: async () => listing,
      latestDescendant: async (id: string) => ({ requested_session_id: id, session_id: id, path: [id], changed: false }),
    }),
    reportBackend: () => undefined,
    reportReachability: () => undefined,
  } as unknown as HermesConnectionService)
  const answered = new Set<string>()
  void (async () => {
    for (;;) {
      const call = await socket.nextSent((frame) => typeof frame.method === 'string' && frame.id !== undefined && !answered.has(String(frame.id)))
      answered.add(String(call.id))
      const method = String(call.method)
      const result = method === 'client.capabilities' ? CAPS
        : method === 'session.resume' ? resultOf('r2')
        : method === 'session.events.since' ? RING
        : method === 'session.history' ? history
        : method === 'prompt.submit' ? { status: 'streaming', user_row_id: 6 }
        : {}
      socket.push({ jsonrpc: '2.0', id: call.id, result })
    }
  })()
})

async function startLane() {
  const session = new HermesSession({ cwd: '/', remoteConnectionId: 'conn-1', hermesLaneKey: DM })
  const rows: HermesEntryPayload[] = []
  const conditions: ProviderConditionSnapshot[] = []
  session.on('jsonl-entry', (row: HermesEntryPayload) => rows.push(row))
  session.on('conditions', (snapshot: ProviderConditionSnapshot) => conditions.push(snapshot))
  const starting = session.start()
  await flush()
  socket.push(READY_FRAME())
  await starting
  return { session, rows, conditions }
}

describe('a Hermes pane following the Telegram thread', () => {
  it('says once that pane messages do not reach the phone', async () => {
    const { rows } = await startLane()
    await flush()
    const notices = rows.filter((row) => row.row.role === 'notice').map((row) => String(row.row.text))
    expect(notices.filter((text) => text.includes('do not appear in the Telegram app'))).toHaveLength(1)
  })

  it('holds a message on a card while the phone turn runs, and Send now sends it', async () => {
    const { session, conditions } = await startLane()
    history = resultOf('r4') // the phone's user row is the tail: a phone turn is running
    await session.deliverPromptText('Pane message during the phone turn.')
    const card = conditions.at(-1)!.conditions['hermes.held']!
    expect(card.state).toMatchObject({ visible: true, held: [{ text: 'Pane message during the phone turn.' }] })
    expect(socket.sent.some((frame) => frame.method === 'prompt.submit')).toBe(false)
    const send = card.actions.find((action) => action.label === 'Send now')!
    expect(await session.resolveCondition(send as never)).toEqual({ ok: true })
    expect(socket.sent.filter((frame) => frame.method === 'prompt.submit')).toHaveLength(1)
    expect(conditions.at(-1)!.conditions['hermes.held']).toBeUndefined()
  })

  it('refuses /new and says how to start a new Telegram conversation', async () => {
    const { session, rows } = await startLane()
    await session.deliverPromptText('/new')
    expect(String(rows.at(-1)!.row.text)).toMatch(/type \/new in Telegram/)
    expect(socket.sent.some((frame) => frame.method === 'session.create' || frame.method === 'session.close')).toBe(false)
  })
})
