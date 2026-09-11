import { describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import { REMOTE_OUTPUT_MAX_BYTES } from '@shared/remoteOutputLimits.js'
import { manager, server, pairDevice, connect, waitFor } from './RemoteServer.testSupport.js'

describe('remote slow-consumer isolation', () => {
  it('bounds a paused socket while a healthy consumer receives every ordered event', async () => {
    const slow = await connect(await pairDevice('synthetic slow'))
    const healthy = await connect(await pairDevice('synthetic healthy'))
    // Inspect the real accepted sockets; do not substitute a buffering model
    // for ws, whose OPEN state previously hid an ever-growing sender queue.
    const accepted = [...Reflect.get(server, 'sockets')] as Array<{ ws: WebSocket }>
    const slowSocket = accepted[0]!.ws
    slow.ws.pause()
    let peak = 0
    try {
      for (let index = 0; index < 160; index++) {
        manager.emit('screen', { sessionId: 'synthetic', recent: `${index}:` + 'x'.repeat(64 * 1024), index })
        peak = Math.max(peak, slowSocket.bufferedAmount)
        await waitFor(healthy.frames, frames => frames.some(frame => {
          const value = frame as { payload?: { index?: number } }
          return value.payload?.index === index
        }))
      }
      expect(peak).toBeLessThanOrEqual(REMOTE_OUTPUT_MAX_BYTES)
      await vi.waitFor(() => expect(slowSocket.readyState).toBe(WebSocket.CLOSED))
      const indices = healthy.frames.flatMap(frame => {
        const value = frame as { payload?: { index?: number } }
        return typeof value.payload?.index === 'number' ? [value.payload.index] : []
      })
      expect(indices).toEqual(Array.from({ length: 160 }, (_, i) => i))
      expect(healthy.ws.readyState).toBe(WebSocket.OPEN)
    } finally {
      slow.ws.terminate(); healthy.ws.terminate()
    }
  }, 15000)

  it('paces a bootstrap larger than the queue budget for a healthy late joiner', async () => {
    const cache = Reflect.get(server, 'lastScreen') as Map<string, unknown>
    for (let i = 0; i < 80; i++) cache.set(`s-${i}`, { sessionId: `s-${i}`, recent: 'x'.repeat(64 * 1024) })
    const client = await connect(await pairDevice('synthetic bootstrap'))
    try {
      await waitFor(client.frames, frames => frames.filter(frame => (frame as { channel?: string }).channel === 'screen').length === 80)
      expect(client.ws.readyState).toBe(WebSocket.OPEN)
    } finally { client.ws.terminate() }
  })

  it('uses the same budget for an oversized direct reply without reconnect looping', async () => {
    const client = await connect(await pairDevice('synthetic reply'))
    const accepted = [...Reflect.get(server, 'sockets')] as Array<{ ws: WebSocket }>
    try {
      Reflect.get(server, 'send').call(server, accepted[0]!.ws, {
        type: 'reply', id: 'oversized', ok: true, result: 'x'.repeat(REMOTE_OUTPUT_MAX_BYTES),
      })
      await waitFor(client.frames, frames => frames.some(frame => (frame as { id?: string }).id === 'oversized'))
      expect(client.frames.find(frame => (frame as { id?: string }).id === 'oversized')).toMatchObject({ ok: false, error: 'Remote response exceeds the output limit.' })
      expect(client.ws.readyState).toBe(WebSocket.OPEN)
    } finally { client.ws.terminate() }
  })
})
