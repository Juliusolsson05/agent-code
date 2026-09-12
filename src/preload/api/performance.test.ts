import { describe, expect, it, vi } from 'vitest'
const ipc = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('electron', () => ({ ipcRenderer: ipc }))
import { performanceApi } from './performance.js'

describe('monitor read transport', () => {
  it('shares one pending snapshot across rapid close/reopen and permits a fresh read after completion', async () => {
    let resolve!: (value: null) => void
    ipc.invoke.mockImplementation(() => new Promise(done => { resolve = done }))
    const first = performanceApi.getMonitorSnapshot()
    for (let i = 0; i < 100; i++) expect(performanceApi.getMonitorSnapshot()).toBe(first)
    expect(ipc.invoke).toHaveBeenCalledTimes(1)
    resolve(null)
    await first
    const next = performanceApi.getMonitorSnapshot()
    expect(ipc.invoke).toHaveBeenCalledTimes(2)
    resolve(null)
    await next
  })
})
