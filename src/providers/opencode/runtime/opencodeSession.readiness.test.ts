import { beforeEach, describe, expect, it, vi } from 'vitest'

const headlessControl = vi.hoisted(() => ({
  exitDuringStart: false,
  rejectStart: null as Error | null,
  stop: vi.fn(async (): Promise<void> => {}),
  options: [] as Array<Record<string, unknown>>,
}))

vi.mock('opencode-headless', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    OpencodeHeadless: class FakeOpencodeHeadless extends EventEmitter {
      constructor(options: Record<string, unknown>) {
        super()
        headlessControl.options.push(options)
      }
      readonly screen = new EventEmitter()
      readonly committed = new EventEmitter()
      readonly semantic = new EventEmitter()
      async start(): Promise<void> {
        if (headlessControl.exitDuringStart) this.emit('exit', { exitCode: 17 })
        if (headlessControl.rejectStart) throw headlessControl.rejectStart
      }
      async stop(): Promise<void> {
        await headlessControl.stop()
      }
    },
  }
})

import { OPENCODE_SERVE_STARTUP_TIMEOUT_MS, OpencodeSession } from './opencodeSession.js'

describe('OpencodeSession composer readiness', () => {
  beforeEach(() => {
    headlessControl.exitDuringStart = false
    headlessControl.rejectStart = null
    headlessControl.stop.mockClear()
  })

  it('becomes ready only after headless startup and history publication finish', async () => {
    const session = new OpencodeSession({ cwd: '/tmp/project' })
    const seen: boolean[] = []
    session.on('input-readiness', input => seen.push(input.ready))

    await session.start()

    expect(seen).toEqual([false, true])
  })

  it('never emits ready or started when the server exits during startup', async () => {
    headlessControl.exitDuringStart = true
    const session = new OpencodeSession({ cwd: '/tmp/project' })
    const readiness: boolean[] = []
    const started = vi.fn()
    const exited = vi.fn()
    session.on('input-readiness', input => readiness.push(input.ready))
    session.on('started', started)
    session.on('exit', exited)

    await expect(session.start()).rejects.toThrow('opencode exited during startup')

    expect(readiness).toEqual([false, false])
    expect(exited).toHaveBeenCalledWith({ exitCode: 17 })
    expect(started).not.toHaveBeenCalled()
    expect(headlessControl.stop).toHaveBeenCalledTimes(1)
  })

  // #1355: the package's serve readiness default (10 s) was sized for an idle
  // machine; under load a healthy server took 16.7-43.1 s to report its URL
  // (plan evidence). The app owns the process and passes its own wait.
  it('gives the spawned server the load-tolerant startup wait', async () => {
    headlessControl.options.length = 0
    await new OpencodeSession({ cwd: '/tmp/project' }).start()
    expect(headlessControl.options.at(-1)).toMatchObject({ startupTimeoutMs: OPENCODE_SERVE_STARTUP_TIMEOUT_MS })
    // At least twice the worst healthy start measured (43.1 s), the margin the
    // constant's comment claims; merely above it (#1367 review a: 44 s passed)
    // would fail the next slightly slower machine.
    expect(OPENCODE_SERVE_STARTUP_TIMEOUT_MS).toBeGreaterThanOrEqual(2 * 43_100)
    // And at most about four times it (#1367 review c): the wait is also how
    // long a serve that stays alive but never listens holds the pane on
    // "starting". A stray zero (1_200_000) would make that twenty minutes.
    expect(OPENCODE_SERVE_STARTUP_TIMEOUT_MS).toBeLessThanOrEqual(4 * 43_100)
  })

  // #1367 review c: a start that rejects after the server is already up (a
  // resume whose history replay fails) must stop the server it spawned. With
  // the longer wait this rollback is where every rejected start ends, and
  // without it a live `opencode serve` child outlives the pane that owned it.
  it('stops the server when startup rejects', async () => {
    headlessControl.rejectStart = new Error('history replay failed')
    const session = new OpencodeSession({ cwd: '/tmp/project' })
    await expect(session.start()).rejects.toThrow('history replay failed')
    expect(headlessControl.stop).toHaveBeenCalledTimes(1)
  })
})
