import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { createSession } = vi.hoisted(() => ({
  createSession: vi.fn(),
}))

vi.mock('@providers/registry.main.js', () => ({
  getMainProvider: () => ({ createSession }),
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

class FakeAgentSession extends EventEmitter {
  async start(): Promise<void> {
    this.emit('started', { projectDir: '/tmp/project' })
  }

  async stop(): Promise<void> {}

  write(): void {}

  resize(): void {}
}

class BlockingAgentSession extends EventEmitter {
  constructor(private readonly releaseStart: Promise<void>) {
    super()
  }

  async start(): Promise<void> {
    await this.releaseStart
    this.emit('started', { projectDir: '/tmp/project' })
  }

  async stop(): Promise<void> {}

  write(): void {}

  resize(): void {}
}

describe('SessionManager restart wake recovery', () => {
  beforeEach(() => {
    createSession.mockReset()
    createSession.mockImplementation(() => new FakeAgentSession())
  })

  it('can restore a provider backend under an existing workspace SessionId', async () => {
    const { SessionManager } = await import('./sessionManager')
    const manager = new SessionManager()

    const result = await manager.recover({
      sessionId: 'restored-session',
      kind: 'claude',
      cwd: '/tmp/project',
      resumeSessionId: 'provider-session',
    })

    expect(result).toMatchObject({
      ok: true,
      disposition: 'spawned',
      snapshot: { sessionId: 'restored-session' },
    })
    expect(manager.getSessionKind('restored-session')).toBe('claude')
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/tmp/project',
      resumeSessionId: 'provider-session',
      shellSessionId: 'restored-session',
    }))
  })

  it('keeps ordinary fresh spawn unable to choose a persisted local id', async () => {
    const { SessionManager } = await import('./sessionManager')
    const manager = new SessionManager()

    const first = await manager.spawn({
      kind: 'codex',
      cwd: '/tmp/project',
    })
    const second = await manager.spawn({
      kind: 'codex',
      cwd: '/tmp/project',
    })

    expect(first.sessionId).not.toBe(second.sessionId)
    expect(first.sessionId).not.toBe('live-session')
    expect(second.sessionId).not.toBe('live-session')
    expect(createSession).toHaveBeenCalledTimes(2)
  })

  it('awaits the pre-agent reconciliation boundary before creating the provider session', async () => {
    const { SessionManager } = await import('./sessionManager')
    let releaseReconciliation!: () => void
    const reconciliationGate = new Promise<void>(resolve => {
      releaseReconciliation = resolve
    })
    const beforeAgentSessionStart = vi.fn(async () => await reconciliationGate)
    const manager = new SessionManager(null, null, null, beforeAgentSessionStart)

    const spawning = manager.spawn({ kind: 'claude', cwd: '/tmp/project' })
    await vi.waitFor(() => expect(beforeAgentSessionStart).toHaveBeenCalledTimes(1))
    expect(createSession).not.toHaveBeenCalled()
    releaseReconciliation()
    await spawning

    expect(createSession).toHaveBeenCalledTimes(1)
  })

  it('keeps a rejected pre-agent reconciliation nonfatal to provider startup', async () => {
    const { SessionManager } = await import('./sessionManager')
    const beforeAgentSessionStart = vi.fn(async () => {
      throw new Error('conventions storage unavailable')
    })
    const manager = new SessionManager(null, null, null, beforeAgentSessionStart)

    await expect(manager.spawn({ kind: 'codex', cwd: '/tmp/project' }))
      .resolves.toMatchObject({ sessionId: expect.any(String) })
    expect(createSession).toHaveBeenCalledTimes(1)
  })

  it('joins a second wake while the first backend recovery is still starting', async () => {
    const { SessionManager } = await import('./sessionManager')
    let releaseStart!: () => void
    const startGate = new Promise<void>(resolve => {
      releaseStart = resolve
    })
    createSession.mockImplementation(() => new BlockingAgentSession(startGate))
    const manager = new SessionManager()

    const firstSpawn = manager.recover({
      sessionId: 'waking-session',
      kind: 'claude',
      cwd: '/tmp/project',
    })

    const secondSpawn = manager.recover({
      sessionId: 'waking-session',
      kind: 'claude',
      cwd: '/tmp/project',
    })

    releaseStart()
    await expect(Promise.all([firstSpawn, secondSpawn])).resolves.toEqual([
      expect.objectContaining({ ok: true, disposition: 'spawned' }),
      expect.objectContaining({ ok: true, disposition: 'spawned' }),
    ])
    expect(createSession).toHaveBeenCalledTimes(1)
  })
})
