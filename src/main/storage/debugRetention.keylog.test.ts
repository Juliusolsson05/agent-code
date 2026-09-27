import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, expect, it } from 'vitest'

import { collectProxyRunDirs, keyLogBaseline, runPrunePasses } from './debugRetention.js'
import type { DebugStorageBucket, DebugStoragePrunePolicy } from './debugRetention.js'

// #1385 (q91 follow-up of #1380): retention collected a proxy run dir only
// once it held `proxy-events.jsonl`. A run dir holding just
// `session-meta.json` + `sslkeylog.log` was walked into, never collected, never
// budgeted and never removed, and those are plaintext TLS session secrets. The
// owner's machine had 23 such dirs (5.18 MB, May-September 2026; names and
// sizes recounted by #1380 review c, contents never read). Shapes below are
// those real layouts: proxy/<project>/<session-key>/<ISO timestamp>/.
const roots: string[] = []
const locked: string[] = []
afterEach(() => {
  for (const dir of locked.splice(0)) chmodSync(dir, 0o700)
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function runDir(root: string, parts: string[], files: Record<string, string>): string {
  const dir = join(root, ...parts)
  mkdirSync(dir, { recursive: true })
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body)
  return dir
}

// Narrowed to FUTURE runs (B6 oldest-first list, owner decision q91 kept):
// a key-log-only dir is collected only when it is NOT in the baseline, the
// set of key-log-only dirs that existed when this build first started. The
// existing ones (the owner's 23, May-September 2026, shaped like
// medlo/shell-89d43b9b) are in it and stay untouched. #1388 review a: names
// and clocks prove nothing, so a baseline dir whose name sorts AFTER a new
// run (a clock rolled back) is still excluded, and a run made minutes after
// start, before the first prune, is still new.
it('collects a key-log-only run dir only when it is not in the baseline, alongside normal run dirs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'proxy-retention-'))
  roots.push(root)
  const existing = join('medlo', 'shell-89d43b9b', '2026-08-28T17-30-06-452Z')
  const rolledBack = join('medlo', 'shell-clock', '2026-09-27T18-02-00-000Z')
  runDir(root, existing.split('/'), { 'session-meta.json': '{}', 'sslkeylog.log': 'x'.repeat(4096) })
  runDir(root, rolledBack.split('/'), { 'sslkeylog.log': 'x'.repeat(128) })
  runDir(root, ['medlo', 'shell-new', '2026-09-27T18-00-30-000Z'], { 'session-meta.json': '{}', 'sslkeylog.log': 'x'.repeat(4096) })
  runDir(root, ['agent-code', 'resume-a5fb379b', '2026-09-27T01-03-52-273Z'], { 'session-meta.json': '{}', 'proxy-events.jsonl': '{}\n', 'sslkeylog.log': 'x'.repeat(1024) })
  // Shared mitmproxy state is never a run dir, whatever it holds.
  runDir(root, ['_shared-conf'], { 'mitmproxy-ca-cert.pem': 'ca' })
  // Metadata alone is not a run's evidence; leave it for its own pass.
  runDir(root, ['agent-code', 'shell-empty', '2026-09-01T00-00-00-000Z'], { 'session-meta.json': '{}' })

  const baseline = new Set([existing, rolledBack])
  const artifacts = await collectProxyRunDirs(root, baseline)
  expect(artifacts.map(artifact => relative(root, artifact.path)).sort()).toEqual([
    join('agent-code', 'resume-a5fb379b', '2026-09-27T01-03-52-273Z'),
    join('medlo', 'shell-new', '2026-09-27T18-00-30-000Z'),
  ])
  const keyLogOnly = artifacts.find(artifact => artifact.path.includes('shell-new'))!
  expect(keyLogOnly).toMatchObject({ kind: 'dir', bucket: 'proxy' })
  expect(keyLogOnly.bytes).toBeGreaterThanOrEqual(4096)
  // With no established baseline, no key-log-only dir is collected at all.
  expect((await collectProxyRunDirs(root, null)).map(artifact => relative(root, artifact.path))).toEqual([
    join('agent-code', 'resume-a5fb379b', '2026-09-27T01-03-52-273Z'),
  ])
})

// Worker rule "unknown is never empty" (q109, q115). dirStats swallowed EVERY
// child error as "best effort", so a child it could not read simply did not
// count: the run dir's age came from what WAS readable. A run whose fresh
// data sits in a child the pass cannot read (EACCES, EIO, EMFILE) looked as
// old as its oldest file, and the TTL pass removed it. An unreadable child is
// UNKNOWN, and unknown must protect the whole dir. Only ENOENT (a concurrent
// remover won the race) means "not there". Real filesystem throughout: fail
// once, recover, maintain, and the bytes survive; then a truly old dir still
// goes, so the protection is not permanent.
it('a run dir with a child it cannot read is protected, and is collected normally once readable again', async () => {
  const root = mkdtempSync(join(tmpdir(), 'proxy-retention-'))
  roots.push(root)
  const now = Date.now()
  const old = new Date(now - 30 * 24 * 3_600_000)
  const dir = runDir(root, ['agent-code', 'shell-1', '2026-09-29T00-00-00-000Z'], { 'sslkeylog.log': 'k'.repeat(512) })
  utimesSync(join(dir, 'sslkeylog.log'), old, old)
  const streams = join(dir, 'streams')
  mkdirSync(streams)
  writeFileSync(join(streams, 'fresh.bin'), 'f'.repeat(256))
  utimesSync(dir, old, old)

  const caps = {} as Record<DebugStorageBucket, number>
  for (const bucket of ['proxy'] as DebugStorageBucket[]) caps[bucket] = 1_000_000_000
  const policy: DebugStoragePrunePolicy = { now, ttlMs: 48 * 3_600_000, activeGraceMs: 10 * 60_000, budgetBytes: 1_000_000_000, caps }
  const prune = async () => runPrunePasses(await collectProxyRunDirs(root, new Set()), policy, async artifact => {
    try { await rm(artifact.path, { recursive: true, force: true }); return true } catch { return false }
  })

  chmodSync(streams, 0o000)
  locked.push(streams)
  await prune()
  expect(existsSync(join(dir, 'sslkeylog.log'))).toBe(true)

  chmodSync(streams, 0o700)
  locked.splice(0)
  await prune()
  await prune()
  expect(existsSync(join(dir, 'sslkeylog.log'))).toBe(true)
  expect(existsSync(join(streams, 'fresh.bin'))).toBe(true)

  utimesSync(join(streams, 'fresh.bin'), old, old)
  utimesSync(streams, old, old)
  utimesSync(dir, old, old)
  await prune()
  expect(existsSync(dir)).toBe(false)
})

// The baseline behind "future runs only" (#1388 review a, round 2). It is
// captured once, the first time this build starts, and reused. Capture is
// strict: a subtree it cannot read would leave its old key logs out of the
// baseline, so any unreadable directory means NO baseline (nothing
// key-log-only is collected) and nothing is written, so a later start retries.
it('captures the key-log baseline once, reuses it, and fails closed when capture or the file cannot be read', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'keylog-baseline-'))
  roots.push(dir)
  const root = join(dir, 'proxy')
  const file = join(dir, 'state', 'debug-retention-keylog-baseline.json')
  runDir(root, ['medlo', 'shell-old', '2026-08-28T17-30-06-452Z'], { 'sslkeylog.log': 'k' })
  runDir(root, ['agent-code', 'run-with-events', '2026-09-01T00-00-00-000Z'], { 'proxy-events.jsonl': '{}', 'sslkeylog.log': 'k' })

  const locked = join(root, 'locked-project')
  mkdirSync(locked)
  chmodSync(locked, 0o000)
  try {
    expect(await keyLogBaseline(file, root)).toBeNull()
    expect(existsSync(file)).toBe(false)
  } finally {
    chmodSync(locked, 0o700)
  }

  const first = await keyLogBaseline(file, root)
  expect(first && [...first]).toEqual([join('medlo', 'shell-old', '2026-08-28T17-30-06-452Z')])
  runDir(root, ['medlo', 'shell-later', '2026-09-27T19-00-00-000Z'], { 'sslkeylog.log': 'k' })
  expect([...(await keyLogBaseline(file, root))!]).toEqual([join('medlo', 'shell-old', '2026-08-28T17-30-06-452Z')])

  writeFileSync(file, '{not json')
  expect(await keyLogBaseline(file, root)).toBeNull()

  // A baseline that cannot be WRITTEN is not established either (#1388
  // review b): returning the unsaved set would let the next start capture a
  // different one, including key logs made in between.
  const readOnlyState = join(dir, 'read-only-state')
  mkdirSync(readOnlyState)
  chmodSync(readOnlyState, 0o500)
  try {
    expect(await keyLogBaseline(join(readOnlyState, 'baseline.json'), root)).toBeNull()
  } finally {
    chmodSync(readOnlyState, 0o700)
  }
})

// #1388 review a round 3 (1): a proxy root that is missing at capture is
// UNKNOWN, not empty. Saving [] would let every old key log that reappears
// be collected, so no baseline is saved and none is returned.
it('saves no baseline when the proxy root is missing at capture', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'keylog-baseline-'))
  roots.push(dir)
  const file = join(dir, 'state', 'baseline.json')
  expect(await keyLogBaseline(file, join(dir, 'proxy-renamed-away'))).toBeNull()
  expect(existsSync(file)).toBe(false)
})
