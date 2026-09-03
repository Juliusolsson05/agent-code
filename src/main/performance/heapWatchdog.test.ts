import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The watchdog's contract under test (#733): one synchronous snapshot per
// run on success, and on a FAILED write a bounded, backed-off retry rather
// than another multi-second write on the very next 2 s sample.

const mocks = vi.hoisted(() => ({
  writeHeapSnapshot: vi.fn(),
  rmSync: vi.fn(),
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
vi.mock('node:fs', () => ({ rmSync: (path: string) => mocks.rmSync(path) }))
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
    // The auto-summary child also opts in on this env flag; a developer
    // shell that sets it must not make these tests spawn a real process.
    vi.stubEnv('AGENT_CODE_HEAP_SUMMARY', '')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    __resetHeapWatchdogForTests()
    mocks.writeHeapSnapshot.mockReset()
    mocks.rmSync.mockReset()
    // Above the 1.5 GiB trip and above 25% of the limit → fast 2 s cadence,
    // the regime in which the old retry loop bit.
    mocks.heapUsed = 2 * GIB
  })

  afterEach(() => {
    stopMainHeapWatchdog()
    vi.useRealTimers()
    vi.unstubAllEnvs()
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

  it('gives up for the run after three failed writes and records it once', async () => {
    mocks.writeHeapSnapshot.mockImplementation(() => {
      throw new Error('EIO')
    })
    const onHeapPressure = vi.fn()
    const giveUpLines = () =>
      vi.mocked(console.error).mock.calls.filter(call => String(call[0]).includes('giving up')).length
    startMainHeapWatchdog({ onHeapPressure })
    await vi.advanceTimersByTimeAsync(FIRST_SAMPLE_MS)
    await vi.advanceTimersByTimeAsync(BACKOFF_MS + FAST_SAMPLE_MS)
    expect(onHeapPressure).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(BACKOFF_MS + FAST_SAMPLE_MS)
    expect(mocks.writeHeapSnapshot).toHaveBeenCalledTimes(3)
    // Each failed write removes the truncated file it may have left behind.
    expect(mocks.rmSync).toHaveBeenCalledTimes(3)
    expect(mocks.rmSync).toHaveBeenCalledWith('/heap-snapshots-test/main-run-test.heapsnapshot')
    // The trip is still recorded durably, without a snapshot.
    expect(onHeapPressure).toHaveBeenCalledTimes(1)
    expect(onHeapPressure).toHaveBeenCalledWith(expect.objectContaining({
      snapshotPath: null,
      snapshotError: 'EIO',
      snapshotAttempts: 3,
    }))
    expect(giveUpLines()).toBe(1)

    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000)
    expect(mocks.writeHeapSnapshot).toHaveBeenCalledTimes(3)
    expect(onHeapPressure).toHaveBeenCalledTimes(1)
    expect(giveUpLines()).toBe(1)
  })

  // Guards the re-arm logic rather than the #733 regression itself: the old
  // implementation also passed this (it retried on the next sample and then
  // succeeded); what matters is that a success after a backed-off retry
  // latches for good.
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
