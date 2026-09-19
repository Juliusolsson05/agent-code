import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GrokNativeControl, GrokTuiSocketGuard } from 'grok-code-headless'

const ptyState = vi.hoisted(() => ({ spawn: vi.fn() }))

// WHY node-pty is still mocked although the spawn is injected: the adapter
// imports node-pty at module level, and Agent Code's copy is rebuilt for
// Electron's ABI (postinstall electron-rebuild), so it cannot load under the
// plain-Node test runner at all. Same reason as the OpenCode adapter test.
vi.mock('node-pty', () => ({ spawn: ptyState.spawn }))

import { GrokSession } from './grokSession.js'
import type { AgentSessionEvents } from '@shared/types/session.js'

// Unit coverage of the adapter's OWN responsibilities: the recorded start order
// and its rollback, the session-switched fence, the MCP re-seed on
// terminal-loaded, prompt outcome mapping, and teardown. The runtime behind it
// is the real grok-code-headless package; only the leader (startControl), the
// guard (createGuard) and the PTY spawn are fakes, so no real grok binary,
// leader socket or guard socket is involved. The recorded end-to-end contract
// is proven in the package itself (446 tests incl. the corpus replay).

function fakePty() {
  let onData: ((data: string) => void) | null = null
  const exitListeners: Array<(event: { exitCode: number; signal: number }) => void> = []
  return {
    pid: 4301,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData: vi.fn((listener: (data: string) => void) => { onData = listener; return { dispose: vi.fn(() => { onData = null }) } }),
    onExit: vi.fn((listener: (event: { exitCode: number; signal: number }) => void) => {
      exitListeners.push(listener)
      return { dispose: () => exitListeners.splice(exitListeners.indexOf(listener), 1) }
    }),
    emitData: (data: string) => onData?.(data),
    emitExit: (event: { exitCode: number; signal: number }) => { for (const listener of [...exitListeners]) listener(event) },
  }
}

type ControlObserver = Parameters<GrokNativeControl['observe']>[0]

function fakeControl() {
  const calls: string[] = []
  const observers = new Set<ControlObserver>()
  const requests: Array<{ params: any; settle: { resolve(value: unknown): void; reject(error: unknown): void } }> = []
  const control = {
    socketPath: '/tmp/fake-leader.sock',
    pid: 1111,
    isClosed: false,
    observe(observer: ControlObserver) { observers.add(observer); return () => { observers.delete(observer) } },
    request: vi.fn((method: string, params: unknown) => {
      calls.push(`request:${method}`)
      return new Promise<unknown>((resolve, reject) => { requests.push({ params, settle: { resolve, reject } }) })
    }),
    notify: vi.fn(async () => {}),
    respond: vi.fn(async () => {}),
    createSession: vi.fn(async (id: string, servers: unknown[]) => { calls.push(`createSession:${id}`); return id }),
    loadSession: vi.fn(async (id: string, servers: unknown[]) => { calls.push(`loadSession:${id}`) }),
    updateMcpServers: vi.fn(async (id: string, servers: unknown[]) => { calls.push(`updateMcpServers:${id}`) }),
    dispose: vi.fn(async () => { calls.push('control-dispose'); control.isClosed = true; for (const observer of [...observers]) observer.onClose?.() }),
    // Test seams
    calls, requests, observerCount: () => observers.size,
    notifyObservers(method: string, params?: unknown) { for (const observer of [...observers]) observer.onNotification?.({ method, params }) },
    close() { control.isClosed = true; for (const observer of [...observers]) observer.onClose?.() },
  }
  return control
}

type TerminalListener = (message: { direction: 'from-terminal' | 'to-terminal'; payload: string }) => void

function fakeGuard() {
  const calls: string[] = []
  const listeners = new Set<TerminalListener>()
  const guard = {
    socketPath: '/tmp/fake-guard.sock',
    observeTerminalMessages(listener: TerminalListener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    dispose: vi.fn(async () => { calls.push('guard-dispose') }),
    // Test seam: push a decoded terminal frame the way the real guard's
    // reassembled-frame observer would.
    send(direction: 'from-terminal' | 'to-terminal', message: unknown) {
      for (const listener of [...listeners]) listener({ direction, payload: JSON.stringify(message) })
    },
  }
  return guard
}

const builtInMcpServers: NonNullable<import('@shared/types/session.js').SessionOptions['builtInMcpServers']> = [{
  name: 'agent-code',
  url: 'http://127.0.0.1:9000/mcp',
  bearerToken: 'secret',
  headers: {},
}]

let home: string
const sessions: GrokSession[] = []

function create(options: Partial<ConstructorParameters<typeof GrokSession>[0]> = {}, overrides: {
  control?: ReturnType<typeof fakeControl>
  guard?: ReturnType<typeof fakeGuard>
} = {}) {
  const control = overrides.control ?? fakeControl()
  const guard = overrides.guard ?? fakeGuard()
  const session = new GrokSession({
    cwd: home,
    builtInMcpServers,
    ...options,
  } as ConstructorParameters<typeof GrokSession>[0], {
    spawnPty: ptyState.spawn,
    startControl: vi.fn(async () => control as unknown as GrokNativeControl),
    createGuard: vi.fn(async () => guard as unknown as GrokTuiSocketGuard),
    headlessOptions: { heartbeatMs: 0, acceptanceTimeoutMs: 5_000 },
  })
  sessions.push(session)
  return { session, control, guard }
}

describe('GrokSession', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    ptyState.spawn.mockReset()
    home = await mkdtemp(join(tmpdir(), 'grok-session-test-'))
  })

  afterEach(async () => {
    for (const session of sessions.splice(0)) await session.stop()
    vi.useRealTimers()
    await rm(home, { recursive: true, force: true })
  })

  it('starts helpers in the recorded order and spawns the terminal with the prepared resume+guard args', async () => {
    const pty = fakePty()
    ptyState.spawn.mockReturnValue(pty)
    const { session, control, guard } = create({ resumeSessionId: '11111111-1111-4111-8111-111111111111' })
    const started = vi.fn()
    const identity = vi.fn()
    session.on('started', started)
    session.on('jsonl-entry', identity)

    await session.start()

    // The one order the recordings pin: leader, session over control, guard,
    // then the PTY (the terminal connect-or-spawns its leader, so an earlier
    // PTY would escape the app's process tree).
    expect(control.calls).toEqual(['loadSession:11111111-1111-4111-8111-111111111111'])
    expect(ptyState.spawn).toHaveBeenCalledTimes(1)
    const [binary, args] = ptyState.spawn.mock.calls[0]
    expect(binary).toBe('grok')
    expect(args).toEqual(expect.arrayContaining(['--leader-socket', guard.socketPath, '--resume', '11111111-1111-4111-8111-111111111111']))
    expect(args).toContain('--no-auto-update')
    expect(identity).toHaveBeenCalledWith({ sessionID: '11111111-1111-4111-8111-111111111111' }, expect.any(String))
    expect(started).toHaveBeenCalledOnce()
    expect(session.getProviderSessionId()).toBe('11111111-1111-4111-8111-111111111111')
  })

  it('creates a fresh session over control and re-seeds MCP when the terminal load is answered', async () => {
    const pty = fakePty()
    ptyState.spawn.mockReturnValue(pty)
    const { session, control, guard } = create()
    const sessionId = session.getProviderSessionId() // null before start; use emitted id instead
    expect(sessionId).toBeNull()
    const identity = vi.fn()
    session.on('jsonl-entry', identity)
    await session.start()
    const id = (identity.mock.calls[0][0] as { sessionID: string }).sessionID

    expect(control.calls[0]).toBe(`createSession:${id}`)
    // The attach load carries an empty MCP set and clears the control seed; the
    // app puts its set back when native answers the terminal's own load.
    expect(control.updateMcpServers).not.toHaveBeenCalled()
    guard.send('from-terminal', { jsonrpc: '2.0', id: 3, method: 'session/load', params: { sessionId: id } })
    guard.send('to-terminal', { jsonrpc: '2.0', id: 3, result: {} })
    await vi.waitFor(() => expect(control.updateMcpServers).toHaveBeenCalledOnce())
    const [reseedId, servers] = control.updateMcpServers.mock.calls[0]
    expect(reseedId).toBe(id)
    // The bearer is mapped into the Authorization header, never a plain header
    // (the same leak the app's other providers guard against).
    expect(servers).toEqual([{
      type: 'http',
      name: 'agent-code',
      url: 'http://127.0.0.1:9000/mcp',
      headers: [{ name: 'Authorization', value: 'Bearer secret' }],
    }])
  })

  it('rolls back a failed guard start without spawning a terminal', async () => {
    const control = fakeControl()
    const failingGuard = { ...fakeGuard(), dispose: vi.fn(async () => {}) }
    const { session } = create({}, { control, guard: undefined as never })
    // Replace createGuard for this instance through a custom deps binding.
    const pty = fakePty()
    ptyState.spawn.mockReturnValue(pty)
    const custom = new GrokSession({ cwd: home } as never, {
      spawnPty: ptyState.spawn,
      startControl: vi.fn(async () => control as unknown as GrokNativeControl),
      createGuard: vi.fn(async () => { throw new Error('guard socket unavailable') }),
      headlessOptions: { heartbeatMs: 0 },
    })
    sessions.push(custom)
    await expect(custom.start()).rejects.toThrow('guard socket unavailable')
    expect(ptyState.spawn).not.toHaveBeenCalled()
    // Reverse order: the leader that already came up is disposed.
    expect(control.dispose).toHaveBeenCalledOnce()
    // The failed-start wrapper is safe to stop again.
    await custom.stop()
  })

  it('rolls back the guard and leader when the PTY spawn fails', async () => {
    const control = fakeControl()
    const guard = fakeGuard()
    ptyState.spawn.mockImplementation(() => { throw new Error('no pty') })
    const custom = new GrokSession({ cwd: home } as never, {
      spawnPty: ptyState.spawn,
      startControl: vi.fn(async () => control as unknown as GrokNativeControl),
      createGuard: vi.fn(async () => guard as unknown as GrokTuiSocketGuard),
      headlessOptions: { heartbeatMs: 0 },
    })
    sessions.push(custom)
    await expect(custom.start()).rejects.toThrow('no pty')
    expect(guard.dispose).toHaveBeenCalledOnce()
    expect(control.dispose).toHaveBeenCalledOnce()
  })

  it('fences input and reports not ready when the terminal switches conversation', async () => {
    const pty = fakePty()
    ptyState.spawn.mockReturnValue(pty)
    const { session, guard } = create({ resumeSessionId: '11111111-1111-4111-8111-111111111111' })
    await session.start()
    const errors: Error[] = []
    const readiness = vi.fn()
    session.on('jsonl-error', error => errors.push(error))
    session.on('input-readiness', readiness)
    pty.write.mockClear()

    const other = '22222222-2222-4222-8222-222222222222'
    guard.send('from-terminal', { jsonrpc: '2.0', id: 7, method: 'session/new', params: {} })
    guard.send('to-terminal', { jsonrpc: '2.0', id: 7, result: { sessionId: other } })

    expect(errors.map(error => (error as Error & { code?: string }).code)).toEqual(['provider_session_switched'])
    expect(errors[0].message).toContain('11111111-1111-4111-8111-111111111111')
    expect(readiness).toHaveBeenLastCalledWith({ ready: false, reason: 'provider-not-ready' })
    session.write('x')
    expect(pty.write).not.toHaveBeenCalled()
  })

  it('maps prompt outcomes: not-ready before start, acceptance over control, refused, uncertain on close', async () => {
    // Real timers for this one: every step resolves through explicit promise
    // settlements, and polling waits under fake timers add nothing but hangs.
    vi.useRealTimers()
    const pty = fakePty()
    ptyState.spawn.mockReturnValue(pty)
    const { session, control } = create()
    await expect(session.deliverPromptText('too early')).rejects.toMatchObject({ code: 'grok-terminal-not-ready' })
    await session.start()

    // Acceptance: the first queue notification naming the client prompt id.
    // The fake control records the request synchronously inside submitPrompt,
    // so no polling wait is needed for it.
    const delivered = session.deliverPromptText('hello')
    expect(control.requests).toHaveLength(1)
    const promptId = control.requests[0]!.params._meta.promptId as string
    control.notifyObservers('_x.ai/queue/changed', { sessionId: control.requests[0]!.params.sessionId, entries: [{ id: promptId, kind: 'prompt' }] })
await expect(delivered).resolves.toBeUndefined()
    control.requests[0]!.settle.resolve({})

    // Refused: native's definite error answer before acceptance.
    const refused = session.deliverPromptText('no')
    expect(control.requests).toHaveLength(2)
    control.requests[1]!.settle.reject({ code: 'remote', rpcCode: -32603, uncertain: true })
    await expect(refused).rejects.toMatchObject({ code: 'grok-terminal-rejected' })

    // Uncertain: the control connection closes under a written prompt.
    const pending = session.deliverPromptText('maybe')
    expect(control.requests).toHaveLength(3)
    control.close()
    await expect(pending).rejects.toThrow(/uncertain|outcome/i)
  }, 10_000)

  it('delegates condition answers with generation fencing and stop kills in teardown order', async () => {
    const pty = fakePty()
    ptyState.spawn.mockReturnValue(pty)
    const { session, control, guard } = create()
    await session.start()
    // No condition is outstanding: the headless refuses before writing.
    await expect(session.resolveCondition({ kind: 'custom', id: 'x', label: 'x', name: 'grok.permission.reply', payload: { token: 'nope', optionId: 'allow-once' } }))
      .resolves.toMatchObject({ ok: false, reason: 'stale' })
    expect(control.respond).not.toHaveBeenCalled()

    const exit = vi.fn()
    session.on('exit', exit)
    await session.stop()
    expect(pty.kill).toHaveBeenCalledOnce()
    expect(guard.dispose).toHaveBeenCalledOnce()
    expect(control.dispose).toHaveBeenCalledOnce()
    // A stopped wrapper forwards nothing from a late PTY exit.
    pty.emitExit({ exitCode: 0, signal: 15 })
    expect(exit).not.toHaveBeenCalled()
  })
})
