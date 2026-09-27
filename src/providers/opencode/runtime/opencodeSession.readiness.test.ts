import { beforeEach, describe, expect, it, vi } from 'vitest'

const headlessControl = vi.hoisted(() => ({
  exitDuringStart: false,
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
  })
})
