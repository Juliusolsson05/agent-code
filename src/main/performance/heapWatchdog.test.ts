import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MainProbeSample } from './MainProbe.js'

const mocks = vi.hoisted(() => ({ listener: null as null | ((sample: MainProbeSample) => void), unsubscribe: vi.fn() }))
vi.mock('./MainProbe.js', () => ({ mainProbe: {
  subscribe: (listener: (sample: MainProbeSample) => void) => { mocks.listener = listener; return mocks.unsubscribe },
  read: () => ({ heapUsed: 0, heapLimit: 4 * 1024 ** 3 }),
} }))
// A native snapshot invocation would fail this test even if a future refactor
// accidentally reintroduced it under the old low-memory threshold.
const writeHeapSnapshot = vi.hoisted(() => vi.fn(() => { throw new Error('Automatic snapshot forbidden') }))
vi.mock('node:v8', () => ({ writeHeapSnapshot }))
import { startMainHeapWatchdog, stopMainHeapWatchdog, __resetHeapWatchdogForTests } from './heapWatchdog.js'

const sample = (heapUsed: number, heapLimit = 4 * 1024 ** 3) => ({ heapUsed, heapLimit, rss: heapUsed * 1.1 }) as MainProbeSample

describe('metadata-only heap pressure', () => {
  beforeEach(() => { __resetHeapWatchdogForTests(); vi.clearAllMocks() })
  it('records pressure once without synchronously capturing heap or starting another sampler', () => {
    const callback = vi.fn()
    startMainHeapWatchdog({ onHeapPressure: callback })
    mocks.listener?.(sample(1024 ** 3))
    expect(callback).not.toHaveBeenCalled()
    mocks.listener?.(sample(2 * 1024 ** 3))
    mocks.listener?.(sample(3 * 1024 ** 3))
    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ snapshotPath: null, snapshotAttempts: 0 }))
    expect(writeHeapSnapshot).not.toHaveBeenCalled()
    stopMainHeapWatchdog()
    expect(mocks.unsubscribe).toHaveBeenCalledOnce()
  })
  it('uses the smaller heap limit and isolates a failing incident sink', () => {
    const callback = vi.fn(() => { throw new Error('sink unavailable') })
    startMainHeapWatchdog({ onHeapPressure: callback })
    expect(() => mocks.listener?.(sample(800, 1000))).not.toThrow()
    expect(callback).toHaveBeenCalledOnce()
  })
})
