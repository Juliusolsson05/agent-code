import { describe, expect, it, vi } from 'vitest'
import type { WebSocket } from 'ws'
import { boundRemoteHistory, sendBoundedRemoteOutput } from './outputBudget.js'
import { REMOTE_HISTORY_MAX_BYTES, REMOTE_OUTPUT_MAX_BYTES } from '@shared/remoteOutputLimits.js'

function socket(bufferedAmount = 0) {
  return { OPEN: 1, readyState: 1, bufferedAmount, send: vi.fn(), terminate: vi.fn() }
}

describe('remote output byte budget', () => {
  it('includes UTF-8 payload bytes and existing queued bytes before enqueueing', () => {
    const ws = socket(REMOTE_OUTPUT_MAX_BYTES - 20)
    expect(sendBoundedRemoteOutput(ws as unknown as WebSocket, '🌱')).toBe(true)
    expect(ws.send).toHaveBeenCalledOnce()
    expect(sendBoundedRemoteOutput(ws as unknown as WebSocket, '🌱x')).toBe(false)
    expect(ws.terminate).toHaveBeenCalledOnce()
    expect(ws.send).toHaveBeenCalledOnce()
  })

  it('terminates a single oversized frame without ever queueing it', () => {
    const ws = socket()
    expect(sendBoundedRemoteOutput(ws as unknown as WebSocket, 'x'.repeat(REMOTE_OUTPUT_MAX_BYTES))).toBe(false)
    expect(ws.send).not.toHaveBeenCalled()
    expect(ws.terminate).toHaveBeenCalledOnce()
  })

  it('keeps a contiguous history suffix and matching byte offsets for further pagination', () => {
    const entries = Array.from({ length: 4 }, (_, id) => ({ id, text: 'x'.repeat(1024 * 1024) }))
    const chunk = boundRemoteHistory({ entries, offsets: [0, 10, 20, 30], hasMore: false, totalEntries: 4 })!
    expect(chunk.entries.map(e => e.id)).toEqual([2, 3])
    expect(chunk.offsets).toEqual([20, 30])
    expect(chunk.hasMore).toBe(true)
    expect(chunk.totalEntries).toBe(4)
    const older = boundRemoteHistory({ entries: entries.slice(0, 2), offsets: [0, 10], hasMore: false })!
    expect([...older.entries, ...chunk.entries].map(e => e.id)).toEqual([0, 1, 2, 3])
  })

  it('reports an individually oversized record rather than silently truncating it', () => {
    expect(boundRemoteHistory({ entries: [{ text: 'x'.repeat(REMOTE_HISTORY_MAX_BYTES) }], hasMore: false })).toBeNull()
  })
})
