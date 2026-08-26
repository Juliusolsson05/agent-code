import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { beforeEach, describe, expect, it, vi } from 'vitest'

const launch = vi.hoisted(() => ({
  events: [] as string[],
  configMode: 'recorded-safe',
  resumeBarrier: Promise.resolve() as Promise<void>,
  releaseResume: (() => undefined) as () => void,
  reserveResumeBeforeReturn: false,
  resumeLeaseActive: false,
  profileBarrier: Promise.resolve() as Promise<void>,
  releaseProfile: (() => undefined) as () => void,
  headlessOptions: null as null | Record<string, unknown>,
}))

vi.mock('node-pty', () => ({
  spawn: () => {
    launch.events.push('pty:spawn')
    return {
      pid: 123,
      process: 'recorded-codex',
      write: () => undefined,
      resize: () => undefined,
      kill: () => { launch.events.push('pty:kill') },
      onData: () => ({ dispose: () => undefined }),
      onExit: () => ({ dispose: () => undefined }),
    }
  },
}))

vi.mock('codex-headless', () => {
  class FakeCodexHeadless {
    semantic = { on: () => this.semantic }

    constructor(options: Record<string, unknown>) {
      launch.events.push('headless:construct')
      launch.headlessOptions = options
    }

    on(): this { return this }
    async start() {
      launch.events.push('headless:start')
      return { sessionsDir: '/recorded/codex/sessions' }
    }
    async stop(): Promise<void> { launch.events.push('headless:stop') }
  }

  return {
    CodexHeadless: FakeCodexHeadless,
    CodexResponsesAdapter: class {
      attach(): void {}
      detach(): void {}
    },
    ResponsesProxy: class {
      static async create(): Promise<never> {
        throw new Error('proxy is outside this launch-order recording')
      }
    },
    prepareCodexResumeRollout: async () => {
      launch.events.push('resume:start')
      if (launch.reserveResumeBeforeReturn) {
        if (launch.resumeLeaseActive) {
          launch.events.push('resume:lease-conflict')
          throw new Error('recorded exact rollout is already leased')
        }
        // WHY the real factory reserves exact X before it finishes reading the
        // copied lineage and returns the public capability. The old mock placed
        // every side effect after its barrier, so it could never expose the
        // interval where stop sees no handle but a replacement sees A's lease.
        launch.resumeLeaseActive = true
        launch.events.push('resume:reserved')
      }
      await launch.resumeBarrier
      launch.events.push('resume:end')
      let disposed = false
      return {
        dispose: async (clean?: boolean) => {
          if (disposed) return
          disposed = true
          if (launch.reserveResumeBeforeReturn) {
            launch.resumeLeaseActive = false
          }
          launch.events.push(`preparation:dispose:${clean}`)
        },
      }
    },
    prepareCodex01491PromptInputProfile: async () => {
      // WHY capture the projected result before the barrier: the fixture models
      // one real config/read operation whose response has not returned yet, not
      // a second read after cancellation. Tests may move only completion order;
      // they must not mutate what that already-admitted provider read observed.
      const configMode = launch.configMode
      launch.events.push(`profile:${configMode}`)
      await launch.profileBarrier
      if (configMode !== 'recorded-safe') {
        return { ok: false, reason: 'effective-config-unverified' as const }
      }
      return {
        ok: true,
        profile: {
          cliArgs: [
            '--config', 'tui.keymap.composer.submit="enter"',
            '--config', 'tui.keymap.composer.queue="tab"',
            '--config', 'tui.vim_mode_default=false',
            '--config', 'tui.keymap.global.toggle_vim_mode=[]',
          ],
        },
      }
    },
  }
})

import { CodexSession } from './codexSession.js'

type RecordedConfigRead = {
  effectiveInputProjection: {
    composerSubmit: string
    composerQueue: string
  }
}

const recorded = JSON.parse(readFileSync(fileURLToPath(new URL(
  '../../../../packages/codex-headless/testing/fixtures/prompt-input/' +
    'codex-01491-config-read-recorded.json',
  import.meta.url,
)), 'utf8')) as RecordedConfigRead

beforeEach(() => {
  launch.events = []
  launch.configMode = 'recorded-safe'
  launch.headlessOptions = null
  launch.reserveResumeBeforeReturn = false
  launch.resumeLeaseActive = false
  launch.resumeBarrier = new Promise<void>(resolve => {
    launch.releaseResume = resolve
  })
  launch.profileBarrier = Promise.resolve()
  launch.releaseProfile = () => undefined
})

describe('CodexSession resume launch attestation ordering', () => {
  it('makes config/read the final await before spawning the resumed PTY', async () => {
    expect(recorded.effectiveInputProjection).toMatchObject({
      composerSubmit: 'enter',
      composerQueue: 'tab',
    })
    const session = new CodexSession({
      binary: 'recorded-codex',
      cwd: '/recorded/worktree',
      resumeSessionId: '00000000-0000-4000-8000-000000000632',
      useProxy: false,
    })
    const starting = session.start()
    await vi.waitFor(() => {
      expect(launch.events).toContain('resume:start')
    })

    // WHY the barrier models the real recursive exact-rollout discovery from
    // the tenth gate. The safe and conflicting modes are the same deterministic
    // shell projections used by the package tests. Attesting before this await
    // lets managed policy change while the parent still holds a stale issued
    // profile; attesting after it makes refusal the last async decision before
    // the process reads that policy itself.
    expect(launch.events).toEqual(['resume:start'])
    launch.configMode = 'conflicting-binding'
    launch.releaseResume()
    await starting

    expect(launch.events).toEqual([
      'resume:start',
      'resume:end',
      'profile:conflicting-binding',
      'pty:spawn',
      'headless:construct',
      'headless:start',
    ])
    expect(launch.headlessOptions?.promptInputProfile).toBeUndefined()
    await session.stop()
  })

  it('does not resurrect a resumed provider stopped during the final safe config read', async () => {
    expect(recorded.effectiveInputProjection).toMatchObject({
      composerSubmit: 'enter',
      composerQueue: 'tab',
    })
    launch.profileBarrier = new Promise<void>(resolve => {
      launch.releaseProfile = resolve
    })
    const session = new CodexSession({
      binary: 'recorded-codex',
      cwd: '/recorded/worktree',
      resumeSessionId: '00000000-0000-4000-8000-000000000632',
      useProxy: false,
    })
    const starting = session.start()
    const startOutcome = starting.then(
      () => 'resolved' as const,
      () => 'rejected' as const,
    )

    try {
      await vi.waitFor(() => {
        expect(launch.events).toEqual(['resume:start'])
      })
      launch.releaseResume()
      await vi.waitFor(() => {
        expect(launch.events).toEqual([
          'resume:start',
          'resume:end',
          'profile:recorded-safe',
        ])
      })

      // WHY this is the real cancellation window omitted by the prior ordering
      // control: exact X and its lineage watcher are already reserved, while the
      // final recorded-safe config/read is still awaiting its response. stop()
      // must synchronously close future launch admission and dispose that sole
      // pre-spawn owner. Merely cleaning up the fields visible *at this instant*
      // lets the continuation after the await spawn a provider into a pane the
      // user already closed, with nobody left to stop its headless/tail lifecycle.
      await session.stop()
      const disposedBeforeConfigReturned = launch.events.includes(
        'preparation:dispose:true',
      )

      launch.releaseProfile()
      await startOutcome

      expect.soft(disposedBeforeConfigReturned).toBe(true)
      expect.soft(
        launch.events.filter(event => event === 'preparation:dispose:true'),
      ).toHaveLength(1)
      expect.soft(
        launch.events.filter(event => event === 'pty:spawn'),
      ).toEqual([])
      expect.soft(
        launch.events.filter(event => event === 'headless:construct'),
      ).toEqual([])
      expect(
        launch.events.filter(event => event === 'headless:start'),
      ).toEqual([])
    } finally {
      // Idempotent release/stop keeps the RED contract from stranding a future
      // test even when an assertion exposes the current late-spawn bug.
      launch.releaseProfile()
      await startOutcome
      await session.stop()
    }
  })

  it('disposes a resume capability that materializes after its generation was stopped', async () => {
    const session = new CodexSession({
      binary: 'recorded-codex',
      cwd: '/recorded/worktree',
      resumeSessionId: '00000000-0000-4000-8000-000000000632',
      useProxy: false,
    })
    const starting = session.start()
    const startOutcome = starting.then(
      () => 'resolved' as const,
      () => 'rejected' as const,
    )

    try {
      await vi.waitFor(() => expect(launch.events).toEqual(['resume:start']))
      await session.stop()
      launch.releaseResume()
      await startOutcome

      // WHY stop cannot dispose a capability the provider locator has not
      // returned yet. The cancelled continuation becomes the sole owner at the
      // instant the await resolves, so it must dispose locally before profile
      // attestation or any synchronous launch work. Publishing it to a shared
      // field first would let a newer generation inherit the stale ownership.
      expect(launch.events).toEqual([
        'resume:start',
        'resume:end',
        'preparation:dispose:true',
      ])
    } finally {
      launch.releaseResume()
      await startOutcome
      await session.stop()
    }
  })

  it('joins an exact reservation made before the preparation handle returns', async () => {
    launch.reserveResumeBeforeReturn = true
    const session = new CodexSession({
      binary: 'recorded-codex',
      cwd: '/recorded/worktree',
      resumeSessionId: '00000000-0000-4000-8000-000000000632',
      useProxy: false,
    })
    const firstStart = session.start()
    const firstOutcome = firstStart.then(
      () => 'resolved' as const,
      () => 'rejected' as const,
    )
    let restartOutcome: Promise<'resolved' | 'rejected'> | null = null

    try {
      await vi.waitFor(() => expect(launch.events).toEqual([
        'resume:start',
        'resume:reserved',
      ]))
      const stopping = session.stop()
      const restarting = session.start()
      restartOutcome = restarting.then(
        () => 'resolved' as const,
        () => 'rejected' as const,
      )

      // WHY stop and restart overlap deliberately. A owns exact X even though
      // its public rollback handle is still behind the recorded lineage-read
      // barrier. B must remain behind A's joined cleanup; trying its own prepare
      // immediately turns an orderly restart into a false lease collision.
      launch.releaseResume()
      await stopping
      await firstOutcome
      await expect(restartOutcome).resolves.toBe('resolved')

      expect(launch.events).not.toContain('resume:lease-conflict')
      expect(launch.events.filter(event => event === 'resume:reserved'))
        .toHaveLength(2)
      expect(launch.events.indexOf('preparation:dispose:true'))
        .toBeLessThan(launch.events.lastIndexOf('resume:start'))
      expect(launch.events.filter(event => event === 'pty:spawn')).toHaveLength(1)
    } finally {
      launch.releaseResume()
      await firstOutcome
      await restartOutcome
      await session.stop()
      launch.resumeLeaseActive = false
    }
  })

  it('does not let a cancelled generation clean a later successful restart', async () => {
    launch.profileBarrier = new Promise<void>(resolve => {
      launch.releaseProfile = resolve
    })
    const releaseFirstProfile = (): void => launch.releaseProfile()
    const session = new CodexSession({
      binary: 'recorded-codex',
      cwd: '/recorded/worktree',
      resumeSessionId: '00000000-0000-4000-8000-000000000632',
      useProxy: false,
    })
    const firstStart = session.start()
    const firstOutcome = firstStart.then(
      () => 'resolved' as const,
      () => 'rejected' as const,
    )
    let secondOutcome: Promise<'resolved' | 'rejected'> | null = null

    try {
      await vi.waitFor(() => expect(launch.events).toEqual(['resume:start']))
      launch.releaseResume()
      await vi.waitFor(() => expect(launch.events).toEqual([
        'resume:start',
        'resume:end',
        'profile:recorded-safe',
      ]))
      const releaseCancelledProfile = launch.releaseProfile
      await session.stop()

      // The second generation uses an independently completed config/read while
      // the cancelled first generation remains suspended on its old response.
      // This is the overlap that makes a shared boolean or unconditional field
      // nulling unsafe: A's continuation runs only after B is fully live.
      launch.profileBarrier = Promise.resolve()
      const secondStart = session.start()
      secondOutcome = secondStart.then(
        () => 'resolved' as const,
        () => 'rejected' as const,
      )
      await expect(secondOutcome).resolves.toBe('resolved')
      releaseCancelledProfile()
      await firstOutcome

      expect(launch.events.filter(event => event === 'pty:spawn')).toHaveLength(1)
      expect(launch.events.filter(event => event === 'headless:construct'))
        .toHaveLength(1)
      expect(launch.events.filter(event => event === 'headless:start'))
        .toHaveLength(1)
      expect(launch.events.filter(event => event === 'headless:stop')).toEqual([])
      expect(launch.events.filter(event => event === 'pty:kill')).toEqual([])
      expect(session.getProcessPid()).toBe(123)
    } finally {
      releaseFirstProfile()
      await firstOutcome
      await secondOutcome
      await session.stop()
    }
  })
})
