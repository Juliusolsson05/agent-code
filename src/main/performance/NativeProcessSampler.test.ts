import { describe, expect, it, vi } from 'vitest'
import { NativeProcessSampler } from './NativeProcessSampler.js'
import { parseCpuTime, parseNativeProcessTable } from './nativeProcessTable.js'
import type { MonitorProcessContext } from '@shared/performance/processSnapshot.js'

const birth = 'Sat Sep 12 12:00:00 2026'
const topology = `1 0 ${birth}\n20 999 ${birth}\n21 20 ${birth}\n`
const context: MonitorProcessContext = {
  generation: 1, rootPid: 1, sampledAt: 100,
  electron: [{ pid: 1, creationTime: 100, type: 'main', cpuPercent: 2, memoryBytes: 500 * 1024 }],
  targets: [{ sessionId: 'a', kind: 'claude', pid: 20, exited: false, lastActivityAt: null },
    { sessionId: 'b', kind: 'codex', pid: 21, exited: false, lastActivityAt: null }],
}

describe('native process ownership', () => {
  it('includes detached roots, deduplicates shared descendants, and computes interval CPU in percent', async () => {
    let now = 0
    let cpu = '0:00.00'
    const run = vi.fn(async (args: string[]) => args[0] === '-axo' ? topology
      : `20 999 ${birth} ${cpu} 100\n21 20 ${birth} ${cpu} 200\n`)
    const sampler = new NativeProcessSampler(run, 'darwin', () => now)
    await sampler.sample(context)
    expect(sampler.read().rows.find(row => row.pid === 20)?.cpuPercent).toBeNull()
    now = 5000; cpu = '0:05.00'
    await sampler.sample(context)
    expect(run.mock.calls.filter(([args]) => args[0] === '-axo')).toHaveLength(1)
    expect(sampler.read().rows.find(row => row.pid === 20)?.cpuPercent).toBe(100)
    expect(sampler.read().rows.find(row => row.pid === 21)).toMatchObject({ sharedSessionCount: 2, sessionIds: ['a', 'b'] })
    expect(sampler.read().summary).toMatchObject({ count: 3, cpuPercent: 202, memoryBytes: 800 * 1024, sessionCount: 2 })
    const count = run.mock.calls.length
    for (let i = 0; i < 100; i++) sampler.read()
    expect(run).toHaveBeenCalledTimes(count)
  })

  it('does not overlap commands and starts a new CPU baseline after PID reuse', async () => {
    let release!: (text: string) => void
    let now = 0
    let currentBirth = birth
    const run = vi.fn(async (args: string[]) => args[0] === '-axo' ? `1 0 ${birth}\n20 999 ${currentBirth}` : `20 999 ${currentBirth} 0:05.00 100`)
      .mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const sampler = new NativeProcessSampler(run, 'darwin', () => now)
    const first = sampler.sample(context)
    await sampler.sample(context)
    expect(run).toHaveBeenCalledTimes(1)
    release(topology)
    await first
    now = 16000; currentBirth = 'Sat Sep 12 12:00:01 2026'
    await sampler.sample(context)
    expect(sampler.read().rows.some(row => row.pid === 20 && row.sessionIds.includes('a'))).toBe(false)
    expect(sampler.read().rows).toContainEqual(expect.objectContaining({ identity: 'session:a', quality: 'unsupported' }))
    await sampler.sample({ ...context, targets: context.targets.map(target => ({ ...target, generation: 'new-backend' })) })
    expect(sampler.read().rows.find(row => row.pid === 20)?.cpuPercent).toBeNull()
  })

  it('caps shared identity lists without inventing unavailable fifth owners, and reports input truncation', async () => {
    const sampler = new NativeProcessSampler(async args => args[0] === '-axo' ? topology : `20 999 ${birth} 0:00.00 100\n21 20 ${birth} 0:00.00 200`, 'darwin')
    await sampler.sample({ ...context, truncated: true, targets: Array.from({ length: 8 }, (_, index) => ({ ...context.targets[0], sessionId: `owner-${index}` })) })
    expect(sampler.read().rows).toHaveLength(3)
    expect(sampler.read().rows.find(row => row.pid === 20)).toMatchObject({ sharedSessionCount: 8 })
    expect(sampler.read().rows.find(row => row.pid === 20)?.sessionIds).toHaveLength(4)
    expect(sampler.read().summary).toMatchObject({ truncated: true, quality: 'partial', sessionCount: 8 })
  })

  it('keeps a managed session visible when its platform or PID is unavailable', async () => {
    const run = vi.fn()
    const sampler = new NativeProcessSampler(run, 'win32')
    await sampler.sample({ ...context, targets: [{ ...context.targets[0], pid: null }] })
    expect(run).not.toHaveBeenCalled()
    expect(sampler.read().rows).toContainEqual(expect.objectContaining({ pid: null, sessionIds: ['a'], quality: 'unsupported' }))
    expect(sampler.read().summary.missingRoots).toBeGreaterThanOrEqual(1)
  })
})

describe('numeric ps contract', () => {
  it('parses macOS centiseconds and day/hour CPU durations without retaining extra text', () => {
    expect(parseCpuTime('0:05.25')).toBe(5250)
    expect(parseCpuTime('1-02:03:04')).toBe(93784000)
    expect(parseCpuTime('nonsense')).toBeNull()
    expect(parseNativeProcessTable(`20 1 ${birth} 0:05.25 100\nprompt text here`)).toEqual([
      { pid: 20, parentPid: 1, creationTime: Date.parse(birth), cpuMs: 5250, rss: 102400 },
    ])
  })
})
