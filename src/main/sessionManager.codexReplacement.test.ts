import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { SessionSpawnOptions } from '@preload/api/types.js'

type RecordedLeaseFailure = {
  observedAttempt: Array<{ name: string }>
  failure: string
}

const recordedLeaseFailure = JSON.parse(
  readFileSync(
    new URL('../../testing/fixtures/session-lifecycle/codex-reload-exact-lease.json', import.meta.url),
    'utf8',
  ),
) as RecordedLeaseFailure

const { createSession, resolveTranscriptPath } = vi.hoisted(() => ({
  createSession: vi.fn(),
  resolveTranscriptPath: vi.fn(),
}))

vi.mock('@providers/registry.main.js', () => ({
  getMainProvider: () => ({ createSession, resolveTranscriptPath }),
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

type ReplacementOptions = SessionSpawnOptions & {
  predecessorSessionId: string
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

class LeaseAwareCodexSession extends EventEmitter {
  readonly start = vi.fn(async (): Promise<void> => {
    // WHY the injected boundary runs before the fake records physical start:
    // production Codex can prepare proxy/config resources first, but exact
    // rollout acquisition is the first step that conflicts with the live
    // predecessor. Tests need to distinguish that boundary from an eager kill
    // at the top of SessionManager.spawn().
    await this.boundaryGate
    await this.beforeResumeOwnershipAcquire?.()
    await this.startGate
    this.order.push(`${this.label}:start`)
    if (this.requirePredecessorStop && !this.predecessorStopped.value) {
      // WHY the fake rejects at start instead of pretending the coordinator is
      // a UI concern: all five #638 attempts reached provider.start.begin and
      // then failed at exact-path reservation. The fixture preserves that
      // production boundary while keeping private rollout paths out of git.
      throw new Error(recordedLeaseFailure.failure)
    }
    if (this.startError) throw this.startError
    this.emit('started', { projectDir: '/recorded/worktree' })
  })

  readonly stop = vi.fn(async (): Promise<void> => {
    this.order.push(`${this.label}:stop`)
    await this.stopGate
    if (this.label === 'predecessor' || this.label === 'recovery') {
      this.predecessorStopped.value = true
    }
  })

  readonly write = vi.fn()
  readonly resize = vi.fn()

  private beforeResumeOwnershipAcquire: (() => Promise<void>) | null = null
  private boundaryGate: Promise<void> = Promise.resolve()
  private startGate: Promise<void> = Promise.resolve()
  private startError: Error | null = null

  constructor(
    private readonly label: 'predecessor' | 'successor' | 'restored' | 'recovery',
    private readonly order: string[],
    private readonly predecessorStopped: { value: boolean },
    private readonly requirePredecessorStop: boolean,
    private readonly stopGate: Promise<void> = Promise.resolve(),
  ) {
    super()
  }

  installResumeOwnershipBoundary(boundary: unknown): void {
    this.beforeResumeOwnershipAcquire =
      typeof boundary === 'function'
        ? boundary as () => Promise<void>
        : null
  }

  blockStartOn(gate: Promise<void>): void {
    this.startGate = gate
  }

  blockOwnershipBoundaryOn(gate: Promise<void>): void {
    this.boundaryGate = gate
  }

  failStartWith(error: Error): void {
    this.startError = error
  }
}

function installBoundaryFromCreateOptions(
  session: LeaseAwareCodexSession,
  options: unknown,
): LeaseAwareCodexSession {
  const boundary = (
    options as { beforeResumeOwnershipAcquire?: unknown }
  ).beforeResumeOwnershipAcquire
  session.installResumeOwnershipBoundary(boundary)
  return session
}

describe('SessionManager Codex replacement handoff', () => {
  beforeEach(() => {
    createSession.mockReset()
    resolveTranscriptPath.mockReset()
    resolveTranscriptPath.mockResolvedValue(null)
  })

  it('finishes the recorded predecessor stop before starting a same-rollout successor', async () => {
    expect(recordedLeaseFailure.observedAttempt.map(event => event.name)).toEqual([
      'readiness.publish',
      'provider.start.begin',
      'readiness.publish',
      'provider.start.end',
    ])

    const order: string[] = []
    const predecessorStopped = { value: false }
    const predecessor = new LeaseAwareCodexSession(
      'predecessor',
      order,
      predecessorStopped,
      false,
    )
    const successor = new LeaseAwareCodexSession(
      'successor',
      order,
      predecessorStopped,
      true,
    )
    createSession
      .mockImplementationOnce(() => predecessor)
      .mockImplementationOnce(options => installBoundaryFromCreateOptions(successor, options))

    const { SessionManager } = await import('./sessionManager')
    const lifecycle: Array<{
      name: string
      ids?: { sessionId?: string }
      data?: Record<string, unknown>
    }> = []
    const manager = new SessionManager(null, null, {
      record: (event: (typeof lifecycle)[number]) => lifecycle.push(event),
    } as never)
    const first = await manager.spawn({
      kind: 'codex',
      cwd: '/recorded/worktree',
      resumeSessionId: 'recorded-provider-session',
    })

    const replacement: ReplacementOptions = {
      kind: 'codex',
      cwd: '/recorded/worktree',
      resumeSessionId: 'recorded-provider-session',
      predecessorSessionId: first.sessionId,
    }
    await expect(manager.spawn(replacement)).resolves.toMatchObject({
      sessionId: expect.any(String),
    })

    expect(order).toEqual([
      'predecessor:start',
      'predecessor:stop',
      'successor:start',
    ])
    expect(
      lifecycle
        .filter(event => event.name.startsWith('replacement.handoff.'))
        .map(event => ({ name: event.name, data: event.data })),
    ).toEqual([
      {
        name: 'replacement.handoff.begin',
        data: expect.objectContaining({
          kind: 'codex',
          predecessorSessionId: first.sessionId,
          reason: 'same-resume-id',
        }),
      },
      {
        name: 'replacement.handoff.end',
        data: expect.objectContaining({
          kind: 'codex',
          predecessorSessionId: first.sessionId,
          ok: true,
          reason: 'same-resume-id',
        }),
      },
    ])
  })

  it('keeps start-before-stop when the Codex replacement targets a different transcript', async () => {
    const order: string[] = []
    const predecessorStopped = { value: false }
    const predecessor = new LeaseAwareCodexSession(
      'predecessor', order, predecessorStopped, false,
    )
    const successor = new LeaseAwareCodexSession(
      'successor', order, predecessorStopped, false,
    )
    createSession
      .mockImplementationOnce(() => predecessor)
      .mockImplementationOnce(options => installBoundaryFromCreateOptions(successor, options))

    const { SessionManager } = await import('./sessionManager')
    const manager = new SessionManager()
    const first = await manager.spawn({
      kind: 'codex',
      cwd: '/recorded/worktree',
      resumeSessionId: 'provider-a',
    })
    await manager.spawn({
      kind: 'codex',
      cwd: '/recorded/worktree',
      resumeSessionId: 'provider-b',
      predecessorSessionId: first.sessionId,
    })

    expect(order).toEqual(['predecessor:start', 'successor:start'])
    expect(predecessor.stop).not.toHaveBeenCalled()
  })

  it('uses the observed rollout path to hand off a formerly fresh Codex pane', async () => {
    const order: string[] = []
    const predecessorStopped = { value: false }
    const predecessor = new LeaseAwareCodexSession(
      'predecessor', order, predecessorStopped, false,
    )
    const successor = new LeaseAwareCodexSession(
      'successor', order, predecessorStopped, true,
    )
    createSession
      .mockImplementationOnce(() => predecessor)
      .mockImplementationOnce(options => installBoundaryFromCreateOptions(successor, options))
    resolveTranscriptPath.mockResolvedValue('/recorded/codex/rollout.jsonl')

    const { SessionManager } = await import('./sessionManager')
    const manager = new SessionManager()
    const first = await manager.spawn({
      kind: 'codex',
      cwd: '/recorded/worktree',
    })
    predecessor.emit('jsonl-entry', {}, '/recorded/codex/rollout.jsonl')

    await expect(manager.spawn({
      kind: 'codex',
      cwd: '/recorded/worktree',
      resumeSessionId: 'provider-learned-from-session-meta',
      predecessorSessionId: first.sessionId,
    })).resolves.toMatchObject({ sessionId: expect.any(String) })
    expect(order).toEqual([
      'predecessor:start',
      'predecessor:stop',
      'successor:start',
    ])
    expect(resolveTranscriptPath).toHaveBeenCalledWith(
      '/recorded/worktree',
      'provider-learned-from-session-meta',
    )
  })

  it('does not let an unrelated predecessor id bypass the exact lease', async () => {
    const order: string[] = []
    const predecessorStopped = { value: false }
    const predecessor = new LeaseAwareCodexSession(
      'predecessor', order, predecessorStopped, false,
    )
    const successor = new LeaseAwareCodexSession(
      'successor', order, predecessorStopped, true,
    )
    createSession
      .mockImplementationOnce(() => predecessor)
      .mockImplementationOnce(options => installBoundaryFromCreateOptions(successor, options))

    const { SessionManager } = await import('./sessionManager')
    const manager = new SessionManager()
    await manager.spawn({
      kind: 'codex',
      cwd: '/recorded/worktree',
      resumeSessionId: 'provider-a',
    })

    await expect(manager.spawn({
      kind: 'codex',
      cwd: '/recorded/worktree',
      resumeSessionId: 'provider-a',
      predecessorSessionId: 'not-the-live-pane',
    })).rejects.toThrow(recordedLeaseFailure.failure)
    expect(predecessor.stop).not.toHaveBeenCalled()
  })

  it('rejects a second replacement while the first predecessor stop is in flight', async () => {
    let releaseStop!: () => void
    const stopGate = new Promise<void>(resolve => {
      releaseStop = resolve
    })
    const order: string[] = []
    const predecessorStopped = { value: false }
    const predecessor = new LeaseAwareCodexSession(
      'predecessor', order, predecessorStopped, false, stopGate,
    )
    const successor = new LeaseAwareCodexSession(
      'successor', order, predecessorStopped, true,
    )
    createSession
      .mockImplementationOnce(() => predecessor)
      .mockImplementationOnce(options => installBoundaryFromCreateOptions(successor, options))

    const { SessionManager } = await import('./sessionManager')
    const manager = new SessionManager()
    const first = await manager.spawn({
      kind: 'codex',
      cwd: '/recorded/worktree',
      resumeSessionId: 'provider-a',
    })
    const replacement = {
      kind: 'codex' as const,
      cwd: '/recorded/worktree',
      resumeSessionId: 'provider-a',
      predecessorSessionId: first.sessionId,
    }

    const firstAttempt = manager.spawn(replacement)
    await vi.waitFor(() => expect(predecessor.stop).toHaveBeenCalledTimes(1))
    await expect(manager.spawn(replacement)).rejects.toThrow(
      'A Codex replacement is already in progress for this session',
    )
    releaseStop()
    await expect(firstAttempt).resolves.toMatchObject({
      sessionId: expect.any(String),
    })
    expect(createSession).toHaveBeenCalledTimes(2)
  })

  it('keeps the predecessor live when successor MCP preflight fails', async () => {
    const order: string[] = []
    const predecessorStopped = { value: false }
    const predecessor = new LeaseAwareCodexSession(
      'predecessor', order, predecessorStopped, false,
    )
    createSession.mockImplementationOnce(() => predecessor)
    const builtInMcpHost = {
      registerSession: vi.fn(() => {
        throw new Error('recorded successor MCP preflight failure')
      }),
      revokeSession: vi.fn(),
      sessionDomains: vi.fn(() => []),
    }

    const { SessionManager } = await import('./sessionManager')
    const manager = new SessionManager(null, builtInMcpHost as never)
    const first = await manager.spawn({
      kind: 'codex',
      cwd: '/recorded/worktree',
      resumeSessionId: 'provider-a',
    })

    await expect(manager.spawn({
      kind: 'codex',
      cwd: '/recorded/worktree',
      resumeSessionId: 'provider-a',
      predecessorSessionId: first.sessionId,
      builtInMcpDomains: ['agent_management'],
    })).rejects.toThrow('recorded successor MCP preflight failure')

    expect(predecessor.stop).not.toHaveBeenCalled()
    expect(manager.list()).toContain(first.sessionId)
    expect(manager.getBackendSnapshot(first.sessionId)).toMatchObject({
      lifecycle: 'live',
      kind: 'codex',
    })
  })

  it('fences recovery of the predecessor id until replacement settles', async () => {
    let releaseSuccessor!: () => void
    const successorGate = new Promise<void>(resolve => {
      releaseSuccessor = resolve
    })
    const order: string[] = []
    const predecessorStopped = { value: false }
    const predecessor = new LeaseAwareCodexSession(
      'predecessor', order, predecessorStopped, false,
    )
    const successor = new LeaseAwareCodexSession(
      'successor', order, predecessorStopped, true,
    )
    const recovery = new LeaseAwareCodexSession(
      'recovery', order, predecessorStopped, false,
    )
    successor.blockStartOn(successorGate)
    createSession
      .mockImplementationOnce(() => predecessor)
      .mockImplementationOnce(options => installBoundaryFromCreateOptions(successor, options))
      .mockImplementationOnce(() => recovery)

    const { SessionManager } = await import('./sessionManager')
    const manager = new SessionManager()
    const first = await manager.spawn({
      kind: 'codex',
      cwd: '/recorded/worktree',
      resumeSessionId: 'provider-a',
    })
    const replacement = manager.spawn({
      kind: 'codex',
      cwd: '/recorded/worktree',
      resumeSessionId: 'provider-a',
      predecessorSessionId: first.sessionId,
    })
    await vi.waitFor(() => expect(predecessor.stop).toHaveBeenCalledTimes(1))

    await expect(manager.recover({
      sessionId: first.sessionId,
      kind: 'codex',
      cwd: '/recorded/worktree',
      resumeSessionId: 'provider-a',
    })).resolves.toMatchObject({
      ok: false,
      code: 'ownership-conflict',
      retryable: true,
    })
    expect(createSession).toHaveBeenCalledTimes(2)

    releaseSuccessor()
    await expect(replacement).resolves.toMatchObject({
      sessionId: expect.any(String),
    })
  })

  it('restores the predecessor id when successor start fails after handoff', async () => {
    const order: string[] = []
    const predecessorStopped = { value: false }
    const predecessor = new LeaseAwareCodexSession(
      'predecessor', order, predecessorStopped, false,
    )
    const successor = new LeaseAwareCodexSession(
      'successor', order, predecessorStopped, true,
    )
    const restored = new LeaseAwareCodexSession(
      'restored', order, predecessorStopped, true,
    )
    const activeMcpRegistrations = new Set<string>()
    const builtInMcpHost = {
      registerSession: vi.fn((scope: { sessionId: string }) => {
        activeMcpRegistrations.add(scope.sessionId)
        return []
      }),
      revokeSession: vi.fn((sessionId: string) => {
        activeMcpRegistrations.delete(sessionId)
      }),
      sessionDomains: vi.fn(() => []),
    }
    successor.failStartWith(new Error('recorded successor start failure'))
    createSession
      .mockImplementationOnce(() => predecessor)
      .mockImplementationOnce(options => installBoundaryFromCreateOptions(successor, options))
      .mockImplementationOnce(() => restored)

    const { SessionManager } = await import('./sessionManager')
    const manager = new SessionManager(null, builtInMcpHost as never)
    const first = await manager.spawn({
      kind: 'codex',
      cwd: '/recorded/worktree',
      resumeSessionId: 'provider-a',
      useProxy: true,
    })

    await expect(manager.spawn({
      kind: 'codex',
      cwd: '/recorded/worktree',
      resumeSessionId: 'provider-a',
      predecessorSessionId: first.sessionId,
      builtInMcpDomains: ['agent_management'],
    })).rejects.toThrow('recorded successor start failure')

    expect(predecessor.stop).toHaveBeenCalledTimes(1)
    expect(restored.start).toHaveBeenCalledTimes(1)
    expect(manager.list()).toContain(first.sessionId)
    expect(manager.getBackendSnapshot(first.sessionId)).toMatchObject({
      sessionId: first.sessionId,
      kind: 'codex',
      lifecycle: 'live',
    })
    expect(createSession.mock.calls[2]?.[0]).toMatchObject({
      resumeSessionId: 'provider-a',
      useProxy: true,
    })
    expect(activeMcpRegistrations).toEqual(new Set())
    expect(builtInMcpHost.revokeSession).toHaveBeenCalledWith(
      expect.not.stringMatching(first.sessionId),
    )
  })

  it('does not restore a predecessor explicitly closed after destructive handoff', async () => {
    const successorGate = deferred<void>()
    const order: string[] = []
    const predecessorStopped = { value: false }
    const predecessor = new LeaseAwareCodexSession(
      'predecessor', order, predecessorStopped, false,
    )
    const successor = new LeaseAwareCodexSession(
      'successor', order, predecessorStopped, true,
    )
    const restored = new LeaseAwareCodexSession(
      'restored', order, predecessorStopped, true,
    )
    successor.blockStartOn(successorGate.promise)
    successor.failStartWith(new Error('recorded successor start failure'))
    createSession
      .mockImplementationOnce(() => predecessor)
      .mockImplementationOnce(options => installBoundaryFromCreateOptions(successor, options))
      .mockImplementationOnce(() => restored)

    const { SessionManager } = await import('./sessionManager')
    const manager = new SessionManager()
    const first = await manager.spawn({
      kind: 'codex',
      cwd: '/recorded/worktree',
      resumeSessionId: 'provider-a',
    })
    const replacement = manager.spawn({
      kind: 'codex',
      cwd: '/recorded/worktree',
      resumeSessionId: 'provider-a',
      predecessorSessionId: first.sessionId,
    })

    await vi.waitFor(() => expect(predecessor.stop).toHaveBeenCalledTimes(1))
    await expect(manager.killOwned({
      sessionId: first.sessionId,
      kind: 'codex',
      cwd: '/recorded/worktree',
    })).resolves.toBe(true)
    successorGate.resolve()
    await expect(replacement).rejects.toThrow('recorded successor start failure')

    expect(createSession).toHaveBeenCalledTimes(2)
    expect(restored.start).not.toHaveBeenCalled()
    expect(manager.list()).toEqual([])
  })

  it('does not compensate a replacement cancelled by global shutdown', async () => {
    const successorGate = deferred<void>()
    const order: string[] = []
    const predecessorStopped = { value: false }
    const predecessor = new LeaseAwareCodexSession(
      'predecessor', order, predecessorStopped, false,
    )
    const successor = new LeaseAwareCodexSession(
      'successor', order, predecessorStopped, true,
    )
    const restored = new LeaseAwareCodexSession(
      'restored', order, predecessorStopped, true,
    )
    successor.blockStartOn(successorGate.promise)
    successor.failStartWith(new Error('recorded successor start failure'))
    createSession
      .mockImplementationOnce(() => predecessor)
      .mockImplementationOnce(options => installBoundaryFromCreateOptions(successor, options))
      .mockImplementationOnce(() => restored)

    const { SessionManager } = await import('./sessionManager')
    const manager = new SessionManager()
    const first = await manager.spawn({
      kind: 'codex',
      cwd: '/recorded/worktree',
      resumeSessionId: 'provider-a',
    })
    const replacement = manager.spawn({
      kind: 'codex',
      cwd: '/recorded/worktree',
      resumeSessionId: 'provider-a',
      predecessorSessionId: first.sessionId,
    })

    await vi.waitFor(() => expect(predecessor.stop).toHaveBeenCalledTimes(1))
    await manager.killAll()
    successorGate.resolve()
    await expect(replacement).rejects.toThrow()

    expect(createSession).toHaveBeenCalledTimes(2)
    expect(restored.start).not.toHaveBeenCalled()
    expect(manager.list()).toEqual([])
  })

  it('keeps compensation cancellable before its registry entry is published', async () => {
    const compensationPreflight = deferred<void>()
    const compensationEntered = deferred<void>()
    let preflightCalls = 0
    const beforeAgentSessionStart = vi.fn(async () => {
      preflightCalls += 1
      if (preflightCalls === 3) {
        compensationEntered.resolve()
        await compensationPreflight.promise
      }
    })
    const order: string[] = []
    const predecessorStopped = { value: false }
    const predecessor = new LeaseAwareCodexSession(
      'predecessor', order, predecessorStopped, false,
    )
    const successor = new LeaseAwareCodexSession(
      'successor', order, predecessorStopped, true,
    )
    const restored = new LeaseAwareCodexSession(
      'restored', order, predecessorStopped, true,
    )
    successor.failStartWith(new Error('recorded successor start failure'))
    createSession
      .mockImplementationOnce(() => predecessor)
      .mockImplementationOnce(options => installBoundaryFromCreateOptions(successor, options))
      .mockImplementationOnce(() => restored)

    const { SessionManager } = await import('./sessionManager')
    const manager = new SessionManager(null, null, null, beforeAgentSessionStart)
    const first = await manager.spawn({
      kind: 'codex',
      cwd: '/recorded/worktree',
      resumeSessionId: 'provider-a',
    })
    const replacement = manager.spawn({
      kind: 'codex',
      cwd: '/recorded/worktree',
      resumeSessionId: 'provider-a',
      predecessorSessionId: first.sessionId,
    })

    await compensationEntered.promise
    await expect(manager.killOwned({
      sessionId: first.sessionId,
      kind: 'codex',
      cwd: '/recorded/worktree',
    })).resolves.toBe(true)
    compensationPreflight.resolve()
    await expect(replacement).rejects.toThrow('recorded successor start failure')

    expect(createSession).toHaveBeenCalledTimes(2)
    expect(restored.start).not.toHaveBeenCalled()
    expect(manager.list()).toEqual([])
  })

  it('waits for an interrupted predecessor recovery generation before compensation', async () => {
    const recoveryStartGate = deferred<void>()
    const order: string[] = []
    const predecessorStopped = { value: false }
    const recovery = new LeaseAwareCodexSession(
      'recovery', order, predecessorStopped, false,
    )
    const successor = new LeaseAwareCodexSession(
      'successor', order, predecessorStopped, true,
    )
    const restored = new LeaseAwareCodexSession(
      'restored', order, predecessorStopped, true,
    )
    recovery.blockStartOn(recoveryStartGate.promise)
    successor.failStartWith(new Error('recorded successor start failure'))
    createSession
      .mockImplementationOnce(() => recovery)
      .mockImplementationOnce(options => installBoundaryFromCreateOptions(successor, options))
      .mockImplementationOnce(() => restored)

    const { SessionManager } = await import('./sessionManager')
    const manager = new SessionManager()
    const recoveryAttempt = manager.recover({
      sessionId: 'recovering-predecessor',
      kind: 'codex',
      cwd: '/recorded/worktree',
      resumeSessionId: 'provider-a',
    })
    await vi.waitFor(() => expect(recovery.start).toHaveBeenCalledTimes(1))
    const replacement = manager.spawn({
      kind: 'codex',
      cwd: '/recorded/worktree',
      resumeSessionId: 'provider-a',
      predecessorSessionId: 'recovering-predecessor',
    })
    const observedReplacement = replacement.catch(error => error)

    await vi.waitFor(() => expect(successor.start).toHaveBeenCalledTimes(1))
    expect(createSession).toHaveBeenCalledTimes(2)
    recoveryStartGate.resolve()
    await expect(recoveryAttempt).resolves.toMatchObject({
      ok: false,
      code: 'cancelled',
    })
    await expect(observedReplacement).resolves.toBeInstanceOf(Error)

    expect(createSession).toHaveBeenCalledTimes(3)
    expect(restored.start).toHaveBeenCalledTimes(1)
    expect(manager.list()).toContain('recovering-predecessor')
  })

  it('joins a naturally exited predecessor before acquiring successor ownership', async () => {
    const ownershipBoundary = deferred<void>()
    const order: string[] = []
    const predecessorStopped = { value: false }
    const predecessor = new LeaseAwareCodexSession(
      'predecessor', order, predecessorStopped, false,
    )
    const successor = new LeaseAwareCodexSession(
      'successor', order, predecessorStopped, true,
    )
    successor.blockOwnershipBoundaryOn(ownershipBoundary.promise)
    createSession
      .mockImplementationOnce(() => predecessor)
      .mockImplementationOnce(options => installBoundaryFromCreateOptions(successor, options))

    const { SessionManager } = await import('./sessionManager')
    const manager = new SessionManager()
    const first = await manager.spawn({
      kind: 'codex',
      cwd: '/recorded/worktree',
      resumeSessionId: 'provider-a',
    })
    const replacement = manager.spawn({
      kind: 'codex',
      cwd: '/recorded/worktree',
      resumeSessionId: 'provider-a',
      predecessorSessionId: first.sessionId,
    })

    await vi.waitFor(() => expect(successor.start).toHaveBeenCalledTimes(1))
    predecessor.emit('exit', { exitCode: 0 })
    expect(manager.list()).not.toContain(first.sessionId)
    ownershipBoundary.resolve()
    await expect(replacement).resolves.toMatchObject({
      sessionId: expect.any(String),
    })

    expect(predecessor.stop).toHaveBeenCalledTimes(1)
    expect(successor.start).toHaveBeenCalledTimes(1)
  })

  it('does not treat an explicit predecessor close as a natural-exit handoff', async () => {
    const ownershipBoundary = deferred<void>()
    const order: string[] = []
    const predecessorStopped = { value: false }
    const predecessor = new LeaseAwareCodexSession(
      'predecessor', order, predecessorStopped, false,
    )
    const successor = new LeaseAwareCodexSession(
      'successor', order, predecessorStopped, true,
    )
    successor.blockOwnershipBoundaryOn(ownershipBoundary.promise)
    createSession
      .mockImplementationOnce(() => predecessor)
      .mockImplementationOnce(options => installBoundaryFromCreateOptions(successor, options))

    const { SessionManager } = await import('./sessionManager')
    const manager = new SessionManager()
    const first = await manager.spawn({
      kind: 'codex',
      cwd: '/recorded/worktree',
      resumeSessionId: 'provider-a',
    })
    const replacement = manager.spawn({
      kind: 'codex',
      cwd: '/recorded/worktree',
      resumeSessionId: 'provider-a',
      predecessorSessionId: first.sessionId,
    })

    await vi.waitFor(() => expect(successor.start).toHaveBeenCalledTimes(1))
    await expect(manager.killOwned({
      sessionId: first.sessionId,
      kind: 'codex',
      cwd: '/recorded/worktree',
    })).resolves.toBe(true)
    ownershipBoundary.resolve()
    await expect(replacement).rejects.toThrow()

    expect(predecessor.stop).toHaveBeenCalledTimes(1)
    expect(manager.list()).toEqual([])
  })

  it('does not let recovery R cancel the later compensation generation C', async () => {
    const recoveryStartGate = deferred<void>()
    const compensationPreflight = deferred<void>()
    const compensationEntered = deferred<void>()
    let preflightCalls = 0
    const beforeAgentSessionStart = vi.fn(async () => {
      preflightCalls += 1
      if (preflightCalls === 3) {
        compensationEntered.resolve()
        await compensationPreflight.promise
      }
    })
    const order: string[] = []
    const predecessorStopped = { value: false }
    const recovery = new LeaseAwareCodexSession(
      'recovery', order, predecessorStopped, false,
    )
    const successor = new LeaseAwareCodexSession(
      'successor', order, predecessorStopped, true,
    )
    const restored = new LeaseAwareCodexSession(
      'restored', order, predecessorStopped, true,
    )
    recovery.blockStartOn(recoveryStartGate.promise)
    successor.failStartWith(new Error('recorded successor start failure'))
    createSession
      .mockImplementationOnce(() => recovery)
      .mockImplementationOnce(options => installBoundaryFromCreateOptions(successor, options))
      .mockImplementationOnce(() => restored)

    const { SessionManager } = await import('./sessionManager')
    const manager = new SessionManager(null, null, null, beforeAgentSessionStart)
    const recoveryAttempt = manager.recover({
      sessionId: 'recovering-predecessor',
      kind: 'codex',
      cwd: '/recorded/worktree',
      resumeSessionId: 'provider-a',
      // WHY the token is part of the recorded race: the renderer timeout owns
      // recovery generation R, not every future claim that happens to reuse
      // the same stable local id.
      recoveryToken: 'recovery-r',
    } as never)
    await vi.waitFor(() => expect(recovery.start).toHaveBeenCalledTimes(1))
    const replacement = manager.spawn({
      kind: 'codex',
      cwd: '/recorded/worktree',
      resumeSessionId: 'provider-a',
      predecessorSessionId: 'recovering-predecessor',
    })
    const observedReplacement = replacement.catch(error => error)

    await vi.waitFor(() => expect(successor.start).toHaveBeenCalledTimes(1))
    recoveryStartGate.resolve()
    await expect(recoveryAttempt).resolves.toMatchObject({
      ok: false,
      code: 'cancelled',
    })
    await compensationEntered.promise

    await expect(manager.cancelRecovery({
      sessionId: 'recovering-predecessor',
      kind: 'codex',
      cwd: '/recorded/worktree',
      recoveryToken: 'recovery-r',
    } as never)).resolves.toBe(false)
    compensationPreflight.resolve()
    await expect(observedReplacement).resolves.toBeInstanceOf(Error)

    expect(restored.start).toHaveBeenCalledTimes(1)
    expect(manager.getBackendSnapshot('recovering-predecessor')).toMatchObject({
      sessionId: 'recovering-predecessor',
      kind: 'codex',
      lifecycle: 'live',
    })
  })

  it('reclaims an unpersisted live successor when a fresh renderer recovers the predecessor id', async () => {
    const order: string[] = []
    const predecessorStopped = { value: false }
    const predecessor = new LeaseAwareCodexSession(
      'predecessor', order, predecessorStopped, false,
    )
    const successor = new LeaseAwareCodexSession(
      'successor', order, predecessorStopped, true,
    )
    const restored = new LeaseAwareCodexSession(
      'restored', order, predecessorStopped, true,
    )
    createSession
      .mockImplementationOnce(() => predecessor)
      .mockImplementationOnce(options => installBoundaryFromCreateOptions(successor, options))
      .mockImplementationOnce(() => restored)

    const { SessionManager } = await import('./sessionManager')
    const manager = new SessionManager()
    const first = await manager.spawn({
      kind: 'codex',
      cwd: '/recorded/worktree',
      resumeSessionId: 'provider-a',
    })
    const replacement = await manager.spawn({
      kind: 'codex',
      cwd: '/recorded/worktree',
      resumeSessionId: 'provider-a',
      predecessorSessionId: first.sessionId,
    })

    // The initiating renderer disappeared before it could remap/persist the
    // random successor id. A newly booted renderer therefore asks for the
    // still-durable predecessor id and explicitly authorizes transaction
    // reclamation rather than receiving a transient ownership conflict.
    await expect(manager.recover({
      sessionId: first.sessionId,
      kind: 'codex',
      cwd: '/recorded/worktree',
      // Reclamation restores the main-captured predecessor identity; a stale
      // renderer cannot retarget the capability at another transcript merely
      // because it knows the local ownership tuple.
      resumeSessionId: 'stale-renderer-wrong-provider-id',
      recoveryToken: 'fresh-renderer-recovery',
      reclaimPendingReplacement: true,
    } as never)).resolves.toMatchObject({
      ok: true,
      snapshot: {
        sessionId: first.sessionId,
        kind: 'codex',
        lifecycle: 'live',
      },
    })

    expect(replacement).toMatchObject({
      sessionId: expect.any(String),
      replacementTransactionId: expect.any(String),
    })
    expect(successor.stop).toHaveBeenCalledTimes(1)
    expect(restored.start).toHaveBeenCalledTimes(1)
    expect(createSession.mock.calls[2]?.[0]).toMatchObject({
      resumeSessionId: 'provider-a',
    })
    expect(manager.list()).toEqual([first.sessionId])
  })

  it('keeps a stale-renderer redirect after durable successor acknowledgement', async () => {
    const successorStopGate = deferred<void>()
    const order: string[] = []
    const predecessorStopped = { value: false }
    const predecessor = new LeaseAwareCodexSession(
      'predecessor', order, predecessorStopped, false,
    )
    const successor = new LeaseAwareCodexSession(
      'successor', order, predecessorStopped, true, successorStopGate.promise,
    )
    const restored = new LeaseAwareCodexSession(
      'restored', order, predecessorStopped, true,
    )
    createSession
      .mockImplementationOnce(() => predecessor)
      .mockImplementationOnce(options => installBoundaryFromCreateOptions(successor, options))
      .mockImplementationOnce(() => restored)

    const { SessionManager } = await import('./sessionManager')
    const manager = new SessionManager()
    const first = await manager.spawn({
      kind: 'codex',
      cwd: '/recorded/worktree',
      resumeSessionId: 'provider-a',
    })
    const replacement = await manager.spawn({
      kind: 'codex',
      cwd: '/recorded/worktree',
      resumeSessionId: 'provider-a',
      predecessorSessionId: first.sessionId,
    })

    // Model the atomic workspace rename winning immediately after a new
    // renderer had already loaded the previous bytes. Durable acknowledgement
    // may retire the active transaction, but not the evidence that lets that
    // stale renderer stop the exact successor before reclaiming oldId.
    manager.acknowledgePersistedSessionOwnership(new Set([
      replacement.sessionId,
    ]))
    const firstStaleRecovery = manager.recover({
      sessionId: first.sessionId,
      kind: 'codex',
      cwd: '/recorded/worktree',
      resumeSessionId: 'provider-a',
      recoveryToken: 'stale-renderer-after-persist',
      reclaimPendingReplacement: true,
    })
    await vi.waitFor(() => expect(successor.stop).toHaveBeenCalledTimes(1))
    const joinedStaleRecovery = manager.recover({
      sessionId: first.sessionId,
      kind: 'codex',
      cwd: '/recorded/worktree',
      resumeSessionId: 'provider-a',
      recoveryToken: 'second-stale-renderer-request',
      reclaimPendingReplacement: true,
    })
    expect(joinedStaleRecovery).toBe(firstStaleRecovery)
    successorStopGate.resolve()

    await expect(firstStaleRecovery).resolves.toMatchObject({
      ok: true,
      snapshot: { sessionId: first.sessionId, lifecycle: 'live' },
    })

    expect(successor.stop).toHaveBeenCalledTimes(1)
    expect(restored.start).toHaveBeenCalledTimes(1)
    expect(manager.list()).toEqual([first.sessionId])
  })

  it('reclaims through a newer in-flight replacement without racing its generation', async () => {
    const secondSuccessorGate = deferred<void>()
    const order: string[] = []
    const predecessorStopped = { value: false }
    const predecessor = new LeaseAwareCodexSession(
      'predecessor', order, predecessorStopped, false,
    )
    const firstSuccessor = new LeaseAwareCodexSession(
      'successor', order, predecessorStopped, true,
    )
    const secondSuccessor = new LeaseAwareCodexSession(
      'successor', order, predecessorStopped, true,
    )
    const restored = new LeaseAwareCodexSession(
      'restored', order, predecessorStopped, true,
    )
    secondSuccessor.blockStartOn(secondSuccessorGate.promise)
    createSession
      .mockImplementationOnce(() => predecessor)
      .mockImplementationOnce(options => installBoundaryFromCreateOptions(firstSuccessor, options))
      .mockImplementationOnce(options => installBoundaryFromCreateOptions(secondSuccessor, options))
      .mockImplementationOnce(() => restored)

    const { SessionManager } = await import('./sessionManager')
    const manager = new SessionManager()
    const first = await manager.spawn({
      kind: 'codex',
      cwd: '/recorded/worktree',
      resumeSessionId: 'provider-a',
    })
    const firstReplacement = await manager.spawn({
      kind: 'codex',
      cwd: '/recorded/worktree',
      resumeSessionId: 'provider-a',
      predecessorSessionId: first.sessionId,
    })
    manager.acknowledgePersistedSessionOwnership(new Set([
      firstReplacement.sessionId,
    ]))

    const secondReplacement = manager.spawn({
      kind: 'codex',
      cwd: '/recorded/worktree',
      resumeSessionId: 'provider-a',
      predecessorSessionId: firstReplacement.sessionId,
    })
    const observedSecondReplacement = secondReplacement.catch(error => error)
    await vi.waitFor(() => expect(secondSuccessor.start).toHaveBeenCalledTimes(1))

    const staleRecovery = manager.recover({
      sessionId: first.sessionId,
      kind: 'codex',
      cwd: '/recorded/worktree',
      resumeSessionId: 'provider-a',
      recoveryToken: 'stale-renderer-through-newer-replacement',
      reclaimPendingReplacement: true,
    })
    await vi.waitFor(() => expect(secondSuccessor.stop).toHaveBeenCalledTimes(1))
    secondSuccessorGate.resolve()

    await expect(observedSecondReplacement).resolves.toBeInstanceOf(Error)
    await expect(staleRecovery).resolves.toMatchObject({
      ok: true,
      snapshot: { sessionId: first.sessionId, lifecycle: 'live' },
    })
    expect(restored.start).toHaveBeenCalledTimes(1)
    expect(manager.list()).toEqual([first.sessionId])
  })

  it('does not restore a committed redirect when the stale pane closes during reclaim', async () => {
    const successorStopGate = deferred<void>()
    const order: string[] = []
    const predecessorStopped = { value: false }
    const predecessor = new LeaseAwareCodexSession(
      'predecessor', order, predecessorStopped, false,
    )
    const successor = new LeaseAwareCodexSession(
      'successor', order, predecessorStopped, true, successorStopGate.promise,
    )
    const restored = new LeaseAwareCodexSession(
      'restored', order, predecessorStopped, true,
    )
    createSession
      .mockImplementationOnce(() => predecessor)
      .mockImplementationOnce(options => installBoundaryFromCreateOptions(successor, options))
      .mockImplementationOnce(() => restored)

    const { SessionManager } = await import('./sessionManager')
    const manager = new SessionManager()
    const first = await manager.spawn({
      kind: 'codex',
      cwd: '/recorded/worktree',
      resumeSessionId: 'provider-a',
    })
    const replacement = await manager.spawn({
      kind: 'codex',
      cwd: '/recorded/worktree',
      resumeSessionId: 'provider-a',
      predecessorSessionId: first.sessionId,
    })
    manager.acknowledgePersistedSessionOwnership(new Set([
      replacement.sessionId,
    ]))

    const reclaim = manager.recover({
      sessionId: first.sessionId,
      kind: 'codex',
      cwd: '/recorded/worktree',
      resumeSessionId: 'provider-a',
      recoveryToken: 'stale-reclaim-before-close',
      reclaimPendingReplacement: true,
    })
    await vi.waitFor(() => expect(successor.stop).toHaveBeenCalledTimes(1))
    const closing = manager.killOwned({
      sessionId: first.sessionId,
      kind: 'codex',
      cwd: '/recorded/worktree',
    })
    successorStopGate.resolve()

    await expect(closing).resolves.toBe(true)
    await expect(reclaim).resolves.toMatchObject({
      ok: false,
      code: 'cancelled',
    })
    expect(restored.start).not.toHaveBeenCalled()
    expect(manager.list()).toEqual([])
  })
})
