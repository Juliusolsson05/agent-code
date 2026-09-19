import { describe, expect, it, vi } from 'vitest'

const ipc = vi.hoisted(() => ({ send: vi.fn(), listeners: new Map<string, () => void>() }))
vi.mock('electron', () => ({ ipcRenderer: { send: ipc.send, on: (name: string, callback: () => void) => ipc.listeners.set(name, callback) } }))
import { incidentApi } from './incident.js'

describe('heartbeat transport credit', () => {
  it('admits one bounded frame while main is blocked, then resumes after acknowledgement', () => {
    const heartbeat = {
      sentAt: 1000, monotonicMs: 100, timeOriginMs: 900, eventLoopLagMs: 0,
      visibilityState: 'visible' as const, longTasks: { count: 0, totalMs: 0, maxMs: 0 },
      heap: { usedBytes: 1, totalBytes: 2, limitBytes: 3, privateContent: 'must not cross IPC' },
    }
    incidentApi.reportRendererHeartbeat(heartbeat)
    for (let i = 0; i < 1000; i++) incidentApi.reportRendererHeartbeat(heartbeat)
    expect(ipc.send).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(ipc.send.mock.calls[0])).not.toContain('privateContent')
    ipc.listeners.get('incident:renderer-heartbeat-ack')?.()
    incidentApi.reportRendererHeartbeat({ ...heartbeat, sentAt: 'private text' as never })
    expect(ipc.send).toHaveBeenCalledTimes(1)
    incidentApi.reportRendererHeartbeat(heartbeat)
    expect(ipc.send).toHaveBeenCalledTimes(2)
  })
})
