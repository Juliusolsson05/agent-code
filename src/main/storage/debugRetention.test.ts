import { chmodSync, existsSync, mkdtempSync, mkdirSync, renameSync, statSync, utimesSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { cachedManualLegacyBundlePaths, collectSessionRecordingDirs, legacyDebugBundleBucketForPath, parseManualLegacyBundlePaths, removeEmptyProxyParents, runPrunePasses } from './debugRetention.js'
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
    remove: async (a: DebugStorageArtifact): Promise<boolean> => {
      calls.push(a.path)
      return !failFor.has(a.path)
    },
  }
}

describe('runPrunePasses', () => {
  it('TTL pass removes stale unprotected artifacts and leaves protected ones', async () => {
    const stale = artifact('stale', 'proxy', 10, 72 * HOUR)
    const fresh = artifact('fresh', 'proxy', 10, 1 * HOUR)
    const manual = artifact('manual', 'debug-bundles-manual', 10, 72 * HOUR)
    const flagged = artifact('flagged', 'incidents', 10, 72 * HOUR, { protected: true })
    const { calls, remove } = recordingRemover()

    const result = await runPrunePasses([stale, fresh, manual, flagged], policy(), remove)

    expect(calls).toEqual(['stale'])
    expect(result).toEqual({ removed: 1, bytesFreed: 10, remainingBytes: 30 })
  })

  it('cap pass trims the oldest inactive, unprotected artifacts of an over-cap bucket only', async () => {
    const oldest = artifact('oldest', 'proxy', 60, 5 * HOUR)
    const older = artifact('older', 'proxy', 60, 3 * HOUR)
    const shielded = artifact('shielded', 'proxy', 60, 2 * HOUR, { protected: true })
    const active = artifact('active', 'proxy', 60, 60_000)
    const other = artifact('other', 'performance', 500, 5 * HOUR)
    const manual = artifact('manual', 'debug-bundles-manual', 900, 5 * HOUR)
    const { calls, remove } = recordingRemover()

    const result = await runPrunePasses(
      [older, active, oldest, shielded, other, manual],
      policy({ caps: capsOf(1_000_000, { proxy: 50, 'debug-bundles-manual': 10 }) }),
      remove,
    )

    // proxy: 240 > 50. Oldest first: oldest (180), older (120), then the
    // protected and the active run are reached while still over cap and must
    // be skipped — the bucket ends over its cap rather than losing either.
    // The manual bundle bucket is never capped; performance is under its cap.
    expect(calls).toEqual(['oldest', 'older'])
    expect(result).toEqual({ removed: 2, bytesFreed: 120, remainingBytes: 1_520 })
  })

  it('budget pass trims oldest-first across buckets until the total fits, skipping protected and active', async () => {
    const a = artifact('a', 'proxy', 100, 4 * HOUR)
    const shielded = artifact('shielded', 'incidents', 100, 3.5 * HOUR, { protected: true })
    const b = artifact('b', 'performance', 100, 3 * HOUR)
    const active = artifact('active', 'feed-debug', 100, 60_000)
    const c = artifact('c', 'feed-debug', 100, 2 * HOUR)
    const { calls, remove } = recordingRemover()

    const result = await runPrunePasses(
      [c, a, active, b, shielded],
      policy({ budgetBytes: 150 }),
      remove,
    )

    // 500 > 150: a (400), shielded skipped, b (300), c (200), active skipped.
    // Ends over budget rather than touching what the rules exempt.
    expect(calls).toEqual(['a', 'b', 'c'])
    expect(result).toEqual({ removed: 3, bytesFreed: 300, remainingBytes: 200 })
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

describe('removeEmptyProxyParents (#1278)', () => {
  // Proxy runs live at proxy/<project>/<session>/<timestamp>/. Pruning removed
  // only the leaf, and the parent sweep called rm() without `recursive` on a
  // directory, which always throws EISDIR, so no parent was ever removed:
  // the author's machine held 2,978 empty session/project dirs, walked on
  // every prune. This drives the real filesystem because the in-memory prune
  // tests never reached the sweep.
  it('removes the emptied session and project dirs, stops at a non-empty one, and never removes the root', async () => {
    const proxyRoot = join(root, 'proxy')
    const lonelyRun = join(proxyRoot, 'project-a', 'session-1', '2026-09-01T00-00-00')
    const keptRun = join(proxyRoot, 'project-b', 'session-2', '2026-09-01T00-00-00')
    const prunedSibling = join(proxyRoot, 'project-b', 'session-3', '2026-09-01T00-00-00')
    for (const dir of [lonelyRun, keptRun, prunedSibling]) mkdirSync(dir, { recursive: true })
    rmSync(lonelyRun, { recursive: true })
    rmSync(prunedSibling, { recursive: true })

    await removeEmptyProxyParents(lonelyRun, proxyRoot)
    await removeEmptyProxyParents(prunedSibling, proxyRoot)

    expect(existsSync(join(proxyRoot, 'project-a'))).toBe(false)
    // Review of #1417 (a), a surviving mutation: `startsWith(root)` without the
    // separator. A sibling root sharing the prefix must never be walked into.
    const sibling = join(root, 'proxy-old', 'empty-project', 'session')
    mkdirSync(sibling, { recursive: true })
    await removeEmptyProxyParents(join(sibling, 'gone-run'), proxyRoot)
    expect(existsSync(sibling)).toBe(true)
    expect(existsSync(join(proxyRoot, 'project-b', 'session-3'))).toBe(false)
    expect(existsSync(keptRun)).toBe(true)
    expect(existsSync(proxyRoot)).toBe(true)
  })
})

describe('cachedManualLegacyBundlePaths (#1278)', () => {
  // The legacy mixed ledger no longer grows, but it was re-parsed on every
  // five-minute prune. It is now parsed again only when the file changes.
  it('parses once while the ledger is unchanged and again after it changes', async () => {
    const ledger = join(root, 'saved-debug-bundles.jsonl')
    writeFileSync(ledger, '{"event":"saved","reason":"manual","bundlePath":"/b/1"}\n')
    const load = vi.fn(async () => new Set(['/b/1']))

    await cachedManualLegacyBundlePaths(ledger, load)
    await cachedManualLegacyBundlePaths(ledger, load)
    expect(load).toHaveBeenCalledTimes(1)

    writeFileSync(ledger, '{"event":"saved","reason":"manual","bundlePath":"/b/1"}\n{"event":"saved","reason":"manual","bundlePath":"/b/2"}\n')
    await cachedManualLegacyBundlePaths(ledger, load)
    expect(load).toHaveBeenCalledTimes(2)
  })
})

describe('legacy ledger classification fails closed (steering q109)', () => {
  const manualRow = (bundlePath: string) => `${JSON.stringify({ event: 'saved', reason: 'manual', bundlePath })}\n`

  // The blocker: a read failure returned an empty set, which classified every
  // hand-saved legacy bundle as deletable, and the identity cache then kept
  // that empty set after access recovered.
  it('protects every legacy bundle while the ledger is unreadable, and classifies correctly once it is readable', async () => {
    const ledger = join(root, 'saved-debug-bundles.jsonl')
    const manualBundle = join(root, '2026-01-01T00-00-00')
    const otherBundle = join(root, '2026-01-02T00-00-00')
    writeFileSync(ledger, manualRow(manualBundle))
    chmodSync(ledger, 0o000)
    try {
      const unreadable = await cachedManualLegacyBundlePaths(ledger)
      expect(unreadable).toBe('unknown')
      expect(legacyDebugBundleBucketForPath(manualBundle, unreadable)).toBe('debug-bundles-manual')
      expect(legacyDebugBundleBucketForPath(otherBundle, unreadable)).toBe('debug-bundles-manual')
    } finally {
      chmodSync(ledger, 0o600)
    }
    const readable = await cachedManualLegacyBundlePaths(ledger)
    expect(legacyDebugBundleBucketForPath(manualBundle, readable)).toBe('debug-bundles-manual')
    expect(legacyDebugBundleBucketForPath(otherBundle, readable)).toBe('debug-bundles-legacy')
  })

  // chmod moves ctime, so the sequence above re-parses through the identity
  // key alone. This pins the other half on its own: a failed load is never
  // cached, even when the file's identity has not changed at all.
  it('retries a failed load on the next call even with an unchanged file identity', async () => {
    const ledger = join(root, 'saved-debug-bundles.jsonl')
    writeFileSync(ledger, manualRow('/b/1'))
    const results: Array<Set<string> | 'unknown'> = ['unknown', new Set(['/b/1'])]
    const load = vi.fn(async () => results.shift()!)
    expect(await cachedManualLegacyBundlePaths(ledger, load)).toBe('unknown')
    expect(await cachedManualLegacyBundlePaths(ledger, load)).toEqual(new Set(['/b/1']))
    expect(load).toHaveBeenCalledTimes(2)
  })

  // Review of #1417 (a): the ledger renamed away between the stat and the
  // read. The loader sees ENOENT and says "no ledger"; that empty answer must
  // not classify the manual bundle as deletable, nor be cached, whether the
  // file is still away or already back.
  for (const back of [false, true]) {
    it(`does not trust a load that raced a rename of the ledger (${back ? 'renamed back' : 'still away'})`, async () => {
      const ledger = join(root, 'saved-debug-bundles.jsonl')
      const manualBundle = join(root, '2026-01-01T00-00-00')
      writeFileSync(ledger, manualRow(manualBundle))
      const raced = vi.fn(async (file: string) => {
        renameSync(file, `${file}.away`)
        if (back) renameSync(`${file}.away`, file)
        return new Set<string>()
      })
      const first = await cachedManualLegacyBundlePaths(ledger, raced)
      expect(first).toBe('unknown')
      expect(legacyDebugBundleBucketForPath(manualBundle, first)).toBe('debug-bundles-manual')
      if (!back) renameSync(`${ledger}.away`, ledger)
      const settled = await cachedManualLegacyBundlePaths(ledger)
      expect(legacyDebugBundleBucketForPath(manualBundle, settled)).toBe('debug-bundles-manual')
    })
  }

  // Review of #1417, round 2 (a): a ledger moved aside BEFORE the prune and
  // back after it. Both stats see ENOENT, so no identity check can notice;
  // an absent ledger must itself protect every legacy bundle.
  it('protects every legacy bundle while the ledger is absent, and classifies again once it is back', async () => {
    const ledger = join(root, 'saved-debug-bundles.jsonl')
    const manualBundle = join(root, '2026-01-01T00-00-00')
    writeFileSync(`${ledger}.away`, manualRow(manualBundle))
    const absent = await cachedManualLegacyBundlePaths(ledger)
    expect(absent).toBe('unknown')
    expect(legacyDebugBundleBucketForPath(manualBundle, absent)).toBe('debug-bundles-manual')
    renameSync(`${ledger}.away`, ledger)
    const back = await cachedManualLegacyBundlePaths(ledger)
    expect(legacyDebugBundleBucketForPath(manualBundle, back)).toBe('debug-bundles-manual')
    expect(legacyDebugBundleBucketForPath(join(root, '2026-01-02T00-00-00'), back)).toBe('debug-bundles-legacy')
  })

  // An operator edit with the same size that also restores the old mtime.
  it('re-parses a same-size edit whose mtime was set back', async () => {
    const ledger = join(root, 'saved-debug-bundles.jsonl')
    writeFileSync(ledger, manualRow('/bundles/2026-01-01T00-00-01'))
    // A whole-second mtime, so setting it back later reproduces it exactly.
    const pinned = new Date('2026-01-01T00:00:00Z')
    utimesSync(ledger, pinned, pinned)
    const before = statSync(ledger)
    expect(await cachedManualLegacyBundlePaths(ledger)).toEqual(new Set(['/bundles/2026-01-01T00-00-01']))
    writeFileSync(ledger, manualRow('/bundles/2026-01-01T00-00-02'))
    utimesSync(ledger, pinned, pinned)
    expect(statSync(ledger).size).toBe(before.size)
    expect(statSync(ledger).mtimeMs).toBe(before.mtimeMs)
    expect(await cachedManualLegacyBundlePaths(ledger)).toEqual(new Set(['/bundles/2026-01-01T00-00-02']))
  })
})

describe('parseManualLegacyBundlePaths (#1251 row 13)', () => {
  // The legacy ledger is append-only JSONL written across many app versions.
  // A row that parses as JSON but is not a saved-entry object (a bare `null`,
  // a number, an entry without a string bundlePath) used to throw out of the
  // loop (`null.event`, `resolve(undefined)`), which rejected collectArtifacts
  // and so stopped EVERY prune pass, for every bucket, on every trigger.
  it('keeps every readable manual row and skips rows that are not saved-entry objects', () => {
    const raw = [
      JSON.stringify({ event: 'saved', reason: 'manual', bundlePath: '/bundles/2026-01-01T00-00-00' }),
      'null',
      '42',
      '"saved"',
      JSON.stringify({ event: 'saved', reason: 'manual' }),
      JSON.stringify({ event: 'saved', reason: 'manual', bundlePath: 42 }),
      JSON.stringify({ event: 'saved', reason: 7, bundlePath: '/bundles/2026-01-03T00-00-00' }),
      '{not json',
      JSON.stringify({ event: 'saved', reason: 'autosave-crash', bundlePath: '/bundles/2026-01-02T00-00-00' }),
      JSON.stringify({ event: 'saved', reason: 'manual', bundlePath: '/bundles/2026-01-04T00-00-00' }),
    ].join('\n')
    expect([...parseManualLegacyBundlePaths(raw)]).toEqual([
      '/bundles/2026-01-01T00-00-00',
      // A non-string reason is not an autosave label, and an unlabelled save
      // was user-triggered in the versions that wrote this ledger, so it stays
      // protected: when in doubt, retention keeps the bundle.
      '/bundles/2026-01-03T00-00-00',
      '/bundles/2026-01-04T00-00-00',
    ])
  })

  // Review of #1411 (b), a surviving mutation: the parser test alone could not
  // see the loader stop using it. This goes through the real loader and cache.
  it('classifies through the real loader, past rows that are not entries', async () => {
    const ledger = join(root, 'saved-debug-bundles.jsonl')
    const manualBundle = join(root, '2026-01-01T00-00-00')
    writeFileSync(ledger, ['null', JSON.stringify({ event: 'saved', reason: 'manual', bundlePath: manualBundle }), ''].join('\n'))
    const paths = await cachedManualLegacyBundlePaths(ledger)
    expect(legacyDebugBundleBucketForPath(manualBundle, paths)).toBe('debug-bundles-manual')
    expect(legacyDebugBundleBucketForPath(join(root, '2026-01-02T00-00-00'), paths)).toBe('debug-bundles-legacy')
  })
})
