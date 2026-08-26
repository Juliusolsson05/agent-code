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

class LeaseAwareCodexSession extends EventEmitter {
  readonly start = vi.fn(async (): Promise<void> => {
    this.order.push(`${this.label}:start`)
    if (this.requirePredecessorStop && !this.predecessorStopped.value) {
      // WHY the fake rejects at start instead of pretending the coordinator is
      // a UI concern: all five #638 attempts reached provider.start.begin and
      // then failed at exact-path reservation. The fixture preserves that
      // production boundary while keeping private rollout paths out of git.
      throw new Error(recordedLeaseFailure.failure)
    }
    this.emit('started', { projectDir: '/recorded/worktree' })
  })

  readonly stop = vi.fn(async (): Promise<void> => {
    this.order.push(`${this.label}:stop`)
    await this.stopGate
    if (this.label === 'predecessor') this.predecessorStopped.value = true
  })

  readonly write = vi.fn()
  readonly resize = vi.fn()

  constructor(
    private readonly label: 'predecessor' | 'successor',
    private readonly order: string[],
    private readonly predecessorStopped: { value: boolean },
    private readonly requirePredecessorStop: boolean,
    private readonly stopGate: Promise<void> = Promise.resolve(),
  ) {
    super()
  }
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
      .mockImplementationOnce(() => successor)

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
      .mockImplementationOnce(() => successor)

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
      .mockImplementationOnce(() => successor)
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
      .mockImplementationOnce(() => successor)

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
      .mockImplementationOnce(() => successor)

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
})
