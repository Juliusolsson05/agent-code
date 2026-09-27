import { mkdirSync, mkdtempSync, utimesSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// #775: the run's first prune waits until the workspace has recovered. The
// retention paths point at a scratch state dir (never the owner's), holding one
// feed-debug file past the 48 h TTL, so "a prune ran" is observable as that
// file disappearing and a journaled prune row.
const scratch = mkdtempSync(join(tmpdir(), 'agent-code-boot-prune-'))
vi.mock('@main/storage/paths.js', async () => {
  const { join: j } = await import('node:path')
  const root = scratch
  return {
    STATE_DIR: root,
    FEED_DEBUG_DIR: j(root, 'feed-debug'),
    DEBUG_BUNDLE_DIR: j(root, 'debug-bundles'),
    MANUAL_DEBUG_BUNDLE_DIR: j(root, 'debug-bundles', 'manual'),
    AUTOSAVE_DEBUG_BUNDLE_DIR: j(root, 'debug-bundles', 'autosave'),
    PROXY_EVENTS_DIR: j(root, 'proxy'),
    PERFORMANCE_RUNS_DIR: j(root, 'performance', 'runs'),
    INCIDENT_RUNS_DIR: j(root, 'incidents', 'runs'),
    HEAP_SNAPSHOT_DIR: j(root, 'heap-snapshots'),
    SESSION_RECORDING_DIR: j(root, 'session-recordings'),
  }
})

let retention: typeof import('./debugRetention.js')
const pruned: Array<Record<string, unknown>> = []
const expired = join(scratch, 'feed-debug', 'old-session.jsonl')

beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  pruned.length = 0
  mkdirSync(join(scratch, 'feed-debug'), { recursive: true })
  writeFileSync(expired, 'x')
  const old = new Date(Date.now() - 72 * 3_600_000)
  utimesSync(expired, old, old)
  retention = await import('./debugRetention.js')
  retention.setDebugRetentionJournal({ record: event => { if (event.name === 'debug_retention.prune') pruned.push(event.data ?? {}) } })
})
afterEach(() => { vi.useRealTimers() })

/** Let a started prune's real file I/O finish. */
async function settle() {
  vi.useRealTimers()
  await vi.waitFor(() => expect(existsSync(expired)).toBe(false), { timeout: 5_000 })
  await vi.waitFor(() => expect(pruned).toHaveLength(1))
}

describe('boot prune gate (#775)', () => {
  it('holds every early request until the recovery delay after the workspace recovers, then prunes once', async () => {
    retention.holdDebugStoragePruneUntilRecovered()
    retention.scheduleDebugStoragePrune('incident-run-start')
    retention.scheduleDebugStoragePrune('startup')
    retention.scheduleDebugStoragePrune('feed-debug-append')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(existsSync(expired)).toBe(true)
    retention.noteWorkspaceRecovered()
    // A second window reporting later must not move the open (#1351 review
    // c): the gate opens a fixed time after the FIRST recovery.
    await vi.advanceTimersByTimeAsync(30_000)
    retention.noteWorkspaceRecovered()
    await vi.advanceTimersByTimeAsync(retention.DEBUG_PRUNE_AFTER_RECOVERY_MS - 30_000 - 1)
    expect(existsSync(expired)).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    await settle()
    expect(pruned).toEqual([expect.objectContaining({ reason: 'incident-run-start' })])
  })

  it('prunes at the fallback when no window ever reports recovery', async () => {
    retention.holdDebugStoragePruneUntilRecovered()
    retention.scheduleDebugStoragePrune('incident-run-start')
    await vi.advanceTimersByTimeAsync(retention.DEBUG_PRUNE_BOOT_FALLBACK_MS - 1)
    expect(existsSync(expired)).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    await settle()
  })

  it('leaves an ungated request immediate, as before', async () => {
    retention.scheduleDebugStoragePrune('feed-debug-append')
    await settle()
  })

  it('closes only once per process', async () => {
    retention.holdDebugStoragePruneUntilRecovered()
    retention.noteWorkspaceRecovered()
    await vi.advanceTimersByTimeAsync(retention.DEBUG_PRUNE_AFTER_RECOVERY_MS)
    retention.holdDebugStoragePruneUntilRecovered()
    retention.scheduleDebugStoragePrune('feed-debug-append')
    await settle()
  })

  // #1351 review c: the held assertions above race real file I/O under fake
  // timers, so a gate that did nothing could still look held. With real
  // timers and time for a prune to finish, nothing may be deleted while the
  // gate is closed.
  it('deletes nothing while the gate is closed, given real time to do so', async () => {
    vi.useRealTimers()
    retention.holdDebugStoragePruneUntilRecovered()
    retention.scheduleDebugStoragePrune('incident-run-start')
    await new Promise(resolve => setTimeout(resolve, 500))
    expect(existsSync(expired)).toBe(true)
    expect(pruned).toEqual([])
  })

  // #1351 review b: a gate timer must never keep a quitting process alive.
  it('never keeps the process alive with its timers', async () => {
    vi.useRealTimers()
    const timers: Array<{ hasRef?: () => boolean }> = []
    const realSetTimeout = globalThis.setTimeout
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler: () => void, ms?: number) => {
      const timer = realSetTimeout(handler, ms)
      timers.push(timer as unknown as { hasRef?: () => boolean })
      return timer
    }) as typeof setTimeout)
    try {
      retention.holdDebugStoragePruneUntilRecovered()
      retention.noteWorkspaceRecovered()
      // A second window's report arms nothing more (#1351 review c: without
      // the guard it added a redundant timer per report).
      retention.noteWorkspaceRecovered()
    } finally { spy.mockRestore() }
    expect(timers).toHaveLength(2)
    expect(timers.every(timer => timer.hasRef?.() === false)).toBe(true)
  })
})
