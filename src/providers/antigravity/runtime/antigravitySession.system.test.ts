import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { SessionOptions } from '@shared/types/session.js'
import type { ConditionCustomAction } from '@shared/types/providerConditions.js'
import { ANTIGRAVITY_PERMISSION_RESPOND, AntigravitySession } from './antigravitySession.js'
import { liveAntigravityRows, loadAntigravityHistoryChunk } from './antigravityHistory.js'
import { deliverAntigravityPrompt } from './promptDelivery.js'

// The Antigravity adapter end to end over a scripted `agy acp` stand-in: the
// REAL AntigravitySession drives the REAL antigravity-acp-headless package
// over real newline-delimited JSON-RPC on PassThrough streams; only the child
// process is fake (deps.spawn). Frame shapes follow the recordings the
// package's own system test uses (agy 1.5.15: initialize, session/new,
// session/load replay, session/prompt with session/request_permission).
//
// The contract checked is what SessionManager and the renderer depend on:
//   jsonl-entry          identity envelope at bind, then every committed row
//                        under the `antigravity://session/<id>` locator
//   input-readiness      not ready while starting, ready once bound
//   conditions           a permission card whose custom action resolves
//                        through resolveCondition (and ONLY while still open)
//   provider-session-changed  a resume of a conversation agy lost
//   exit / jsonl-error   agy dying on its own vs. being stopped
// Nothing here ever runs the real `agy` binary.

type Frame = Record<string, unknown> & { id?: string | number; method?: string; params?: any; result?: any }
type Script = (frame: Frame, agy: FakeAgy) => void

const INIT = { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] }

/** A child process stand-in: stdin is what Agent Code writes, stdout what agy answers. */
class FakeAgy extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly pid = 4242
  readonly sent: Frame[] = []
  exited = false
  private buffer = ''
  readonly kill = vi.fn(() => {
    this.exit(null, 'SIGTERM')
    return true
  })

  constructor(private readonly script: Script) {
    super()
    this.stdin.setEncoding('utf8')
    this.stdin.on('data', (chunk: string) => {
      this.buffer += chunk
      let newline = this.buffer.indexOf('\n')
      while (newline !== -1) {
        const frame = JSON.parse(this.buffer.slice(0, newline)) as Frame
        this.buffer = this.buffer.slice(newline + 1)
        this.sent.push(frame)
        this.script(frame, this)
        newline = this.buffer.indexOf('\n')
      }
    })
  }

  send(frame: Frame): void {
    if (!this.exited) this.stdout.write(JSON.stringify(frame) + '\n')
  }

  reply(frame: Frame, result: unknown): void {
    this.send({ jsonrpc: '2.0', id: frame.id, result })
  }

  update(sessionId: string, update: Record<string, unknown>): void {
    this.send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } })
  }

  /** The process goes away: its stdout closes, then 'exit' (as Node orders it). */
  exit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) return
    this.exited = true
    this.stdout.end()
    setImmediate(() => this.emit('exit', code, signal))
  }

  methods(): string[] {
    return this.sent.flatMap(frame => (typeof frame.method === 'string' ? [frame.method] : []))
  }
}

const text = (sessionUpdate: string, value: string) => ({ sessionUpdate, content: { type: 'text', text: value } })

/** initialize + session/new (+ session/load replays), then the test's own handler. */
function agyScript(options: { newSessionId?: string; replays?: Record<string, Array<Record<string, unknown>>>; onFrame?: Script } = {}): Script {
  return (frame, agy) => {
    if (frame.method === 'initialize') return agy.reply(frame, INIT)
    if (frame.method === 'session/new') return agy.reply(frame, { sessionId: options.newSessionId ?? 'sess-1', models: {} })
    if (frame.method === 'session/load') {
      for (const update of options.replays?.[frame.params.sessionId] ?? []) agy.update(frame.params.sessionId, update)
      return agy.reply(frame, { sessionId: frame.params.sessionId })
    }
    options.onFrame?.(frame, agy)
  }
}

type Event = { name: string; args: unknown[] }
const EVENT_NAMES = ['started', 'input-readiness', 'jsonl-entry', 'jsonl-error', 'process-state', 'conditions', 'semantic-event', 'history-boundary', 'provider-session-changed', 'transcript-diagnostic', 'exit'] as const

const PROXY_SCRIPT = '/Applications/Agent Code.app/Contents/Resources/app.asar.unpacked/out/main/runtime/antigravity/mcpProxy.mjs'
const SCRIPT_RUNNER = '/Applications/Agent Code.app/Contents/MacOS/Agent Code'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function create(script: Script, options: Partial<SessionOptions> = {}, existing: string[] = []) {
  const spawned: Array<{ binary: string; args: string[]; cwd: string; env: Record<string, string> }> = []
  const children: FakeAgy[] = []
  const conversationExists = vi.fn((id: string) => existing.includes(id))
  const session = new AntigravitySession({ cwd: '/work/project', ...options }, {
    spawn: (binary, args, spawnOptions) => {
      spawned.push({ binary, args, ...spawnOptions })
      const child = new FakeAgy(script)
      children.push(child)
      return child as unknown as ChildProcessWithoutNullStreams
    },
    mcpProxyScript: PROXY_SCRIPT,
    scriptRunner: SCRIPT_RUNNER,
    conversationExists,
  })
  const events: Event[] = []
  for (const name of EVENT_NAMES) session.on(name as never, ((...args: unknown[]) => events.push({ name, args })) as never)
  cleanups.push(() => session.stop())
  return { session, events, spawned, conversationExists, agy: () => children[0]! }
}

async function launch(script: Script, options: Partial<SessionOptions> = {}, existing: string[] = []) {
  const created = create(script, options, existing)
  await created.session.start()
  return created
}

const named = (events: Event[], name: string) => events.filter(event => event.name === name)
const indexOf = (events: Event[], predicate: (event: Event) => boolean) => events.findIndex(predicate)
const isIdentity = (sessionId: string) => (event: Event) =>
  event.name === 'jsonl-entry' && (event.args[0] as { type?: string; sessionId?: string }).type === 'antigravity-identity' && (event.args[0] as { sessionId?: string }).sessionId === sessionId
const rowEntries = (events: Event[]) => named(events, 'jsonl-entry').filter(event => (event.args[0] as { type?: string }).type === 'antigravity-row')
const semanticTypes = (events: Event[]) => named(events, 'semantic-event').map(event => (event.args[0] as { type: string }).type)
const lastConditions = (events: Event[]) => named(events, 'conditions').at(-1)?.args[0] as { conditions: Record<string, { state: any; actions: ConditionCustomAction[] }> } | undefined
const waitFor = <T>(check: () => T) => vi.waitFor(check, { timeout: 2000, interval: 5 })

// agy 1.5.18's initialize response advertises promptCapabilities.image. Exercise
// the composer delivery boundary through the real ACP writer and its live rows.
it.each(['', 'Describe this'])('sends embedded clipboard bytes to agy with caption %j', async caption => {
  const { session, agy, events } = await launch((frame, child) => {
    if (frame.method === 'initialize') return child.reply(frame, { ...INIT, agentCapabilities: { promptCapabilities: { image: true } } })
    if (frame.method === 'session/prompt') return child.reply(frame, { stopReason: 'end_turn' })
    return agyScript()(frame, child)
  })
  const result = await deliverAntigravityPrompt({
    session, sessionId: 'pane', prompt: caption, write: () => false,
    inlineImages: [{ base64Data: 'iVBORw0KGgo=', mediaType: 'image/png' }],
  })
  expect(result.ok).toBe(true)
  expect(agy().sent.find(f => f.method === 'session/prompt')?.params.prompt).toEqual([
    ...(caption ? [{ type: 'text', text: caption }] : []),
    { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
  ])
  expect(events.find(e => e.name === 'jsonl-entry' && (e.args[0] as { role?: string }).role === 'user')?.args[0]).toMatchObject({
    text: caption || '[Image attached]',
  })
})

it('restores image-only and captioned image prompts without retaining image bytes in rows', async () => {
  const image = { sessionUpdate: 'user_message_chunk', content: { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' } }
  const { events } = await launch(agyScript({ replays: { 'conv-images': [
    image, text('agent_message_chunk', 'one'), image, text('user_message_chunk', 'caption'),
  ] } }), { resumeSessionId: 'conv-images' }, ['conv-images'])
  const prompts = events.filter(e => e.name === 'jsonl-entry' && (e.args[0] as { role?: string }).role === 'user').map(e => e.args[0] as { text: string })
  expect(prompts.map(row => row.text)).toEqual(['[Image attached]', 'caption'])
  expect(JSON.stringify(prompts)).not.toContain('iVBORw0KGgo=')
})

describe('AntigravitySession start', () => {
  it('a fresh start spawns `agy acp`, creates a session, and binds identity before reporting ready', async () => {
    const { session, events, spawned, conversationExists, agy } = await launch(agyScript(), {
      env: { AGENT_CODE_ANTIGRAVITY_TEST: 'yes', HOME: undefined },
    })

    expect(spawned).toHaveLength(1)
    expect(spawned[0]).toMatchObject({ binary: 'agy', args: ['acp'], cwd: '/work/project' })
    // Caller env is layered over the app env; `undefined` removes a variable.
    expect(spawned[0]!.env.AGENT_CODE_ANTIGRAVITY_TEST).toBe('yes')
    expect('HOME' in spawned[0]!.env).toBe(false)

    expect(agy().methods()).toEqual(['initialize', 'session/new'])
    expect(agy().sent[0]!.params.clientInfo).toEqual({ name: 'agent-code', version: '1' })
    expect(agy().sent[1]!.params).toEqual({ cwd: '/work/project', mcpServers: [] })
    // No resume requested → agy's store is never consulted.
    expect(conversationExists).not.toHaveBeenCalled()

    expect(events[0]).toEqual({ name: 'input-readiness', args: [{ ready: false, reason: 'starting' }] })
    const identity = indexOf(events, isIdentity('sess-1'))
    expect(identity).toBeGreaterThan(-1)
    expect(events[identity]!.args).toEqual([{ type: 'antigravity-identity', sessionId: 'sess-1' }, 'antigravity://session/sess-1'])
    const ready = indexOf(events, event => event.name === 'input-readiness' && (event.args[0] as { ready: boolean }).ready)
    expect(events[ready]!.args[0]).toEqual({ ready: true, reason: 'ready' })
    const started = indexOf(events, event => event.name === 'started')
    expect(identity).toBeLessThan(ready)
    expect(ready).toBeLessThan(started)
    expect(named(events, 'provider-session-changed')).toEqual([])

    expect(session.getProviderSessionId()).toBe('sess-1')
    expect(session.getTranscriptFile()).toBe('antigravity://session/sess-1')
    expect(session.getProcessPid()).toBe(4242)
    expect(session.isExited()).toBe(false)
    // The live history source is registered at bind and dropped at stop.
    expect(liveAntigravityRows('sess-1')).toEqual([])
    await session.stop()
    expect(liveAntigravityRows('sess-1')).toBeNull()
  })

  it('resuming a conversation agy still holds replays it between a history reset and caught-up', async () => {
    const replays = { 'conv-7': [text('user_message_chunk', 'earlier prompt'), text('agent_message_chunk', 'earlier answer')] }
    const { session, events, agy, conversationExists } = await launch(agyScript({ replays }), { resumeSessionId: 'conv-7' }, ['conv-7'])

    // Checked against the PANE's environment, not main's.
    expect(conversationExists).toHaveBeenCalledWith('conv-7', expect.objectContaining({ PATH: expect.any(String) }))
    expect(agy().methods()).toEqual(['initialize', 'session/load'])
    expect(agy().sent[1]!.params).toEqual({ sessionId: 'conv-7', cwd: '/work/project', mcpServers: [] })
    const order = events
      .filter(event => event.name === 'history-boundary' || (event.name === 'jsonl-entry' && (event.args[0] as { type: string }).type === 'antigravity-row'))
      .map(event => (event.name === 'history-boundary' ? (event.args[0] as { type: string }).type : (event.args[0] as { key: string }).key))
    expect(order).toEqual(['reset', 'ag:conv-7:0', 'ag:conv-7:1', 'caught-up'])
    // Generations carry a wall-clock base so a reloaded pane's reset is always
    // newer than the previous session's (the renderer drops a stale one, and
    // the replayed rows then dedupe away: an empty pane, seen in the dev app).
    const boundaries = named(events, 'history-boundary').map(event => event.args[0] as { type: string; generation: number })
    expect(boundaries.map(boundary => boundary.type)).toEqual(['reset', 'caught-up'])
    expect(boundaries[0]!.generation).toBe(boundaries[1]!.generation)
    expect(boundaries[0]!.generation).toBeGreaterThan(Date.now() * 1000 - 60_000_000)
    expect(named(events, 'history-boundary').map(event => event.args[0])).toEqual([
      { type: 'reset', generation: boundaries[0]!.generation, snapshotByteLength: 0, complete: false, file: 'antigravity://session/conv-7' },
      { type: 'caught-up', generation: boundaries[0]!.generation, snapshotByteLength: 0, complete: true, file: 'antigravity://session/conv-7' },
    ])
    expect(rowEntries(events).every(event => event.args[1] === 'antigravity://session/conv-7')).toBe(true)
    expect(named(events, 'provider-session-changed')).toEqual([])
    expect(indexOf(events, isIdentity('conv-7'))).toBeGreaterThan(-1)
    expect(session.getProviderSessionId()).toBe('conv-7')
    expect(liveAntigravityRows('conv-7')?.map(row => row.text)).toEqual(['earlier prompt', 'earlier answer'])
  })

  it('resuming a conversation agy no longer holds starts a new one and says so before binding it', async () => {
    const { session, events, agy, conversationExists } = await launch(agyScript({ newSessionId: 'fresh-1' }), { resumeSessionId: 'gone-conv' })

    expect(conversationExists).toHaveBeenCalledWith('gone-conv', expect.any(Object))
    expect(agy().methods()).toEqual(['initialize', 'session/new'])
    const changed = named(events, 'provider-session-changed')
    expect(changed.map(event => event.args[0])).toEqual([{
      providerSessionId: 'fresh-1',
      transcriptFile: 'antigravity://session/fresh-1',
      reason: 'antigravity-conversation-missing',
    }])
    expect(indexOf(events, event => event.name === 'provider-session-changed')).toBeLessThan(indexOf(events, isIdentity('fresh-1')))
    // The pane still showed the conversation it asked for: a conversation-
    // changed reset clears it for the new one.
    expect(named(events, 'history-boundary').map(event => {
      const { generation: _generation, ...rest } = event.args[0] as Record<string, unknown>
      return rest
    })).toEqual([
      { type: 'reset', snapshotByteLength: 0, complete: false, conversationChanged: true, file: 'antigravity://session/fresh-1' },
      { type: 'caught-up', snapshotByteLength: 0, complete: true, file: 'antigravity://session/fresh-1' },
    ])
    expect(session.getProviderSessionId()).toBe('fresh-1')
    expect(session.getTranscriptFile()).toBe('antigravity://session/fresh-1')
  })

  it('an agy that refuses initialize fails start with a sign-in hint and is killed', async () => {
    const { session, events, agy } = create((frame, child) => {
      if (frame.method === 'initialize') child.send({ jsonrpc: '2.0', id: frame.id, error: { code: -32000, message: 'Authentication required' } })
    })
    await expect(session.start()).rejects.toThrow(/^agy acp did not start: Authentication required\. Run `agy` once in a terminal to sign in\.$/)
    expect(agy().kill).toHaveBeenCalled()
    expect(session.getProviderSessionId()).toBeNull()
    expect(named(events, 'started')).toEqual([])
  })

  it('a spawn failure is reported as spawn-failed and fails start', async () => {
    const { session, events, agy } = create(() => {})
    const starting = session.start()
    agy().emit('error', Object.assign(new Error('spawn agy ENOENT'), { code: 'ENOENT' }))
    await expect(starting).rejects.toThrow(/agy acp did not start/)
    const [first] = named(events, 'jsonl-error')
    expect((first!.args[0] as Error & { code: string }).code).toBe('spawn-failed')
    expect((first!.args[0] as Error).message).toBe('Could not start agy: spawn agy ENOENT')
    expect(session.isExited()).toBe(true)
  })
})

describe('AntigravitySession built-in MCP servers', () => {
  it.each([false, true])('attaches managed HTTP and stdio servers over the ACP pipe on resume=%s', async resume => {
    const { agy, spawned } = await launch(agyScript(), {
      resumeSessionId: resume ? 'saved' : undefined,
      userMcpServers: [
        { id: 'a', name: 'tracker', entry: { type: 'http', url: 'https://tracker.example/mcp', headers: { Authorization: 'Bearer ${input:key}' } }, secrets: { key: 'test-secret' } },
        { id: 'b', name: 'calendar', entry: { command: '/bin/example', args: ['serve'], env: { ACCOUNT: '${input:id}' } }, secrets: { id: 'test-account' } },
      ],
    }, ['saved'])
    const request = agy().sent.find(frame => frame.method === (resume ? 'session/load' : 'session/new'))
    expect(request!.params.mcpServers).toEqual([
      { type: 'http', name: 'tracker', url: 'https://tracker.example/mcp', headers: [{ name: 'Authorization', value: 'Bearer test-secret' }] },
      { type: 'stdio', name: 'calendar', command: '/bin/example', args: ['serve'], env: [{ name: 'ACCOUNT', value: 'test-account' }] },
    ])
    expect(JSON.stringify(spawned)).not.toContain('test-secret')
  })

  it('become ONE stdio proxy server agy starts, with headers in its env and the bearer never in argv', async () => {
    const bearer = 'bearer-secret-7f3a'
    const { agy, spawned } = await launch(agyScript(), {
      builtInMcpServers: [
        { name: 'agent_code', url: 'http://127.0.0.1:4100/mcp/pane-1', bearerToken: bearer, headers: { 'X-Agent-Code-Pane': 'pane-1' } },
        { name: 'agent_code_tasks', url: 'http://127.0.0.1:4100/mcp/tasks', headers: {} },
      ],
    })

    const { mcpServers } = agy().sent.find(frame => frame.method === 'session/new')!.params
    expect(mcpServers).toHaveLength(1)
    const [server] = mcpServers
    expect(server).toMatchObject({ type: 'stdio', name: 'agent_code', command: SCRIPT_RUNNER, args: [PROXY_SCRIPT] })

    const env = Object.fromEntries((server.env as Array<{ name: string; value: string }>).map(({ name, value }) => [name, value]))
    // The packaged app's own binary runs the proxy as plain Node.
    expect(env.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(env.AGENT_CODE_MCP_0_0).toBe('pane-1')
    expect(env.AGENT_CODE_MCP_0_1).toBe(`Bearer ${bearer}`)
    expect(JSON.parse(env.AGENT_CODE_ACP_MCP_SERVERS!)).toEqual([
      { name: 'agent_code', url: 'http://127.0.0.1:4100/mcp/pane-1', headerEnv: { 'X-Agent-Code-Pane': 'AGENT_CODE_MCP_0_0', Authorization: 'AGENT_CODE_MCP_0_1' } },
      { name: 'agent_code_tasks', url: 'http://127.0.0.1:4100/mcp/tasks', headerEnv: {} },
    ])

    // The bearer lives in exactly one env value: not in the proxy's argv or
    // command, not in the server spec JSON, not in agy's own argv or env.
    expect(Object.entries(env).filter(([, value]) => value.includes(bearer)).map(([name]) => name)).toEqual(['AGENT_CODE_MCP_0_1'])
    expect(JSON.stringify([server.command, server.args])).not.toContain(bearer)
    expect(JSON.stringify(spawned[0]!.args)).not.toContain(bearer)
    expect(Object.values(spawned[0]!.env).some(value => value.includes(bearer))).toBe(false)
  })
})

describe('AntigravitySession turns', () => {
  it('deliverPromptText sends session/prompt and every committed row arrives as a jsonl-entry', async () => {
    const { session, events, agy, spawned } = await launch(agyScript({
      onFrame: (frame, child) => {
        if (frame.method !== 'session/prompt') return
        child.update('sess-1', text('agent_thought_chunk', 'Greeting the user.'))
        child.update('sess-1', text('agent_message_chunk', 'hi '))
        child.update('sess-1', text('agent_message_chunk', 'there'))
        child.reply(frame, { stopReason: 'end_turn' })
      },
    }))

    await session.deliverPromptText('say hi')
    const prompt = agy().sent.find(frame => frame.method === 'session/prompt')!
    expect(prompt.params).toEqual({ sessionId: 'sess-1', prompt: [{ type: 'text', text: 'say hi' }] })

    await waitFor(() => expect(semanticTypes(events)).toContain('turn_completed'))
    expect(rowEntries(events).map(event => [(event.args[0] as { key: string }).key, (event.args[0] as { role: string }).role, (event.args[0] as { text: string }).text, event.args[1]])).toEqual([
      ['ag:sess-1:0', 'user', 'say hi', 'antigravity://session/sess-1'],
      ['ag:sess-1:1', 'thought', 'Greeting the user.', 'antigravity://session/sess-1'],
      ['ag:sess-1:2', 'assistant', 'hi there', 'antigravity://session/sess-1'],
    ])
    const turnCompleted = named(events, 'semantic-event').map(event => event.args[0] as { type: string; fullText?: string }).find(event => event.type === 'turn_completed')
    expect(turnCompleted?.fullText).toBe('hi there')
    expect(semanticTypes(events).indexOf('turn_started')).toBeLessThan(semanticTypes(events).indexOf('turn_completed'))
    // Busy during the turn, idle after.
    const states = named(events, 'process-state').map(event => event.args[0] as { active: boolean; status?: string })
    expect(states).toContainEqual({ active: true, status: 'working' })
    expect(states.at(-1)).toEqual({ active: false, status: 'idle' })

    // A renderer reload pages the live rows back under the same keys, without
    // spawning a replay.
    const chunk = await loadAntigravityHistoryChunk({ cwd: '/work/project', providerSessionId: 'sess-1', limit: 10 })
    expect(chunk.entries.map(entry => entry.key)).toEqual(['ag:sess-1:0', 'ag:sess-1:1', 'ag:sess-1:2'])
    expect(spawned).toHaveLength(1)
  })

  it('a prompt typed during a turn is acknowledged as queued at once and written only after the running turn answers', async () => {
    const prompts: Frame[] = []
    const { session, agy } = await launch(agyScript({
      onFrame: frame => {
        if (frame.method === 'session/prompt') prompts.push(frame)
      },
    }))
    expect(await session.deliverPromptText('first')).toEqual({ turnStarted: true })
    // Resolves immediately: holding it until the turn ends would keep the
    // pane's delivery slot busy (delivery-in-flight for every other sender).
    expect(await session.deliverPromptText('second')).toEqual({ turnStarted: false })
    expect(prompts.map(frame => frame.params.prompt[0].text)).toEqual(['first'])
    agy().reply(prompts[0]!, { stopReason: 'end_turn' })
    await waitFor(() => expect(prompts.map(frame => frame.params.prompt[0].text)).toEqual(['first', 'second']))
  })

  it('a permission request becomes a condition whose action resolves through resolveCondition, once', async () => {
    let promptFrame: Frame | null = null
    const { session, events, agy } = await launch(agyScript({
      onFrame: (frame, child) => {
        if (frame.method === 'session/prompt') {
          promptFrame = frame
          child.update('sess-1', { sessionUpdate: 'tool_call', toolCallId: 'c1', name: 'run_command', kind: 'execute', status: 'pending', rawInput: { CommandLine: 'echo hi' } })
          child.send({
            jsonrpc: '2.0',
            id: 'perm-1',
            method: 'session/request_permission',
            params: {
              sessionId: 'sess-1',
              toolCall: { toolCallId: 'c1', name: 'run_command', kind: 'execute', title: 'echo hi', rawInput: { CommandLine: 'echo hi' } },
              options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'deny', name: 'Deny', kind: 'reject_once' }],
            },
          })
        }
        if (frame.id === 'perm-1' && 'result' in frame) {
          child.update('sess-1', { sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed', rawOutput: { output: 'hi' } })
          child.update('sess-1', text('agent_message_chunk', 'done'))
          child.reply(promptFrame!, { stopReason: 'end_turn' })
        }
      },
    }))

    await session.deliverPromptText('run echo hi')
    await waitFor(() => expect(lastConditions(events)?.conditions['antigravity.permission']).toBeDefined())
    const card = lastConditions(events)!.conditions['antigravity.permission']!
    expect(card.state).toMatchObject({ visible: true, requestKey: 'perm-1', toolCallId: 'c1', title: 'echo hi', toolName: 'run_command', queued: 0 })
    expect(card.actions).toEqual([
      { kind: 'custom', id: 'perm-1:allow', label: 'Allow', name: ANTIGRAVITY_PERMISSION_RESPOND, payload: { requestKey: 'perm-1', optionId: 'allow' } },
      { kind: 'custom', id: 'perm-1:deny', label: 'Deny', name: ANTIGRAVITY_PERMISSION_RESPOND, payload: { requestKey: 'perm-1', optionId: 'deny' } },
    ])
    expect(named(events, 'process-state').map(event => event.args[0])).toContainEqual({ active: true, status: 'waiting-permission' })

    // Payloads that do not name an option of the OPEN request answer nothing.
    const allow = card.actions[0]!
    expect(await session.resolveCondition({ ...allow, payload: { requestKey: 'perm-1', optionId: 'always' } })).toEqual({ ok: false, reason: 'invalid-payload' })
    expect(await session.resolveCondition({ ...allow, payload: { requestKey: 'perm-0', optionId: 'allow' } })).toEqual({ ok: false, reason: 'invalid-payload' })
    expect(await session.resolveCondition({ ...allow, payload: null })).toEqual({ ok: false, reason: 'invalid-payload' })
    expect(await session.resolveCondition({ ...allow, name: 'claude.permission.respond' })).toEqual({ ok: false, reason: 'no-resolver' })
    const answers = () => agy().sent.filter(frame => frame.id === 'perm-1' && !frame.method)
    expect(answers()).toEqual([])

    expect(await session.resolveCondition(allow)).toEqual({ ok: true })
    expect(answers().map(frame => frame.result)).toEqual([{ outcome: { outcome: 'selected', optionId: 'allow' } }])
    expect(lastConditions(events)!.conditions).toEqual({})

    // The same card clicked again (stale) is refused and answers nothing more.
    expect(await session.resolveCondition(allow)).toEqual({ ok: false, reason: 'invalid-payload' })
    expect(answers()).toHaveLength(1)

    await waitFor(() => expect(semanticTypes(events)).toContain('turn_completed'))
    const tool = rowEntries(events).map(event => event.args[0] as { role: string; tool?: { status: string; output: string } }).find(row => row.role === 'tool')
    expect(tool?.tool).toMatchObject({ status: 'completed', output: 'hi' })

    await session.stop()
    expect(await session.resolveCondition(allow)).toEqual({ ok: false, reason: 'no-headless' })
  })

  it('Esc cancels the running turn with a session/cancel notification; other bytes are not input', async () => {
    let promptFrame: Frame | null = null
    const { session, events, agy } = await launch(agyScript({
      onFrame: (frame, child) => {
        if (frame.method === 'session/prompt') {
          promptFrame = frame
          child.update('sess-1', text('agent_message_chunk', 'working on it'))
        }
        if (frame.method === 'session/cancel') child.reply(promptFrame!, { stopReason: 'cancelled' })
      },
    }))
    await session.deliverPromptText('long job')

    expect(session.write('q')).toBe(false)
    expect(session.write('\r')).toBe(false)
    expect(agy().methods()).not.toContain('session/cancel')

    expect(session.write('\x1b')).toBe(true)
    await waitFor(() => expect(agy().methods()).toContain('session/cancel'))
    const cancel = agy().sent.find(frame => frame.method === 'session/cancel')!
    expect(cancel.params).toEqual({ sessionId: 'sess-1' })
    expect('id' in cancel).toBe(false)

    await waitFor(() => expect(named(events, 'process-state').at(-1)?.args[0]).toEqual({ active: false, status: 'idle' }))
    const apiError = named(events, 'semantic-event').map(event => event.args[0] as { type: string; errorType?: string }).find(event => event.type === 'api_error')
    expect(apiError?.errorType).toBe('cancelled')

    // Esc with no turn running sends nothing.
    session.write('\x1b')
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(agy().methods().filter(method => method === 'session/cancel')).toHaveLength(1)
  })
})

describe('AntigravitySession exit', () => {
  it('agy dying on its own is an agy-exited error, an exit, and a not-ready pane that refuses prompts retry-safely', async () => {
    const { session, events, agy } = await launch(agyScript())
    agy().exit(1, null)
    await waitFor(() => expect(named(events, 'exit')).toHaveLength(1))

    expect(named(events, 'exit')[0]!.args[0]).toEqual({ exitCode: 1 })
    expect(named(events, 'jsonl-error').map(event => (event.args[0] as Error & { code: string }).code)).toEqual(['agy-exited'])
    expect(named(events, 'input-readiness').at(-1)!.args[0]).toEqual({ ready: false, reason: 'provider-not-ready' })
    expect(session.isExited()).toBe(true)

    await expect(session.deliverPromptText('hello?')).rejects.toMatchObject({ code: 'antigravity-not-ready' })
    const delivery = await deliverAntigravityPrompt({ session, write: () => false, sessionId: 'pane-1', prompt: 'hello?' })
    expect(delivery).toMatchObject({ ok: false, code: 'not-ready', retrySafe: true, disposition: 'retry-same-session', promptWritten: false })
  })

  it('stop() closes the protocol and kills agy without reporting an error', async () => {
    const { session, events, agy } = await launch(agyScript())
    await session.stop()
    expect(agy().kill).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(named(events, 'exit')).toHaveLength(1))
    expect(named(events, 'jsonl-error')).toEqual([])
    expect(named(events, 'transcript-diagnostic').map(event => event.args[0])).toContainEqual({ kind: 'antigravity-acp-closed', reason: 'stopped' })
    expect(session.getProviderSessionId()).toBe('sess-1')
    expect(liveAntigravityRows('sess-1')).toBeNull()
  })
})
