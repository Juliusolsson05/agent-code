import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PiTerminalLaunch } from 'pi-terminal-headless'
import {
  createReplaySandbox,
  FakePty,
  listLiveFixtures,
  loadLiveFixture,
  playReplay,
  referenceActiveBranch,
  waitUntil,
  type LiveFixture,
  type ReplaySandbox,
} from 'pi-terminal-headless/testing/index'

// Agent Code imports node-pty at module level and its copy is built for
// Electron's ABI; the adapter's spawn is injected below, so the module itself
// only has to be importable.
vi.mock('node-pty', () => ({ spawn: vi.fn() }))

import type { SessionOptions } from '@shared/types/session.js'

import { PiSession } from './piSession.js'
import { deliverPiPrompt } from './promptDelivery.js'

// The Pi adapter end to end: each Stage 0 recording of the real pi 0.87.1 TUI
// is re-enacted (a real Unix socket for the bridge, the real session file
// written in pi's own order) through the REAL pi-terminal-headless package and
// the REAL adapter, and the AgentSession events SessionManager receives are
// checked against the contract the renderer and orchestration depend on:
//
//   jsonl-entry     identity envelope first, then the active branch's rows
//   process-state   active during a run, idle after, never idle mid-run
//   semantic-event  turn_started / turn_completed paired, answer first
//   history-boundary + provider-session-changed on /new and /fork
//   jsonl-error     the bridge never connected (degraded, not broken)
//
// Expectations come from each recording's own facts, never from the adapter.

class AdapterPty extends FakePty {
  readonly kill = vi.fn(() => this.exit(0, 15))
  onData(): { dispose(): void } {
    return { dispose: () => undefined }
  }
}

type Event = { name: string; args: unknown[] }
const EVENT_NAMES = ['started', 'input-readiness', 'jsonl-entry', 'jsonl-error', 'process-state', 'conditions', 'semantic-event', 'history-boundary', 'provider-session-changed', 'transcript-diagnostic', 'exit'] as const

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function launch(fixture: LiveFixture, options: { noBridge?: boolean; resumeExisting?: string; sessionOptions?: Partial<SessionOptions> } = {}) {
  const sandbox: ReplaySandbox = createReplaySandbox(fixture, options.resumeExisting ? { resumeExisting: options.resumeExisting } : {})
  cleanups.push(() => sandbox.cleanup())
  const pty = new AdapterPty()
  const prepareLaunch = vi.fn(async (): Promise<PiTerminalLaunch> => sandbox.launch)
  const session = new PiSession(
    { cwd: sandbox.launch.cwd, ...(options.resumeExisting ? { resumeSessionId: fixture.sessionIdLaunched! } : {}), ...options.sessionOptions },
    {
      spawnPty: (() => pty) as never,
      prepareLaunch: prepareLaunch as never,
      bridgeScriptPath: '/staged/bridge.ts',
      newSessionId: () => fixture.sessionIdLaunched!,
      headlessOptions: { heartbeatMs: 0, fastPollMs: 20, slowPollMs: 200, discoverPollMs: 20, bridgeConnectDeadlineMs: 400 },
    },
  )
  const events: Event[] = []
  for (const name of EVENT_NAMES) session.on(name as never, ((...args: unknown[]) => events.push({ name, args })) as never)
  cleanups.push(() => session.stop())
  await session.start()
  await playReplay(fixture, sandbox, options.noBridge ? { noBridge: true } : {})
  return { session, events, pty, sandbox, prepareLaunch }
}

const named = (events: Event[], name: string) => events.filter(e => e.name === name)
const semanticTypes = (events: Event[]) => named(events, 'semantic-event').map(e => (e.args[0] as { type: string }).type)

describe('PiSession over the recordings', () => {
  it('launches through the package helper with the minted id and the staged bridge, and binds identity before pi writes anything', async () => {
    const fixture = loadLiveFixture('plain')
    const { events, prepareLaunch, session } = await launch(fixture)
    expect(prepareLaunch).toHaveBeenCalledWith(expect.objectContaining({ sessionId: fixture.sessionIdLaunched, bridgeScriptPath: '/staged/bridge.ts', binary: 'pi' }))
    const first = named(events, 'jsonl-entry')[0]!
    expect(first.args[0]).toEqual({ type: 'agent-code-identity', sessionId: fixture.sessionIdLaunched })
    expect(session.getProviderSessionId()).toBe(fixture.sessionIdLaunched)
    const startedAt = events.findIndex(e => e.name === 'started')
    expect(startedAt).toBeGreaterThan(-1)
  })

  it('hands the built-in MCP endpoints to the bridge through the launch env, and a caller override cannot shadow the minted bearer', async () => {
    const fixture = loadLiveFixture('plain')
    const { prepareLaunch } = await launch(fixture, { sessionOptions: {
      builtInMcpServers: [{ name: 'agent_code', url: 'http://127.0.0.1:1/mcp/pane', bearerToken: 'minted', headers: {} }],
      env: { AGENT_CODE_MCP_0_0: 'stale-from-caller' },
    } })
    const env = (prepareLaunch.mock.calls[0] as unknown as [{ env: Record<string, string> }])[0].env
    expect(JSON.parse(env.AGENT_CODE_PI_MCP_SERVERS!)).toEqual([{ name: 'agent_code', url: 'http://127.0.0.1:1/mcp/pane', headerEnv: { Authorization: 'AGENT_CODE_MCP_0_0' } }])
    expect(env.AGENT_CODE_MCP_0_0).toBe('Bearer minted')
  })

  const sweep = listLiveFixtures().map(n => n.replace(/\.json$/, '')).filter(name => !['trust', 'resume', 'kill'].includes(name))
  for (const name of sweep) {
    it(`${name}: rows of the active branch, busy only inside runs, every turn completes after its answer`, async () => {
      const fixture = loadLiveFixture(name)
      const { events } = await launch(fixture)
      const settles = fixture.events.filter(e => e.name === 'agent_settled').length
      await waitUntil(() => semanticTypes(events).filter(t => t === 'turn_completed').length >= settles, 5000, 'turns')
      const lastFile = [...fixture.events].reverse().find(e => e.name === 'session_start')!.sessionFile as string
      const expected = referenceActiveBranch(fixture.files[lastFile]!).map(row => row.id)
      await waitUntil(() => expected.every(id => named(events, 'jsonl-entry').some(e => (e.args[0] as { id?: string }).id === id)), 5000, 'rows')

      // Busy only inside a run.
      let open = false
      for (const event of events) {
        if (event.name === 'semantic-event') {
          const type = (event.args[0] as { type: string }).type
          if (type === 'turn_started') open = true
          if (type === 'turn_completed') open = false
        }
        if (event.name === 'process-state' && (event.args[0] as { active: boolean }).active === true) expect(open).toBe(true)
      }
      // The answer (the leaf pi reported at agent_settled) precedes each turn_completed.
      const leaves = fixture.events.filter(e => e.name === 'agent_settled').map(e => e.leafId as string)
      const completed = events.flatMap((e, i) => (e.name === 'semantic-event' && (e.args[0] as { type: string }).type === 'turn_completed' ? [i] : []))
      leaves.forEach((leaf, turn) => {
        const at = events.findIndex(e => e.name === 'jsonl-entry' && (e.args[0] as { id?: string }).id === leaf)
        expect(at).toBeGreaterThan(-1)
        expect(at).toBeLessThan(completed[turn]!)
      })
      // Programmatic delivery became possible once the bridge connected.
      expect(named(events, 'input-readiness').some(e => (e.args[0] as { ready: boolean }).ready === true)).toBe(true)
    })
  }

  it('/new: the pane follows pi into the new session — identity change, then a fresh history generation', async () => {
    const fixture = loadLiveFixture('new-session')
    const { events, session, sandbox } = await launch(fixture)
    const second = fixture.events.filter(e => e.name === 'session_start')[1]!
    await waitUntil(() => named(events, 'provider-session-changed').length === 1, 5000, 'switch')
    expect(named(events, 'provider-session-changed')[0]!.args[0]).toEqual({
      providerSessionId: second.sessionId,
      transcriptFile: sandbox.mapPath(second.sessionFile as string),
      reason: 'new',
    })
    expect(session.getProviderSessionId()).toBe(second.sessionId)
    // The identity moves BEFORE the reset of the window it applies to.
    const changedAt = events.findIndex(e => e.name === 'provider-session-changed')
    const resetAt = events.findIndex((e, i) => i > changedAt && e.name === 'history-boundary' && (e.args[0] as { type: string }).type === 'reset')
    expect(resetAt).toBeGreaterThan(changedAt)
    // Generations only ever grow (the shared boundary gate ignores a repeat).
    const generations = named(events, 'history-boundary').map(e => (e.args[0] as { generation: number }).generation)
    expect([...generations].sort((a, b) => a - b)).toEqual(generations)
  })

  it('no bridge: the conversation still arrives, delivery refuses as not-ready, and the pane says why once', async () => {
    const fixture = loadLiveFixture('tool')
    const { events, session } = await launch(fixture, { noBridge: true })
    const [file] = Object.keys(fixture.files)
    const expected = referenceActiveBranch(fixture.files[file!]!).map(row => row.id)
    await waitUntil(() => expected.every(id => named(events, 'jsonl-entry').some(e => (e.args[0] as { id?: string }).id === id)), 5000, 'rows via scan')
    await waitUntil(() => named(events, 'jsonl-error').length > 0, 3000, 'banner')
    expect(named(events, 'jsonl-error').map(e => (e.args[0] as Error).message)).toEqual([expect.stringContaining('(provider_bridge_unreachable)')])
    expect(semanticTypes(events)).toEqual([])
    await expect(session.deliverPromptText('hi')).rejects.toMatchObject({ code: 'pi-terminal-not-ready' })
    // …which the delivery policy reports as safe to retry on the same pane.
    const result = await deliverPiPrompt({ session, sessionId: 'pane', prompt: 'hi' } as never)
    expect(result).toMatchObject({ ok: false, code: 'not-ready', retrySafe: true, promptWritten: false })
  })

  // #1315: orchestration delivers a child's bootstrap prompt right after
  // spawn, before the bridge extension has connected. It used to fail at
  // once with "the Pi bridge is not connected" (5 of 5 Pi children on
  // 2026-09-25); a retry seconds later always worked.
  it('a prompt sent before the bridge connects waits for it instead of failing', async () => {
    const fixture = loadLiveFixture('plain')
    const sandbox: ReplaySandbox = createReplaySandbox(fixture)
    cleanups.push(() => sandbox.cleanup())
    const session = new PiSession({ cwd: sandbox.launch.cwd }, {
      spawnPty: (() => new AdapterPty()) as never,
      prepareLaunch: (async () => sandbox.launch) as never,
      bridgeScriptPath: '/staged/bridge.ts',
      newSessionId: () => fixture.sessionIdLaunched!,
      headlessOptions: { heartbeatMs: 0, fastPollMs: 20, slowPollMs: 200, discoverPollMs: 20, bridgeConnectDeadlineMs: 5_000 },
    })
    cleanups.push(() => session.stop())
    await session.start()
    const delivery = session.deliverPromptText('hi').then(() => null, (error: Error) => error)
    // The bridge connects only now. The replay rig answers every request
    // with a refusal, so reaching it is exactly what a non-"not connected"
    // outcome proves.
    await playReplay(fixture, sandbox)
    const error = await delivery
    expect(error?.message ?? '').not.toContain('not connected')
    expect(error).toMatchObject({ code: 'pi-terminal-rejected' })
  })

  it('a prompt pi refused before it was sent (e.g. mid-compaction) is safe to retry; an unknown outcome is not', async () => {
    const refusing = { deliverPromptText: async () => { throw Object.assign(new Error('pi is compacting this session'), { code: 'pi-terminal-rejected' }) } }
    expect(await deliverPiPrompt({ session: refusing, sessionId: 'pane', prompt: 'hi' } as never))
      .toMatchObject({ ok: false, stage: 'before-write', retrySafe: true, disposition: 'retry-same-session', promptWritten: false })
    // One of pi's own TUI commands: nothing reached pi (retrySafe), but no
    // retry can ever run it, so an orchestration parent must not be told to
    // retry (review of pi-terminal-headless#2).
    const tuiCommand = { deliverPromptText: async () => { throw Object.assign(new Error('/new is a pi TUI command; type it in the pi pane'), { code: 'pi-terminal-tui-command' }) } }
    expect(await deliverPiPrompt({ session: tuiCommand, sessionId: 'pane', prompt: '/new' } as never))
      .toMatchObject({ ok: false, stage: 'before-write', code: 'missing-capability', retrySafe: true, disposition: 'do-not-retry', promptWritten: false, message: expect.stringContaining('type it in the pi pane') })
    const unknown = { deliverPromptText: async () => { throw new Error('pi prompt delivery outcome is unknown') } }
    expect(await deliverPiPrompt({ session: unknown, sessionId: 'pane', prompt: 'hi' } as never))
      .toMatchObject({ ok: false, retrySafe: false, disposition: 'do-not-retry', promptWritten: true })
  })

  it('exit: the headless closes the open turn before the adapter reports exit; stop is idempotent', async () => {
    const fixture = loadLiveFixture('kill')
    const { events, pty, session } = await launch(fixture)
    pty.exit(0, 9)
    await waitUntil(() => named(events, 'exit').length === 1, 5000, 'exit')
    const starts = semanticTypes(events).filter(t => t === 'turn_started').length
    expect(semanticTypes(events).filter(t => t === 'turn_completed')).toHaveLength(starts)
    const exitAt = events.findIndex(e => e.name === 'exit')
    expect(events.slice(0, exitAt).reverse().find(e => e.name === 'process-state')!.args[0]).toMatchObject({ active: false })
    expect(session.isExited()).toBe(true)
    await session.stop()
    await session.stop()
  })
})

// Astra review finding 4: the prepared launch has no owner until the headless
// exists. A spawn that throws must still remove its temp directory, and the
// caller's stop() afterwards must be harmless.
describe('PiSession launch ownership', () => {
  it('disposes the prepared launch when the pty fails to spawn', async () => {
    const dispose = vi.fn(async () => undefined)
    const launch = { binary: 'pi', args: [], env: {}, cwd: '/repo', dispose } as unknown as PiTerminalLaunch
    const session = new PiSession({ cwd: '/repo' }, {
      spawnPty: (() => { throw new Error('posix_spawnp failed') }) as never,
      prepareLaunch: (async () => launch) as never,
      bridgeScriptPath: '/staged/bridge.ts',
      newSessionId: () => 'fresh',
    })
    await expect(session.start()).rejects.toThrow('posix_spawnp failed')
    await session.stop()
    expect(dispose).toHaveBeenCalledOnce()
  })
})
