import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionRecoverOptions } from '@shared/types/session.js'

const { createSession, deliverPrompt } = vi.hoisted(() => ({
  createSession: vi.fn(),
  deliverPrompt: vi.fn(),
}))

const terminalControl = vi.hoisted(() => ({
  startError: null as Error | null,
  stop: vi.fn(async (): Promise<void> => {}),
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

vi.mock('@shared/runtime/terminalSession.js', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    TerminalSession: class FakeTerminalSession extends EventEmitter {
      async start(): Promise<void> {
        if (terminalControl.startError) throw terminalControl.startError
        this.emit('started')
      }
      async stop(): Promise<void> {
        await terminalControl.stop()
      }
      write(): void {}
      resize(): void {}
    },
  }
})

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
    terminalControl.startError = null
    terminalControl.stop.mockClear()
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
      builtInMcpDomains: [],
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

  it('lets a reloaded renderer cancel the recovery generation it joined', async () => {
    const { SessionManager } = await import('./sessionManager')
    const startGate = deferred<void>()
    const session = new BlockingAgentSession(startGate.promise)
    session.stop.mockImplementationOnce(async () => startGate.resolve())
    createSession.mockImplementationOnce(() => session)
    const manager = new SessionManager()
    const ownership = {
      sessionId: 'joined-token-session',
      kind: 'codex' as const,
      cwd: '/tmp/project',
    }

    const first = manager.recover({
      ...ownership,
      recoveryToken: 'renderer-before-reload',
    })
    await vi.waitFor(() => expect(createSession).toHaveBeenCalledTimes(1))
    const joined = manager.recover({
      ...ownership,
      recoveryToken: 'renderer-after-reload',
    })

    const joinedCancellation = await manager.cancelRecovery({
      ...ownership,
      recoveryToken: 'renderer-after-reload',
    })
    if (!joinedCancellation) {
      // Keep the red fixture bounded on the reviewed head. Production must not
      // need the vanished renderer's token; this fallback only releases the
      // intentionally blocked fake so Vitest can report that contract failure.
      await manager.cancelRecovery({
        ...ownership,
        recoveryToken: 'renderer-before-reload',
      })
    }

    expect(joinedCancellation).toBe(true)
    await expect(Promise.all([first, joined])).resolves.toEqual([
      expect.objectContaining({ ok: false, code: 'cancelled' }),
      expect.objectContaining({ ok: false, code: 'cancelled' }),
    ])
    expect(session.stop).toHaveBeenCalled()
    expect(manager.list()).toEqual([])
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

    await expect(manager.recover(options)).resolves.toEqual({
      ok: false,
      code: 'start-failed',
      retryable: true,
      message: 'Session failed to start. Check provider setup and retry.',
    })
    expect(failed.stop).toHaveBeenCalledTimes(1)
    await expect(manager.recover(options)).resolves.toMatchObject({
      ok: true,
      disposition: 'spawned',
    })
    expect(createSession).toHaveBeenCalledTimes(2)
  })

  it('revokes MCP and exposes no provider exception when construction fails', async () => {
    const { SessionManager } = await import('./sessionManager')
    const registerSession = vi.fn(() => [])
    const revokeSession = vi.fn()
    createSession.mockImplementationOnce(() => {
      throw new Error('secret-token-from-provider-constructor')
    })
    const manager = new SessionManager(null, { registerSession, revokeSession } as never)

    await expect(manager.recover({
      sessionId: 'constructor-failure',
      kind: 'claude',
      cwd: '/tmp/project',
      builtInMcpDomains: ['workflows'],
    })).resolves.toEqual({
      ok: false,
      code: 'start-failed',
      retryable: true,
      message: 'Session failed to start. Check provider setup and retry.',
    })

    expect(registerSession).toHaveBeenCalledTimes(1)
    expect(revokeSession).toHaveBeenCalledTimes(1)
    expect(manager.getBackendSnapshot('constructor-failure')).toBeNull()
    expect(manager.list()).not.toContain('constructor-failure')
  })

  it('destroys only a newly-created tmux session when terminal startup rolls back', async () => {
    const { SessionManager } = await import('./sessionManager')
    terminalControl.startError = new Error('attach failed')
    const registry = {
      isAvailable: () => true,
      getBinary: () => '/tmp/tmux',
      generateName: () => 'new-tmux-session',
      sessionExists: vi.fn(async (name: string) => name === 'durable-tmux-session'),
      createSession: vi.fn(async () => {}),
      killSession: vi.fn(async () => {}),
    }

    const freshManager = new SessionManager(registry as never)
    await expect(freshManager.recover({
      sessionId: 'fresh-terminal',
      kind: 'terminal',
      cwd: '/tmp/project',
    })).resolves.toMatchObject({ ok: false, code: 'start-failed' })
    expect(registry.createSession).toHaveBeenCalledWith(expect.objectContaining({
      name: 'new-tmux-session',
    }))
    expect(registry.killSession).toHaveBeenCalledWith('new-tmux-session')
    expect(freshManager.getBackendSnapshot('fresh-terminal')).toBeNull()

    registry.killSession.mockClear()
    const recoveredManager = new SessionManager(registry as never)
    await expect(recoveredManager.recover({
      sessionId: 'recovered-terminal',
      kind: 'terminal',
      cwd: '/tmp/project',
      recoverTmuxName: 'durable-tmux-session',
    })).resolves.toMatchObject({ ok: false, code: 'start-failed' })
    expect(registry.killSession).not.toHaveBeenCalled()
    expect(recoveredManager.getBackendSnapshot('recovered-terminal')).toBeNull()
  })

  it('registers project-scoped MCP once on cold spawn and never during adoption', async () => {
    const { SessionManager } = await import('./sessionManager')
    const serverConfig = {
      name: 'agent_code',
      url: 'http://127.0.0.1:43210/mcp',
      headers: {},
      bearerToken: 'scoped-test-token',
    }
    const registerSession = vi.fn(() => [serverConfig])
    const revokeSession = vi.fn()
    const sessionDomains = vi.fn(() => ['orchestration'])
    const manager = new SessionManager(null, {
      registerSession,
      revokeSession,
      sessionDomains,
    } as never)
    const options = {
      sessionId: 'mcp-session',
      kind: 'claude' as const,
      cwd: '/tmp/project',
      builtInMcpDomains: ['orchestration'],
    } satisfies SessionRecoverOptions

    await expect(manager.recover(options)).resolves.toMatchObject({
      ok: true,
      disposition: 'spawned',
      snapshot: { builtInMcpDomains: ['orchestration'] },
    })
    await expect(manager.recover({
      ...options,
      // Adoption keeps the live backend; this changed request must not be
      // reported as if it mutated that process's launch-time tool scope.
      builtInMcpDomains: [],
    })).resolves.toMatchObject({
      ok: true,
      disposition: 'adopted',
      snapshot: { builtInMcpDomains: ['orchestration'] },
    })

    expect(registerSession).toHaveBeenCalledTimes(1)
    expect(registerSession).toHaveBeenCalledWith({
      sessionId: 'mcp-session',
      cwd: '/tmp/project',
      providerKind: 'claude',
      domains: ['orchestration'],
    })
    expect(sessionDomains).toHaveBeenCalledWith('mcp-session')
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({
      builtInMcpServers: [serverConfig],
    }))
    expect(revokeSession).not.toHaveBeenCalled()
  })

  it('requires an MCP host only when the effective request is non-empty', async () => {
    const { SessionManager } = await import('./sessionManager')
    const manager = new SessionManager()

    await expect(manager.recover({
      sessionId: 'no-host-empty-scope',
      kind: 'codex',
      cwd: '/tmp/project',
      builtInMcpDomains: [],
    })).resolves.toMatchObject({
      ok: true,
      snapshot: { builtInMcpDomains: [] },
    })
    await expect(manager.recover({
      sessionId: 'no-host-nonempty-scope',
      kind: 'codex',
      cwd: '/tmp/project',
      builtInMcpDomains: ['orchestration'],
    })).resolves.toMatchObject({
      ok: false,
      code: 'start-failed',
    })

    await manager.killAll()
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
    await vi.waitFor(() => expect(session.stop).toHaveBeenCalledTimes(2))
    expect(registerSession).toHaveBeenCalledTimes(1)
    expect(revokeSession).toHaveBeenCalledTimes(1)
    expect(manager.getBackendSnapshot('cancelled-session')).toBeNull()
    expect(manager.list()).not.toContain('cancelled-session')
  })

  it('keeps a cancelled generation fenced until its startup rollback settles', async () => {
    const { SessionManager } = await import('./sessionManager')
    const oldStart = deferred<void>()
    const oldSession = new BlockingAgentSession(oldStart.promise)
    const replacement = new FakeAgentSession()
    createSession
      .mockImplementationOnce(() => oldSession)
      .mockImplementationOnce(() => replacement)
    const manager = new SessionManager()
    const options = {
      sessionId: 'replace-blocked-session',
      kind: 'claude' as const,
      cwd: '/tmp/project',
    }

    const abandoned = manager.recover(options)
    await vi.waitFor(() => expect(createSession).toHaveBeenCalledTimes(1))
    await expect(manager.kill(options.sessionId)).resolves.toBe(true)

    // WHY a retry joins the cancelled generation until rollback finishes:
    // allowing a new provider to start while the old start() can still
    // materialize tools would create two physical owners for one logical id.
    // The renderer has a bounded wait and may render Retry immediately, but
    // main keeps the mutation-safety fence until teardown is actually done.
    const joinedCancelledGeneration = manager.recover(options)
    await Promise.resolve()
    expect(createSession).toHaveBeenCalledTimes(1)

    oldStart.resolve()
    oldSession.emit('exit', { exitCode: 99 })
    await expect(abandoned).resolves.toMatchObject({ ok: false, code: 'cancelled' })
    await expect(joinedCancelledGeneration).resolves.toMatchObject({
      ok: false,
      code: 'cancelled',
    })
    await vi.waitFor(() => expect(oldSession.stop).toHaveBeenCalledTimes(2))

    await expect(manager.recover(options)).resolves.toMatchObject({
      ok: true,
      disposition: 'spawned',
    })
    expect(manager.list()).toEqual([options.sessionId])
    expect(manager.getBackendSnapshot(options.sessionId)).toMatchObject({
      kind: 'claude',
      cwd: '/tmp/project',
      lifecycle: 'live',
    })
    await manager.killAll()
  })

  it('launches post-start teardown even when the first stop attempt is still blocked', async () => {
    const { SessionManager } = await import('./sessionManager')
    const startGate = deferred<void>()
    const firstStopGate = deferred<void>()
    const session = new BlockingAgentSession(startGate.promise)
    session.stop
      .mockImplementationOnce(async () => await firstStopGate.promise)
      .mockResolvedValueOnce(undefined)
    createSession.mockImplementationOnce(() => session)
    const manager = new SessionManager()
    const options = {
      sessionId: 'blocked-stop-session',
      kind: 'claude' as const,
      cwd: '/tmp/project',
    }

    const recovery = manager.recover(options)
    await vi.waitFor(() => expect(createSession).toHaveBeenCalledTimes(1))
    const killing = manager.kill(options.sessionId)
    await vi.waitFor(() => expect(session.stop).toHaveBeenCalledTimes(1))

    startGate.resolve()
    await vi.waitFor(() => expect(session.stop).toHaveBeenCalledTimes(2))
    firstStopGate.resolve()

    await expect(killing).resolves.toBe(true)
    await expect(recovery).resolves.toMatchObject({ ok: false, code: 'cancelled' })
    expect(manager.list()).toEqual([])
  })

  it('kills or cancels only a matching provider-and-cwd owner', async () => {
    const { SessionManager } = await import('./sessionManager')
    const manager = new SessionManager()
    const owner = {
      sessionId: 'owned-session',
      kind: 'claude' as const,
      cwd: '/tmp/project',
    }
    await manager.recover(owner)

    await expect(manager.killOwned({ ...owner, cwd: '/tmp/other-project' }))
      .resolves.toBe(false)
    await expect(manager.killOwned({ ...owner, kind: 'codex' }))
      .resolves.toBe(false)
    await expect(manager.cancelRecovery({
      ...owner,
      recoveryToken: 'already-settled-recovery',
    })).resolves.toBe(false)
    expect(manager.getBackendSnapshot(owner.sessionId)).toMatchObject({
      kind: 'claude',
      cwd: '/tmp/project',
      lifecycle: 'live',
    })

    await expect(manager.killOwned(owner)).resolves.toBe(true)
    expect(manager.getBackendSnapshot(owner.sessionId)).toBeNull()
  })

  it('keeps readiness revisions monotonic after the bounded known-id cache evicts old ids', async () => {
    const { SessionManager } = await import('./sessionManager')
    const manager = new SessionManager()
    let firstRevision = 0

    for (let index = 0; index < 8_193; index += 1) {
      const sessionId = `bounded-id-${index}`
      await manager.recover({ sessionId, kind: 'claude', cwd: '/tmp/project' })
      if (index === 0) {
        firstRevision = manager.getBackendSnapshot(sessionId)?.input.revision ?? 0
      }
      await manager.kill(sessionId)
    }
    await manager.recover({
      sessionId: 'bounded-id-0',
      kind: 'claude',
      cwd: '/tmp/project',
    })

    expect(manager.getBackendSnapshot('bounded-id-0')?.input.revision)
      .toBeGreaterThan(firstRevision)
    await manager.killAll()
  }, 30_000)
})
