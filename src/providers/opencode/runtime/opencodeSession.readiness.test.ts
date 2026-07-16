import { beforeEach, describe, expect, it, vi } from 'vitest'

const headlessControl = vi.hoisted(() => ({
  exitDuringStart: false,
  stop: vi.fn(async (): Promise<void> => {}),
}))

vi.mock('opencode-headless', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    OpencodeHeadless: class FakeOpencodeHeadless extends EventEmitter {
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

import { OpencodeSession } from './opencodeSession.js'

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
})
