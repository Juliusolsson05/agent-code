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

describe('SessionManager restart wake spawn', () => {
  beforeEach(() => {
    createSession.mockReset()
    createSession.mockImplementation(() => new FakeAgentSession())
  })

  it('can restore a provider backend under an existing workspace SessionId', async () => {
    const { SessionManager } = await import('./sessionManager')
    const manager = new SessionManager()

    const result = await manager.spawn({
      kind: 'claude',
      cwd: '/tmp/project',
      preferredSessionId: 'restored-session',
      resumeSessionId: 'provider-session',
    })

    expect(result.sessionId).toBe('restored-session')
    expect(manager.getSessionKind('restored-session')).toBe('claude')
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/tmp/project',
      resumeSessionId: 'provider-session',
      shellSessionId: 'restored-session',
    }))
  })

  it('refuses to reuse an id that already has a live backend', async () => {
    const { SessionManager } = await import('./sessionManager')
    const manager = new SessionManager()

    await manager.spawn({
      kind: 'codex',
      cwd: '/tmp/project',
      preferredSessionId: 'live-session',
    })

    await expect(manager.spawn({
      kind: 'codex',
      cwd: '/tmp/project',
      preferredSessionId: 'live-session',
    })).rejects.toThrow('Session live-session is already live')
    expect(createSession).toHaveBeenCalledTimes(1)
  })

  it('refuses to reuse an id while the first backend spawn is still starting', async () => {
    const { SessionManager } = await import('./sessionManager')
    let releaseStart!: () => void
    const startGate = new Promise<void>(resolve => {
      releaseStart = resolve
    })
    createSession.mockImplementation(() => new BlockingAgentSession(startGate))
    const manager = new SessionManager()

    const firstSpawn = manager.spawn({
      kind: 'claude',
      cwd: '/tmp/project',
      preferredSessionId: 'waking-session',
    })

    await expect(manager.spawn({
      kind: 'claude',
      cwd: '/tmp/project',
      preferredSessionId: 'waking-session',
    })).rejects.toThrow('Session waking-session is already live')

    releaseStart()
    await expect(firstSpawn).resolves.toEqual({ sessionId: 'waking-session' })
    expect(createSession).toHaveBeenCalledTimes(1)
  })
})
