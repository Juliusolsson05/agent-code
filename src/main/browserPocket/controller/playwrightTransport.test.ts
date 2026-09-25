import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { ActionCtx, GuestLike } from './BrowserPocketController'
import { PocketPlaywrightTransport } from './playwrightTransport'

function setup() {
  const sendCommand = vi.fn(async (method: string) => method === 'Target.attachToTarget' ? { sessionId: 'native-page' } : {})
  const events = new EventEmitter()
  const guest = { id: 7, debugger: Object.assign(events, { sendCommand, isAttached: () => true }), isDestroyed: () => false, getURL: () => 'http://localhost/', getTitle: () => 'Mine' } as unknown as GuestLike
  const transport = new PocketPlaywrightTransport(guest, '149', 'mine')
  const received: any[] = []
  transport.onmessage = message => received.push(message)
  let id = 0
  const request = async (method: string, params = {}, sessionId?: string) => {
    const current = ++id
    transport.send({ id: current, method, params, sessionId })
    await vi.waitFor(() => expect(received.some(m => m.id === current)).toBe(true))
    return received.find(m => m.id === current)
  }
  return { transport, request, events, sendCommand }
}

describe('single-pocket Playwright transport', () => {
  it('exposes only its own target and refuses unknown sessions or browser-wide actions', async () => {
    const { transport, request, sendCommand } = setup()
    expect((await request('Target.getTargets')).result.targetInfos.map((t: { targetId: string }) => t.targetId)).toEqual(['mine'])
    for (const method of ['Target.createTarget', 'Target.attachToTarget', 'Browser.close']) expect((await request(method, { targetId: 'other' })).error).toBeTruthy()
    expect((await request('Runtime.evaluate', { expression: '1' }, 'foreign-session')).error).toBeTruthy()
    expect(sendCommand).not.toHaveBeenCalled()
    transport.close()
  })
  it('uses its own native debugger session, tracks descendants, and cancels outgoing retries', async () => {
    const { transport, request, events, sendCommand } = setup()
    await request('Target.setAutoAttach', { autoAttach: true })
    expect(sendCommand).toHaveBeenCalledWith('Target.attachToTarget', { targetId: 'mine', flatten: true })
    const checkEpoch = vi.fn()
    const pointer = vi.fn()
    transport.setAction({ checkEpoch, expectPointer: vi.fn(), pointer, expectKeys: vi.fn() } as unknown as ActionCtx)
    await request('Page.enable', {}, 'pocket-page')
    expect(sendCommand).toHaveBeenCalledWith('Page.enable', {}, 'native-page')
    events.emit('message', {}, 'Target.attachedToTarget', { sessionId: 'child' }, 'native-page')
    await request('Runtime.enable', {}, 'child')
    expect(sendCommand).toHaveBeenCalledWith('Runtime.enable', {}, 'child')
    checkEpoch.mockImplementation(() => { throw new Error('user took control') })
    const before = sendCommand.mock.calls.length
    expect((await request('Input.dispatchMouseEvent', { type: 'mousePressed', x: 10, y: 20 }, 'pocket-page')).error.message).toContain('user took control')
    expect(sendCommand).toHaveBeenCalledTimes(before)
    expect((await request('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', x: 10, y: 20 }, 'pocket-page')).error).toBeUndefined()
    expect(pointer).not.toHaveBeenCalled()
    transport.close()
    expect(sendCommand).toHaveBeenLastCalledWith('Target.detachFromTarget', { sessionId: 'native-page' })
    expect(events.listenerCount('message')).toBe(0)
  })
})
