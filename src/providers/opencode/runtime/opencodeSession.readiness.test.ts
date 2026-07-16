import { describe, expect, it, vi } from 'vitest'

vi.mock('opencode-headless', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    OpencodeHeadless: class FakeOpencodeHeadless extends EventEmitter {
      readonly screen = new EventEmitter()
      readonly committed = new EventEmitter()
      readonly semantic = new EventEmitter()
      async start(): Promise<void> {}
      async stop(): Promise<void> {}
    },
  }
})

import { OpencodeSession } from './opencodeSession.js'

describe('OpencodeSession composer readiness', () => {
  it('becomes ready only after headless startup and history publication finish', async () => {
    const session = new OpencodeSession({ cwd: '/tmp/project' })
    const seen: boolean[] = []
    session.on('input-readiness', input => seen.push(input.ready))

    await session.start()

    expect(seen).toEqual([false, true])
  })
})
