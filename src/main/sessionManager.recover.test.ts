import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionRecoverOptions } from '@shared/types/session.js'

const { createSession, deliverPrompt } = vi.hoisted(() => ({
  createSession: vi.fn(),
  deliverPrompt: vi.fn(),
}))

vi.mock('@providers/registry.main.js', () => ({
  getMainProvider: () => ({ createSession, deliverPrompt }),
}))

vi.mock('@main/setup/toolchain.js', () => ({
  getToolPath: () => '/usr/bin/true',
}))

vi.mock('@main/performance/PerformanceService.js', () => ({
  performanceService: {
    mark: vi.fn(),
    record: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('@main/storage/feedDebugLog.js', () => ({
  forgetFeedDebugSession: vi.fn(),
}))

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

class FakeAgentSession extends EventEmitter {
  readonly start = vi.fn(async (): Promise<void> => {
    this.emit('started', { projectDir: '/tmp/project' })
  })
  readonly stop = vi.fn(async (): Promise<void> => {})
  readonly write = vi.fn()
  readonly resize = vi.fn()
}

class BlockingAgentSession extends EventEmitter {
  readonly stop = vi.fn(async (): Promise<void> => {})
  readonly write = vi.fn()
  readonly resize = vi.fn()

  constructor(private readonly startGate: Promise<void>) {
    super()
  }

  async start(): Promise<void> {
    await this.startGate
    this.emit('started', { projectDir: '/tmp/project' })
  }
}

describe('SessionManager recover', () => {
  beforeEach(() => {
    createSession.mockReset()
    createSession.mockImplementation(() => new FakeAgentSession())
    deliverPrompt.mockReset()
  })

  it('adopts a matching live backend without constructing another provider', async () => {
    const { SessionManager } = await import('./sessionManager')
    const manager = new SessionManager()

    const first = await manager.recover({
      sessionId: 'stable-session',
      kind: 'claude',
      cwd: '/tmp/project',
      resumeSessionId: 'provider-history',
    })
    const adopted = await manager.recover({
      sessionId: 'stable-session',
      kind: 'claude',
      cwd: '/tmp/project/.',
      resumeSessionId: 'ignored-on-adoption',
    })

    expect(first).toMatchObject({ ok: true, disposition: 'spawned' })
    expect(adopted).toMatchObject({
      ok: true,
      disposition: 'adopted',
      snapshot: {
        sessionId: 'stable-session',
        kind: 'claude',
        cwd: '/tmp/project',
        lifecycle: 'live',
      },
    })
    expect(createSession).toHaveBeenCalledTimes(1)
  })

  it('keeps a started provider unready until its composer attests readiness', async () => {
    const { SessionManager } = await import('./sessionManager')
    const session = new FakeAgentSession()
    createSession.mockImplementation(() => session)
    const manager = new SessionManager()
    const seen: Array<{ ready: boolean; revision: number }> = []
    manager.on('input-readiness', ({ input }) => seen.push(input))

    await manager.recover({
      sessionId: 'readiness-session',
      kind: 'claude',
      cwd: '/tmp/project',
    })

    expect(manager.getBackendSnapshot('readiness-session')).toMatchObject({
      lifecycle: 'live',
      input: { ready: false, revision: 1, reason: 'starting' },
    })
    session.emit('input-readiness', { ready: true, reason: 'ready' })
    expect(manager.getBackendSnapshot('readiness-session')).toMatchObject({
      input: { ready: true, revision: 2, reason: 'ready' },
    })
    expect(seen).toEqual([
      { ready: false, revision: 1, reason: 'starting' },
      { ready: true, revision: 2, reason: 'ready' },
    ])
  })

  it('keeps readiness revisions monotonic when the same local id gets a replacement backend', async () => {
    const { SessionManager } = await import('./sessionManager')
    const first = new FakeAgentSession()
    const replacement = new FakeAgentSession()
    createSession
      .mockImplementationOnce(() => first)
      .mockImplementationOnce(() => replacement)
    const manager = new SessionManager()
    const options = {
      sessionId: 'replacement-session',
      kind: 'claude' as const,
      cwd: '/tmp/project',
    }

    await manager.recover(options)
    first.emit('input-readiness', { ready: true, reason: 'ready' })
    const oldRevision = manager.getBackendSnapshot(options.sessionId)?.input.revision ?? 0
    await manager.kill(options.sessionId)
    await manager.recover(options)

    expect(manager.getBackendSnapshot(options.sessionId)).toMatchObject({
      input: {
        ready: false,
        revision: oldRevision + 1,
        reason: 'starting',
      },
    })
  })

  it('joins concurrent compatible recovery calls under one synchronous claim', async () => {
    const { SessionManager } = await import('./sessionManager')
    const startGate = deferred<void>()
    createSession.mockImplementation(() => new BlockingAgentSession(startGate.promise))
    const manager = new SessionManager()
    const options = {
      sessionId: 'joining-session',
      kind: 'codex' as const,
      cwd: '/tmp/project',
    }

    const first = manager.recover(options)
    const second = manager.recover(options)
    expect(manager.getBackendSnapshot('joining-session')).toMatchObject({
      sessionId: 'joining-session',
      kind: 'codex',
      cwd: '/tmp/project',
      lifecycle: 'spawning',
    })

    startGate.resolve()
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ ok: true, disposition: 'spawned' }),
      expect.objectContaining({ ok: true, disposition: 'spawned' }),
    ])
    expect(createSession).toHaveBeenCalledTimes(1)
  })

  it('joins a re-entrant recovery initiated during provider construction', async () => {
    const { SessionManager } = await import('./sessionManager')
    const manager = new SessionManager()
    const options = {
      sessionId: 'reentrant-session',
      kind: 'claude' as const,
      cwd: '/tmp/project',
    }
    let reentrant!: Promise<unknown>
    createSession.mockImplementation(() => {
      reentrant = manager.recover(options)
      return new FakeAgentSession()
    })

    const first = manager.recover(options)
    await expect(first).resolves.toMatchObject({ ok: true, disposition: 'spawned' })
    await expect(reentrant).resolves.toMatchObject({ ok: true, disposition: 'spawned' })
    expect(createSession).toHaveBeenCalledTimes(1)
  })

  it('returns typed conflicts for a different kind or normalized cwd', async () => {
    const { SessionManager } = await import('./sessionManager')
    const manager = new SessionManager()
    await manager.recover({
      sessionId: 'owned-session',
      kind: 'claude',
      cwd: '/tmp/project',
    })

    await expect(manager.recover({
      sessionId: 'owned-session',
      kind: 'codex',
      cwd: '/tmp/project',
    })).resolves.toMatchObject({
      ok: false,
      code: 'ownership-conflict',
      retryable: false,
      actual: { kind: 'claude', cwd: '/tmp/project', lifecycle: 'live' },
    })
    await expect(manager.recover({
      sessionId: 'owned-session',
      kind: 'claude',
      cwd: '/tmp/another-project',
    })).resolves.toMatchObject({ ok: false, code: 'ownership-conflict' })
    expect(createSession).toHaveBeenCalledTimes(1)
  })

  it('releases a failed claim so a later recovery can retry', async () => {
    const { SessionManager } = await import('./sessionManager')
    const failed = new FakeAgentSession()
    failed.start.mockRejectedValueOnce(new Error('provider unavailable'))
    createSession.mockImplementationOnce(() => failed)
    const manager = new SessionManager()
    const options = {
      sessionId: 'retry-session',
      kind: 'claude' as const,
      cwd: '/tmp/project',
    }

    await expect(manager.recover(options)).resolves.toMatchObject({
      ok: false,
      code: 'start-failed',
      retryable: true,
    })
    await expect(manager.recover(options)).resolves.toMatchObject({
      ok: true,
      disposition: 'spawned',
    })
    expect(createSession).toHaveBeenCalledTimes(2)
  })

  it('registers project-scoped MCP once on cold spawn and never during adoption', async () => {
    const { SessionManager } = await import('./sessionManager')
    const registerSession = vi.fn(() => [])
    const revokeSession = vi.fn()
    const manager = new SessionManager(null, { registerSession, revokeSession } as never)
    const options = {
      sessionId: 'mcp-session',
      kind: 'claude' as const,
      cwd: '/tmp/project',
      builtInMcpDomains: ['workflows'],
    } satisfies SessionRecoverOptions

    await manager.recover(options)
    await manager.recover(options)

    expect(registerSession).toHaveBeenCalledTimes(1)
    expect(registerSession).toHaveBeenCalledWith({
      sessionId: 'mcp-session',
      cwd: '/tmp/project',
      domains: ['workflows'],
    })
    expect(revokeSession).not.toHaveBeenCalled()
  })

  it('adopts normally while prompt delivery is in flight on the owned backend', async () => {
    const { SessionManager } = await import('./sessionManager')
    const deliveryGate = deferred<{
      ok: true
      promptWritten: true
      enterWritten: true
    }>()
    deliverPrompt.mockImplementationOnce(async () => await deliveryGate.promise)
    const manager = new SessionManager()
    const options = {
      sessionId: 'busy-session',
      kind: 'claude' as const,
      cwd: '/tmp/project',
    }
    await manager.recover(options)

    const delivery = manager.deliverPromptToAgent('busy-session', 'keep working')
    await vi.waitFor(() => expect(deliverPrompt).toHaveBeenCalledTimes(1))
    await expect(manager.recover(options)).resolves.toMatchObject({
      ok: true,
      disposition: 'adopted',
    })
    deliveryGate.resolve({ ok: true, promptWritten: true, enterWritten: true })
    await expect(delivery).resolves.toMatchObject({ ok: true })
    expect(createSession).toHaveBeenCalledTimes(1)
  })

  it('lets kill cancel a blocked recovery and leaves no backend behind', async () => {
    const { SessionManager } = await import('./sessionManager')
    const startGate = deferred<void>()
    const session = new BlockingAgentSession(startGate.promise)
    createSession.mockImplementation(() => session)
    const registerSession = vi.fn(() => [])
    const revokeSession = vi.fn()
    const manager = new SessionManager(null, { registerSession, revokeSession } as never)

    const recovery = manager.recover({
      sessionId: 'cancelled-session',
      kind: 'claude',
      cwd: '/tmp/project',
      builtInMcpDomains: ['workflows'],
    })
    await vi.waitFor(() => expect(createSession).toHaveBeenCalledTimes(1))
    await expect(manager.kill('cancelled-session')).resolves.toBe(true)
    startGate.resolve()

    await expect(recovery).resolves.toMatchObject({
      ok: false,
      code: 'cancelled',
      retryable: true,
    })
    expect(session.stop).toHaveBeenCalledTimes(1)
    expect(registerSession).toHaveBeenCalledTimes(1)
    expect(revokeSession).toHaveBeenCalledTimes(1)
    expect(manager.getBackendSnapshot('cancelled-session')).toBeNull()
    expect(manager.list()).not.toContain('cancelled-session')
  })
})
