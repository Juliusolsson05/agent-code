import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpencodeTerminalLaunch } from 'opencode-terminal-headless'
import {
  buildReplayScript,
  FakePty,
  listLiveFixtures,
  LiveFixtureWriter,
  loadLiveFixture,
  playReplay,
  ReplayServer,
  sessionRowFor,
  settle,
  waitUntil,
  type LiveFixture,
  type ReplayStep,
} from 'opencode-terminal-headless/testing/index'

// Agent Code imports node-pty at module level and its copy is built for
// Electron's ABI; the adapter's spawn is injected below, so the module itself
// only has to be importable.
vi.mock('node-pty', () => ({ spawn: vi.fn() }))

import { OpencodeTerminalSession } from './opencodeTerminalSession.js'
import type { ConditionCustomAction, ProviderConditionSnapshot } from '@shared/types/providerConditions.js'

// The adapter end to end: every recorded OpenCode TUI session is re-enacted
// (real sockets, a real SQLite file written the way OpenCode writes it)
// through the REAL opencode-terminal-headless package and the REAL adapter,
// and the AgentSession events SessionManager receives are checked against the
// contract the renderer and orchestration depend on
// (docs/decomposition/opencode-terminal-headless.md, #864):
//
//   process-state  active during a turn, idle after, never idle mid-turn
//   semantic-event turn_started / stream_phase / turn_completed, paired
//   jsonl-entry    committed { info, parts } on opencode://session/<id>
//   conditions     opencode.permission / opencode.question, then cleared
//   ORDER          answer entry → turn_completed → phase idle → inactive
//
// Expectations come from each recording's own facts, never from the adapter.

class AdapterPty extends FakePty {
  readonly kill = vi.fn(() => this.exit(0, 15))
  onData(): { dispose(): void } {
    return { dispose: () => undefined }
  }
}

type Event = { name: string; args: unknown[] }

const PASSWORD = 'adapter-replay'
const EVENT_NAMES = ['started', 'input-readiness', 'jsonl-entry', 'jsonl-error', 'process-state', 'conditions', 'semantic-event', 'exit', 'transcript-diagnostic'] as const

let dir: string
let cleanups: Array<() => Promise<void> | void> = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oc-terminal-adapter-'))
  cleanups = []
})
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  rmSync(dir, { recursive: true, force: true })
})

async function launchAdapter(recording: LiveFixture) {
  const dbPath = join(dir, `${recording.scenario}-${cleanups.length}.db`)
  const writer = new LiveFixtureWriter(dbPath, recording.sessionID, sessionRowFor(recording.sessionID))
  const server = new ReplayServer({ username: 'opencode', password: PASSWORD })
  await server.listen()
  const pty = new AdapterPty()
  const session = new OpencodeTerminalSession(
    { cwd: '/sandbox/project', resumeSessionId: recording.sessionID },
    {
      spawnPty: (() => pty) as never,
      prepareLaunch: async (opts): Promise<OpencodeTerminalLaunch> => ({
        binary: opts.binary,
        args: ['--session', opts.sessionID, '--hostname', '127.0.0.1', '--port', new URL(server.url).port],
        env: { ...opts.env, OPENCODE_SERVER_USERNAME: 'opencode', OPENCODE_SERVER_PASSWORD: PASSWORD },
        sessionID: opts.sessionID,
        server: { url: server.url, username: 'opencode', password: PASSWORD },
        dbPath,
      }),
      headlessOptions: { heartbeatMs: 0, durablePollIntervalMs: 40, sseInitialBackoffMs: 20, sseMaxBackoffMs: 80 },
    },
  )
  const events: Event[] = []
  for (const name of EVENT_NAMES) session.on(name as never, ((...args: unknown[]) => events.push({ name, args })) as never)
  cleanups.push(async () => {
    await session.stop()
    await server.close()
    writer.close()
  })
  await session.start()
  await waitUntil(() => events.some(e => e.name === 'transcript-diagnostic' && (e.args[0] as { connected?: boolean }).connected === true), 5000, 'live channel')
  await waitUntil(() => server.calls.some(c => c.path === '/question'), 5000, 're-sync')
  await settle(20)
  return { session, events, writer, server, pty, script: buildReplayScript(recording) }
}

const semanticOf = (events: Event[]) => events.filter(e => e.name === 'semantic-event').map(e => e.args[0] as { type: string; turnId?: string; phase?: string; fullText?: string })
const processStates = (events: Event[]) => events.filter(e => e.name === 'process-state').map(e => e.args[0] as { active: boolean; status?: string })
const committed = (events: Event[]) =>
  events
    .filter(e => e.name === 'jsonl-entry' && (e.args[0] as { info?: unknown }).info)
    .map(e => ({ record: e.args[0] as { info: { id: string; role: string; sessionID: string } }, file: e.args[1] as string }))

function statusSpans(recording: LiveFixture): number {
  let spans = 0
  let busy = false
  for (const { event } of recording.sse) {
    if (event.properties?.sessionID !== recording.sessionID) continue
    const type = event.type === 'session.idle' ? 'idle' : event.type === 'session.status' ? (event.properties.status as { type: string }).type : null
    if ((type === 'busy' || type === 'retry') && !busy) { busy = true; spans += 1 }
    if (type === 'idle') busy = false
  }
  return spans
}

function committableIds(recording: LiveFixture): Set<string> {
  const roles = new Map<string, { role: string; completed: boolean }>()
  const withParts = new Set<string>()
  for (const row of recording.durable) {
    if (row.aggregateID !== recording.sessionID) continue
    if (row.type === 'message.updated.1') {
      const info = row.data.info as { id: string; role: string; time?: { completed?: number } }
      roles.set(info.id, { role: info.role, completed: typeof info.time?.completed === 'number' })
    }
    if (row.type === 'message.part.updated.1') withParts.add(String((row.data.part as { messageID: string }).messageID))
  }
  return new Set([...roles].filter(([id, r]) => (r.role === 'user' && withParts.has(id)) || (r.role === 'assistant' && r.completed)).map(([id]) => id))
}

describe('OpencodeTerminalSession over recorded TUI sessions (real package, real sockets, real SQLite)', () => {
  for (const name of listLiveFixtures().filter(n => n !== 'port-conflict.json')) {
    it(`${name}: delivers the AgentSession contract in the order main and the renderer rely on`, async () => {
      const recording = loadLiveFixture(name)
      const { session, events, writer, server, script } = await launchAdapter(recording)
      await playReplay(script, writer, server)
      await waitUntil(() => processStates(events).at(-1)?.active === false && semanticOf(events).some(e => e.type === 'turn_completed'), 5000, 'turn end')
      await settle(60)

      expect(events.filter(e => e.name === 'jsonl-error')).toEqual([])
      expect(events.filter(e => e.name === 'started')).toHaveLength(1)

      // Identity first (fresh-session capture path), then committed records
      // on the pane's transcript locator, exactly the committable ones, once.
      const firstEntry = events.find(e => e.name === 'jsonl-entry')!
      expect(firstEntry.args).toEqual([{ sessionID: recording.sessionID }, `opencode://session/${recording.sessionID}`])
      const records = committed(events)
      expect(new Set(records.map(r => r.file))).toEqual(new Set([`opencode://session/${recording.sessionID}`]))
      expect(records.map(r => r.record.info.id)).toHaveLength(new Set(records.map(r => r.record.info.id)).size)
      expect(new Set(records.map(r => r.record.info.id))).toEqual(committableIds(recording))

      // Turns and activity.
      const semantic = semanticOf(events)
      const starts = semantic.filter(e => e.type === 'turn_started')
      expect(starts).toHaveLength(statusSpans(recording))
      expect(semantic.filter(e => e.type === 'turn_completed').map(e => e.turnId)).toEqual(starts.map(e => e.turnId))
      let open = false
      for (const event of events) {
        const payload = event.args[0] as { type?: string; active?: boolean }
        if (event.name === 'semantic-event' && payload.type === 'turn_started') open = true
        if (event.name === 'semantic-event' && payload.type === 'turn_completed') open = false
        if (event.name === 'process-state' && open) expect(payload.active).toBe(true)
      }
      expect(processStates(events).some(state => state.active)).toBe(true)

      // The order orchestration completion is decided from.
      const index = (predicate: (e: Event) => boolean, from = 0) => events.findIndex((e, i) => i >= from && predicate(e))
      let from = 0
      for (let turn = 0; turn < starts.length; turn += 1) {
        const completedAt = index(e => e.name === 'semantic-event' && (e.args[0] as { type: string }).type === 'turn_completed', from)
        const answerAt = events.slice(0, completedAt).map((e, i) => ({ e, i })).filter(({ e }) => e.name === 'jsonl-entry' && (e.args[0] as { info?: { role?: string } }).info?.role === 'assistant').at(-1)?.i ?? -1
        const idleAt = index(e => e.name === 'semantic-event' && (e.args[0] as { phase?: string }).phase === 'idle', completedAt)
        const inactiveAt = index(e => e.name === 'process-state' && !(e.args[0] as { active: boolean }).active, idleAt)
        expect(answerAt).toBeGreaterThanOrEqual(0)
        expect(answerAt).toBeLessThan(completedAt)
        expect(idleAt).toBeGreaterThan(completedAt)
        expect(inactiveAt).toBeGreaterThan(idleAt)
        from = inactiveAt + 1
      }

      // Conditions arrive in Agent Code's ProviderConditionSnapshot shape.
      const snapshots = events.filter(e => e.name === 'conditions').map(e => e.args[0] as ProviderConditionSnapshot)
      expect(snapshots[0]).toMatchObject({ provider: 'opencode', conditions: {} })
      expect(snapshots.at(-1)!.conditions).toEqual({})
      const asked = recording.sse.find(({ event }) => event.type === 'permission.asked' || event.type === 'question.asked')?.event
      if (asked) {
        const kind = asked.type === 'permission.asked' ? 'opencode.permission' : 'opencode.question'
        expect(snapshots.some(s => s.conditions[kind])).toBe(true)
      }
      expect(session.isExited()).toBe(false)
    })
  }

  it('answers a recorded permission through resolveCondition, the path SessionManager uses', async () => {
    const recording = loadLiveFixture('permission-once.json')
    const asked = recording.sse.find(({ event }) => event.type === 'permission.asked')!.event
    const { session, events, writer, server, script } = await launchAdapter(recording)
    let answered = false
    await playReplay(script, writer, server, {
      beforeStep: async (step: ReplayStep) => {
        if (answered || step.kind !== 'sse' || step.event.type !== 'permission.replied') return
        answered = true
        await settle(30)
        const snapshot = events.filter(e => e.name === 'conditions').map(e => e.args[0] as ProviderConditionSnapshot).at(-1)!
        const once = snapshot.conditions['opencode.permission']!.actions.find(action => action.label === 'Allow once') as ConditionCustomAction
        await expect(session.resolveCondition(once)).resolves.toEqual({ ok: true })
      },
    })
    expect(answered).toBe(true)
    expect(server.calls.filter(c => c.method === 'POST')).toEqual([
      { method: 'POST', path: `/permission/${asked.properties!.id}/reply`, body: '{"reply":"once"}', authorized: true },
    ])
  })

  it('reports the closing turn before exit when the TUI dies mid-turn', async () => {
    const recording = loadLiveFixture('plain.json')
    const { events, writer, server, pty, script } = await launchAdapter(recording)
    const busyAt = script.findIndex(step => step.kind === 'sse' && step.event.type === 'session.status' && (step.event.properties?.status as { type: string }).type === 'busy')
    await playReplay(script.slice(0, busyAt + 1), writer, server)
    await waitUntil(() => processStates(events).some(state => state.active), 3000, 'busy')
    pty.exit(137, 9)
    await settle(30)
    const names = events.map(e => (e.name === 'semantic-event' ? `semantic:${(e.args[0] as { type: string }).type}` : e.name))
    const exitAt = names.indexOf('exit')
    expect(exitAt).toBeGreaterThan(names.indexOf('semantic:turn_completed'))
    expect(processStates(events).at(-1)).toEqual({ active: false })
    expect(events[exitAt]!.args[0]).toEqual({ exitCode: 137, signal: 9 })
    expect(names.filter(name => name === 'exit')).toHaveLength(1)
  })
})
