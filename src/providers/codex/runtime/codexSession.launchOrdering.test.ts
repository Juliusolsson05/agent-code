import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { beforeEach, describe, expect, it, vi } from 'vitest'

const launch = vi.hoisted(() => ({
  events: [] as string[],
  configMode: 'recorded-safe',
  resumeBarrier: Promise.resolve() as Promise<void>,
  releaseResume: (() => undefined) as () => void,
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
      kill: () => undefined,
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
    async stop(): Promise<void> {}
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
      await launch.resumeBarrier
      launch.events.push('resume:end')
      return { dispose: async () => undefined }
    },
    prepareCodex01491PromptInputProfile: async () => {
      launch.events.push(`profile:${launch.configMode}`)
      if (launch.configMode !== 'recorded-safe') {
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
  launch.resumeBarrier = new Promise<void>(resolve => {
    launch.releaseResume = resolve
  })
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
})
