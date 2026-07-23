import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ConditionCustomAction } from '@shared/types/providerConditions'

const headlessControl = vi.hoisted(() => ({
  exitDuringStart: false,
  stop: vi.fn(async (): Promise<void> => {}),
  permissionReply: vi.fn(async (): Promise<void> => {}),
  rejectQuestion: vi.fn(async (): Promise<void> => {}),
  lastInstance: null as null | {
    screen: import('node:events').EventEmitter
  },
}))

vi.mock('opencode-headless', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    OpencodeHeadless: class FakeOpencodeHeadless extends EventEmitter {
      readonly screen = new EventEmitter()
      readonly committed = new EventEmitter()
      readonly semantic = new EventEmitter()
      readonly permissionService = {
        reply: headlessControl.permissionReply,
      }
      rejectQuestion = headlessControl.rejectQuestion
      constructor() {
        super()
        headlessControl.lastInstance = this
      }
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
    headlessControl.permissionReply.mockClear()
    headlessControl.rejectQuestion.mockClear()
    headlessControl.lastInstance = null
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

  it('publishes and resolves permission conditions through the HTTP action path', async () => {
    const session = new OpencodeSession({ cwd: '/tmp/project' })
    const snapshots: Array<unknown> = []
    session.on('conditions', snapshot => snapshots.push(snapshot))

    await session.start()
    headlessControl.lastInstance?.screen.emit('permission', {
      state: {
        visible: true,
        requestID: 'req-1',
        title: 'write outside workspace',
        metadata: { tool: 'write' },
      },
    })

    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]).toMatchObject({
      provider: 'opencode',
      conditions: {
        'opencode.permission': {
          kind: 'opencode.permission',
          state: {
            visible: true,
            requestID: 'req-1',
            title: 'write outside workspace',
          },
        },
      },
    })

    const permission = (snapshots[0] as {
      conditions: Record<string, { actions: Array<unknown> }>
    }).conditions['opencode.permission']
    const allowOnce = permission.actions[0] as ConditionCustomAction
    expect(allowOnce).toMatchObject({
      kind: 'custom',
      name: 'opencode.permission.reply',
      payload: { requestID: 'req-1', reply: 'once' },
    })

    await expect(session.resolveCondition(allowOnce)).resolves.toEqual({ ok: true })
    expect(headlessControl.permissionReply).toHaveBeenCalledWith('req-1', 'once')
    expect(snapshots[1]).toMatchObject({ provider: 'opencode', conditions: {} })
  })

  it('publishes and resolves question conditions through the reject-only HTTP action path', async () => {
    const session = new OpencodeSession({ cwd: '/tmp/project' })
    const snapshots: Array<unknown> = []
    session.on('conditions', snapshot => snapshots.push(snapshot))

    await session.start()
    headlessControl.lastInstance?.screen.emit('question', {
      state: {
        visible: true,
        questionID: 'q-1',
        text: 'Do you want to continue?',
      },
    })

    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]).toMatchObject({
      provider: 'opencode',
      conditions: {
        'opencode.question': {
          kind: 'opencode.question',
          state: {
            visible: true,
            questionID: 'q-1',
            text: 'Do you want to continue?',
          },
        },
      },
    })

    const question = (snapshots[0] as {
      conditions: Record<string, { actions: Array<unknown> }>
    }).conditions['opencode.question']
    const reject = question.actions[0] as ConditionCustomAction
    expect(reject).toMatchObject({
      kind: 'custom',
      name: 'opencode.question.reject',
      payload: { questionID: 'q-1' },
    })

    await expect(session.resolveCondition(reject)).resolves.toEqual({ ok: true })
    expect(headlessControl.rejectQuestion).toHaveBeenCalledWith('q-1')
    expect(snapshots[1]).toMatchObject({ provider: 'opencode', conditions: {} })
  })
})
