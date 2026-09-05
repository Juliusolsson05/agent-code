import { afterEach, describe, expect, it, vi } from 'vitest'
import { ControlRendererBridge } from './rendererBridge'
import type { ControlContext, RendererControlRequest } from '@control-sdk'

const context: ControlContext = {
  requestId: 'operation', caller: { kind: 'external', id: 'operator' },
  owner: { kind: 'window', windowId: 'left', generation: 'first' },
}
const request = { capabilityId: 'workspace.observe', input: {} }

afterEach(() => vi.useRealTimers())

describe('renderer control correlation', () => {
  it('accepts only the matching sender and generation and ignores duplicate replies', async () => {
    let sent!: RendererControlRequest
    const bridge = new ControlRendererBridge((_window, message) => { sent = message })
    const pending = bridge.invoke(request, context)
    const response = { requestId: sent.context.requestId, generation: 'first', result: { ok: true as const, value: 'observed' } }
    expect(bridge.resolve('right', response)).toBe(false)
    expect(bridge.resolve('left', { ...response, generation: 'old' })).toBe(false)
    expect(bridge.resolve('left', response)).toBe(true)
    expect(await pending).toEqual(response.result)
    expect(bridge.resolve('left', response)).toBe(false)
  })

  it('retires only the lost window generation, preserving other concurrent work', async () => {
    const sent: RendererControlRequest[] = []
    const bridge = new ControlRendererBridge((_window, message) => sent.push(message))
    const lost = bridge.invoke(request, context)
    const surviving = bridge.invoke(request, { ...context, owner: { kind: 'window', windowId: 'right', generation: 'first' } })
    bridge.retire('left', 'first')
    expect(await lost).toMatchObject({ ok: false, error: { code: 'stale_owner', outcome: 'unknown' } })
    bridge.resolve('right', { requestId: sent[1].context.requestId, generation: 'first', result: { ok: true, value: {} } })
    expect(await surviving).toEqual({ ok: true, value: {} })
  })

  it('does not retry a timeout or accept its late success as a new request', async () => {
    vi.useFakeTimers()
    const send = vi.fn()
    const bridge = new ControlRendererBridge(send, 50)
    const pending = bridge.invoke(request, context)
    const message = send.mock.calls[0][1] as RendererControlRequest
    await vi.advanceTimersByTimeAsync(51)
    expect(await pending).toMatchObject({ ok: false, error: { outcome: 'unknown' } })
    expect(send).toHaveBeenCalledTimes(1)
    expect(bridge.resolve('left', { requestId: message.context.requestId, generation: 'first', result: { ok: true, value: {} } })).toBe(false)
  })
})
