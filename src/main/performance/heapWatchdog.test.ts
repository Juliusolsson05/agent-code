import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The watchdog's contract under test (#733): one synchronous snapshot per
// run on success, and on a FAILED write a bounded, backed-off retry rather
// than another multi-second write on the very next 2 s sample.

const mocks = vi.hoisted(() => ({
  writeHeapSnapshot: vi.fn(),
  heapUsed: 0,
  heapLimit: 4 * 1024 * 1024 * 1024,
}))

vi.mock('node:v8', () => ({
  writeHeapSnapshot: (file: string) => mocks.writeHeapSnapshot(file),
  getHeapStatistics: () => ({
    used_heap_size: mocks.heapUsed,
    heap_size_limit: mocks.heapLimit,
  }),
}))
// Packaged → the auto-summary child process is never spawned.
vi.mock('electron', () => ({ app: { isPackaged: true, getAppPath: () => '/app' } }))
vi.mock('node:fs/promises', () => ({ mkdir: async () => undefined }))
vi.mock('@main/storage/paths.js', () => ({ HEAP_SNAPSHOT_DIR: '/heap-snapshots-test' }))
vi.mock('@main/incident/appRunIds.js', () => ({ getAppRunId: () => 'run-test' }))

const {
  __resetHeapWatchdogForTests,
  startMainHeapWatchdog,
  stopMainHeapWatchdog,
} = await import('./heapWatchdog.js')

const GIB = 1024 * 1024 * 1024
const FIRST_SAMPLE_MS = 5_000
const FAST_SAMPLE_MS = 2_000
const BACKOFF_MS = 10 * 60 * 1000

describe('main heap watchdog snapshot retries', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    __resetHeapWatchdogForTests()
    mocks.writeHeapSnapshot.mockReset()
    // Above the 1.5 GiB trip and above 25% of the limit → fast 2 s cadence,
    // the regime in which the old retry loop bit.
    mocks.heapUsed = 2 * GIB
  })

  afterEach(() => {
    stopMainHeapWatchdog()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('writes one snapshot when tripped and never again after success', async () => {
    startMainHeapWatchdog()
    await vi.advanceTimersByTimeAsync(FIRST_SAMPLE_MS)
    expect(mocks.writeHeapSnapshot).toHaveBeenCalledTimes(1)
    expect(mocks.writeHeapSnapshot).toHaveBeenCalledWith('/heap-snapshots-test/main-run-test.heapsnapshot')

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    expect(mocks.writeHeapSnapshot).toHaveBeenCalledTimes(1)
  })

  it('does not retry a failed write on the next fast sample, only after the backoff', async () => {
    mocks.writeHeapSnapshot.mockImplementation(() => {
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
    })
    startMainHeapWatchdog()
    await vi.advanceTimersByTimeAsync(FIRST_SAMPLE_MS)
    expect(mocks.writeHeapSnapshot).toHaveBeenCalledTimes(1)

    // The old implementation wrote again here, and every 2 s after.
    await vi.advanceTimersByTimeAsync(FAST_SAMPLE_MS * 5)
    expect(mocks.writeHeapSnapshot).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(BACKOFF_MS)
    expect(mocks.writeHeapSnapshot).toHaveBeenCalledTimes(2)
  })

  it('gives up for the run after three failed writes', async () => {
    mocks.writeHeapSnapshot.mockImplementation(() => {
      throw new Error('EIO')
    })
    startMainHeapWatchdog()
    await vi.advanceTimersByTimeAsync(FIRST_SAMPLE_MS)
    await vi.advanceTimersByTimeAsync(BACKOFF_MS + FAST_SAMPLE_MS)
    await vi.advanceTimersByTimeAsync(BACKOFF_MS + FAST_SAMPLE_MS)
    expect(mocks.writeHeapSnapshot).toHaveBeenCalledTimes(3)

    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000)
    expect(mocks.writeHeapSnapshot).toHaveBeenCalledTimes(3)
  })

  it('stays single-shot once a retry succeeds', async () => {
    mocks.writeHeapSnapshot
      .mockImplementationOnce(() => {
        throw new Error('ENOSPC')
      })
      .mockImplementation(() => undefined)
    const onHeapPressure = vi.fn()
    startMainHeapWatchdog({ onHeapPressure })
    await vi.advanceTimersByTimeAsync(FIRST_SAMPLE_MS)
    expect(onHeapPressure).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(BACKOFF_MS + FAST_SAMPLE_MS)
    expect(mocks.writeHeapSnapshot).toHaveBeenCalledTimes(2)
    expect(onHeapPressure).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000)
    expect(mocks.writeHeapSnapshot).toHaveBeenCalledTimes(2)
  })

  it('does nothing below the trip line', async () => {
    mocks.heapUsed = 1 * GIB
    startMainHeapWatchdog()
    await vi.advanceTimersByTimeAsync(60 * 1000)
    expect(mocks.writeHeapSnapshot).not.toHaveBeenCalled()
  })
})
