import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { collectSessionRecordingDirs, runPrunePasses } from './debugRetention.js'
import type {
  DebugStorageArtifact,
  DebugStorageBucket,
  DebugStoragePrunePolicy,
} from './debugRetention.js'

// Folder-atomic session-recording retention (plan §4, #388/#467).
//
// The one property that MUST hold: retention treats a recording folder as a
// single deletable unit, never as a bag of files. If the collector ever
// emitted per-file artifacts, a prune pass could shed events.jsonl and orphan
// meta.json — a half-recording that no longer loads and no longer counts
// against the bucket. These tests pin the collection layer where that bug
// would live (kind:'dir', one artifact per folder), which is what routes the
// prune to removeArtifact's `rm -rf` branch downstream.

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rec-retention-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function makeRecording(id: string, eventsBytes: number): void {
  const dir = join(root, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'meta.json'),
    JSON.stringify({ v: 1, recordingId: id, sessionId: id, startedAtWall: Date.now() }),
  )
  // A non-trivial events file so byte accounting is observable — the folder's
  // reported size must include BOTH files, proving whole-folder accounting.
  writeFileSync(join(dir, 'events.jsonl'), 'x'.repeat(eventsBytes))
}

describe('collectSessionRecordingDirs', () => {
  it('emits exactly one dir-kind artifact per recording folder', async () => {
    makeRecording('2026-07-07T00-00-00-000-s1', 1000)
    makeRecording('2026-07-07T00-01-00-000-s2', 2000)

    const artifacts = await collectSessionRecordingDirs(root)

    expect(artifacts).toHaveLength(2)
    // Every artifact is a directory: this is the whole-folder-atomic guarantee.
    // removeArtifact(kind:'dir') is the only branch that does rm -rf, so a
    // recording is deleted as one unit iff it arrives here as kind:'dir'.
    for (const artifact of artifacts) {
      expect(artifact.kind).toBe('dir')
      expect(artifact.bucket).toBe('session-recordings')
    }
  })

  it('accounts the whole folder (meta.json + events.jsonl), not a single file', async () => {
    makeRecording('2026-07-07T00-00-00-000-s1', 5000)

    const [artifact] = await collectSessionRecordingDirs(root)

    // The events file alone is 5000 bytes; meta.json adds more. If the
    // collector were per-file (the bug we guard against) it could report just
    // one file's size. Whole-folder accounting must exceed the events size.
    expect(artifact.bytes).toBeGreaterThan(5000)
  })

  it('returns nothing when the recordings root does not exist', async () => {
    // First app run, or recording never enabled: the dir is absent. Retention
    // must treat that as an empty bucket, not throw and abort the whole sweep.
    const artifacts = await collectSessionRecordingDirs(join(root, 'does-not-exist'))
    expect(artifacts).toEqual([])
  })
})

// Single-scan prune passes (#728). The property that MUST hold: the three
// passes run over ONE collected list, so an artifact removed by an earlier
// pass is never offered to a later one, and the byte accounting matches what
// the old re-scanning code reported. Everything below is in-memory — the
// remover records calls instead of touching disk.

const NOW = 1_700_000_000_000
const HOUR = 3_600_000
const BUCKETS: DebugStorageBucket[] = [
  'feed-debug',
  'debug-bundles-manual',
  'debug-bundles-autosave',
  'debug-bundles-legacy',
  'proxy',
  'performance',
  'incidents',
  'heap-snapshots',
  'ghost-logs',
  'session-recordings',
]

function capsOf(bytes: number, overrides: Partial<Record<DebugStorageBucket, number>> = {}) {
  const caps = {} as Record<DebugStorageBucket, number>
  for (const bucket of BUCKETS) caps[bucket] = overrides[bucket] ?? bytes
  return caps
}

function policy(overrides: Partial<DebugStoragePrunePolicy> = {}): DebugStoragePrunePolicy {
  return {
    now: NOW,
    ttlMs: 48 * HOUR,
    activeGraceMs: 10 * 60_000,
    budgetBytes: 1_000_000_000,
    caps: capsOf(1_000_000_000),
    ...overrides,
  }
}

function artifact(
  path: string,
  bucket: DebugStorageBucket,
  bytes: number,
  ageMs: number,
  extra: Partial<DebugStorageArtifact> = {},
): DebugStorageArtifact {
  return { path, bucket, bytes, mtimeMs: NOW - ageMs, kind: 'file', ...extra }
}

function recordingRemover(failFor: ReadonlySet<string> = new Set()) {
  const calls: string[] = []
  return {
    calls,
    remove: async (a: DebugStorageArtifact): Promise<number> => {
      calls.push(a.path)
      return failFor.has(a.path) ? 0 : a.bytes
    },
  }
}

describe('runPrunePasses', () => {
  it('TTL pass removes stale unprotected artifacts and leaves protected ones', async () => {
    const stale = artifact('stale', 'proxy', 10, 72 * HOUR)
    const fresh = artifact('fresh', 'proxy', 10, 1 * HOUR)
    const ghost = artifact('ghost', 'ghost-logs', 10, 72 * HOUR)
    const manual = artifact('manual', 'debug-bundles-manual', 10, 72 * HOUR)
    const flagged = artifact('flagged', 'incidents', 10, 72 * HOUR, { protected: true })
    const { calls, remove } = recordingRemover()

    const result = await runPrunePasses([stale, fresh, ghost, manual, flagged], policy(), remove)

    expect(calls).toEqual(['stale'])
    expect(result).toEqual({ removed: 1, bytesFreed: 10, remainingBytes: 40 })
  })

  it('cap pass trims the oldest inactive artifacts of an over-cap bucket only', async () => {
    const oldest = artifact('oldest', 'proxy', 60, 5 * HOUR)
    const older = artifact('older', 'proxy', 60, 3 * HOUR)
    const active = artifact('active', 'proxy', 60, 60_000)
    const other = artifact('other', 'performance', 500, 5 * HOUR)
    const { calls, remove } = recordingRemover()

    const result = await runPrunePasses(
      [older, active, oldest, other],
      policy({ caps: capsOf(1_000_000, { proxy: 100 }) }),
      remove,
    )

    // 180 > 100: drop oldest (120), then older (60 ≤ 100, stop). The active
    // run is inside the grace and never offered; the other bucket is under
    // its own cap and untouched.
    expect(calls).toEqual(['oldest', 'older'])
    expect(result).toEqual({ removed: 2, bytesFreed: 120, remainingBytes: 560 })
  })

  it('budget pass trims oldest-first across buckets until the total fits', async () => {
    const a = artifact('a', 'proxy', 100, 4 * HOUR)
    const b = artifact('b', 'performance', 100, 3 * HOUR)
    const c = artifact('c', 'feed-debug', 100, 2 * HOUR)
    const { calls, remove } = recordingRemover()

    const result = await runPrunePasses([c, a, b], policy({ budgetBytes: 150 }), remove)

    expect(calls).toEqual(['a', 'b'])
    expect(result).toEqual({ removed: 2, bytesFreed: 200, remainingBytes: 100 })
  })

  it('never offers an artifact removed by an earlier pass to a later one', async () => {
    // Stale AND over-cap AND over-budget: without a shared live set the TTL
    // removal would be re-attempted by the cap and budget passes.
    const stale = artifact('stale', 'proxy', 500, 72 * HOUR)
    const keep = artifact('keep', 'proxy', 50, 2 * HOUR)
    const { calls, remove } = recordingRemover()

    const result = await runPrunePasses(
      [stale, keep],
      policy({ budgetBytes: 100, caps: capsOf(1_000_000, { proxy: 100 }) }),
      remove,
    )

    expect(calls).toEqual(['stale'])
    expect(result).toEqual({ removed: 1, bytesFreed: 500, remainingBytes: 50 })
  })

  it('keeps an artifact whose removal freed nothing in the working set', async () => {
    const stuck = artifact('stuck', 'proxy', 500, 72 * HOUR)
    const { calls, remove } = recordingRemover(new Set(['stuck']))

    const result = await runPrunePasses(
      [stuck],
      policy({ budgetBytes: 100, caps: capsOf(1_000_000, { proxy: 100 }) }),
      remove,
    )

    // Offered by TTL, then again by cap and budget (as a re-scan would have
    // found it still there); never counted as freed.
    expect(calls).toEqual(['stuck', 'stuck', 'stuck'])
    expect(result).toEqual({ removed: 0, bytesFreed: 0, remainingBytes: 500 })
  })
})
