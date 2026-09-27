import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fsHarness = vi.hoisted(() => ({
  appendFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  mkdir: vi.fn(async () => {}),
  writeFile: vi.fn(async () => {}),
}))

vi.mock('node:fs', async importOriginal => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  appendFileSync: fsHarness.appendFileSync,
  mkdirSync: fsHarness.mkdirSync,
}))

vi.mock('node:fs/promises', async importOriginal => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  mkdir: fsHarness.mkdir,
  writeFile: fsHarness.writeFile,
}))

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [],
    getFocusedWindow: () => null,
  },
}))
const retentionCalls = vi.hoisted(() => [] as string[])
vi.mock('@main/storage/debugRetention.js', () => ({
  scheduleDebugStoragePrune: vi.fn((reason: string) => { retentionCalls.push(`prune:${reason}`) }),
  holdDebugStoragePruneUntilRecovered: vi.fn(() => { retentionCalls.push('hold') }),
}))
vi.mock('@main/incident/appRunIds.js', () => ({
  createIncidentId: () => 'incident-test',
  getAppRunId: () => 'run-test',
}))

const { AppRunJournal } = await import('./AppRunJournal.js')

beforeEach(() => {
  fsHarness.appendFileSync.mockReset()
  fsHarness.mkdirSync.mockReset()
  fsHarness.mkdir.mockReset().mockResolvedValue(undefined)
  fsHarness.writeFile.mockReset().mockResolvedValue(undefined)
})

function makeJournal(): InstanceType<typeof AppRunJournal> {
  return new AppRunJournal({
    appVersion: 'test',
    build: { commit: 'test', branch: 'test', dirty: false },
    classifierVersion: 1,
    perfEnabled: false,
    lock: { acquired: true, path: '/tmp/test.lock' },
  } as never)
}

describe('AppRunJournal completeness snapshot', () => {
  it('keeps source-loss counts after the per-flush warning counter resets', () => {
    const journal = makeJournal()
    const internal = journal as unknown as {
      started: boolean
      takePendingBatch(): unknown[]
    }
    internal.started = true

    // One event beyond the 2,000-row pending ceiling drops the oldest source
    // row. Draining resets the inline-warning counter, but a later manual
    // bundle still needs to know that this app run was never complete.
    for (let index = 0; index < 2_001; index += 1) {
      journal.record({ area: 'test', name: 'test.event', data: { index } })
    }
    expect(journal.getCompletenessSnapshot().droppedEvents).toBe(1)
    internal.takePendingBatch()
    expect(journal.getCompletenessSnapshot().droppedEvents).toBe(1)
  })

  it('reports the hard byte ceiling even though no cap event can be appended', () => {
    const journal = makeJournal()
    const internal = journal as unknown as {
      journalBytesWritten: number
      reserveJournalBytes(bytes: number): boolean
    }
    internal.journalBytesWritten = (50 * 1024 * 1024) - 1
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(internal.reserveJournalBytes(2)).toBe(false)
    expect(journal.getCompletenessSnapshot()).toMatchObject({
      capped: true,
      bytesWritten: (50 * 1024 * 1024) - 1,
    })
    warn.mockRestore()
  })

  it('reports a real append rejection and retries its re-queued batch', async () => {
    const journal = makeJournal()
    const internal = journal as unknown as { started: boolean }
    internal.started = true
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    fsHarness.writeFile
      .mockRejectedValueOnce(new Error('disk unavailable'))
      .mockResolvedValueOnce(undefined)

    journal.record({ area: 'test', name: 'test.event' })

    // The first failed write is not allowed to disappear behind flush()'s
    // best-effort policy: bundle export consumes this boolean to mark the
    // observation source incomplete. The second call proves the failed batch
    // stayed queued and can restore completeness once storage recovers.
    await expect(journal.flush()).resolves.toBe(false)
    await expect(journal.flush()).resolves.toBe(true)
    expect(fsHarness.writeFile).toHaveBeenCalledTimes(2)
    expect(journal.getCompletenessSnapshot().bytesWritten).toBeGreaterThan(0)
    warn.mockRestore()
  })

  it('retries observations after a real synchronous append rejection', async () => {
    const journal = makeJournal()
    const internal = journal as unknown as {
      started: boolean
      flushSync(): void
    }
    internal.started = true
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    fsHarness.appendFileSync.mockImplementationOnce(() => {
      throw new Error('synchronous disk failure')
    })

    journal.record({ area: 'test', name: 'test.before-incident' })
    internal.flushSync()
    expect(journal.getCompletenessSnapshot().bytesWritten).toBe(0)

    // A later manual/periodic async drain sees the exact re-queued row. If the
    // sync catch had merely logged, this call would report success on an empty
    // queue and the debug bundle would silently omit the pre-incident evidence.
    await expect(journal.flush()).resolves.toBe(true)
    expect(fsHarness.writeFile).toHaveBeenCalledTimes(1)
    expect(journal.getCompletenessSnapshot().bytesWritten).toBeGreaterThan(0)
    warn.mockRestore()
  })
})

// #775: the run's first prune waits until the workspace has recovered. start()
// closes the retention boot gate BEFORE requesting that prune, so the request
// is held rather than run during the session herd.
describe('AppRunJournal boot prune', () => {
  // start() points Node's fatal reports at the run directory; with only the
  // fs mocked that path is the owner's real incident store (#1351 review a),
  // so the process setting is put back after each start().
  const report = process.report
  const saved = report ? { directory: report.directory, reportOnFatalError: report.reportOnFatalError } : null
  afterEach(() => {
    if (report && saved) {
      report.directory = saved.directory
      report.reportOnFatalError = saved.reportOnFatalError
    }
  })

  it('holds retention before requesting the run-start prune', async () => {
    retentionCalls.length = 0
    await makeJournal().start()
    expect(retentionCalls).toEqual(['hold', 'prune:incident-run-start'])
  })

  // #1351 review a/b: an unwritable incident directory degrades the journal,
  // but the other retention buckets may be writable and index.ts still asks
  // for a startup prune. The gate must be closed anyway.
  it('holds retention even when the incident journal cannot start', async () => {
    retentionCalls.length = 0
    fsHarness.mkdir.mockRejectedValueOnce(Object.assign(new Error('read-only'), { code: 'EROFS' }))
    await makeJournal().start()
    expect(retentionCalls).toEqual(['hold'])
  })
})
