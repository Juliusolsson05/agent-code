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

  it('shares one pending agent-usage read across rapid polls and permits a fresh read after completion', async () => {
    // The overview polls every 5 s; a frozen main must not accumulate one
    // promise per poll across remounts — same contract as the snapshot.
    // The invoke mock is module-shared and carries the previous test's calls,
    // so counts are asserted relative to a cleared mock.
    ipc.invoke.mockClear()
    let resolve!: (value: null) => void
    ipc.invoke.mockImplementation(() => new Promise(done => { resolve = done }))
    const first = performanceApi.getMonitorAgentUsage()
    for (let i = 0; i < 100; i++) expect(performanceApi.getMonitorAgentUsage()).toBe(first)
    expect(ipc.invoke).toHaveBeenCalledTimes(1)
    resolve(null)
    await first
    const next = performanceApi.getMonitorAgentUsage()
    expect(ipc.invoke).toHaveBeenCalledTimes(2)
    resolve(null)
    await next
  })
})
