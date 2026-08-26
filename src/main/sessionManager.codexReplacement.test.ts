import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import recordedLeaseFailure from '../../testing/fixtures/session-lifecycle/codex-reload-exact-lease.json'
import type { SessionSpawnOptions } from '@preload/api/types.js'

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
    if (this.label === 'predecessor') this.predecessorStopped.value = true
  })

  readonly write = vi.fn()
  readonly resize = vi.fn()

  constructor(
    private readonly label: 'predecessor' | 'successor',
    private readonly order: string[],
    private readonly predecessorStopped: { value: boolean },
    private readonly requirePredecessorStop: boolean,
  ) {
    super()
  }
}

describe('SessionManager Codex replacement handoff', () => {
  beforeEach(() => {
    createSession.mockReset()
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
    const manager = new SessionManager()
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
  })
})
