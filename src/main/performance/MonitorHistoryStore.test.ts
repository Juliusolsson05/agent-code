import { appendFile, chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { MonitorWorkerSnapshot } from '@shared/performance/monitorSnapshot.js'
import { MonitorHistoryStore } from './MonitorHistoryStore.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

const snapshot = (at: number): MonitorWorkerSnapshot => ({
  schemaVersion: 1, sampledAt: at,
  main: { at, cpuPercent: 2, rss: 1024, heapUsed: 256, heapLimit: 2048, loopMeanMs: 20, loopP99Ms: 22, loopMaxMs: 25, sleepGap: false },
  windows: [], operations: [], recent: [], workerRss: 4096,
})
const incident = {
  id: 1, ruleVersion: 1 as const, rule: 'renderer-stall' as const, at: 10_000,
  scope: 73, severity: 'error' as const, observed: 1500, threshold: 1000,
  state: 'complete' as const, truncated: false, evidenceCount: 1,
  evidence: [{ at: 9_000, kind: 'window' as const, scope: 73, value: 800,
    cpuPercent: null, heapRatio: null, longTaskMs: 400, sleepGap: false }],
}

describe('bounded local performance history', () => {
  it('persists tiered points, pages them, rejects a corrupt privacy-bearing tail and exports incrementally', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-code-monitor-'))
    roots.push(root)
    const store = new MonitorHistoryStore(root, 'run-a', () => 30_000)
    for (let at = 1000; at <= 20_000; at += 1000) store.record(snapshot(at), null, [incident], 0, 0)
    await store.settled()

    const first = await store.query(1000, 20_000, undefined, 7)
    expect(first.resolution).toBe('1s')
    expect(first.points).toHaveLength(7)
    expect(first.nextCursor).toBe('7')
    expect(first.incidents).toEqual([expect.objectContaining({ id: 1, rule: 'renderer-stall', evidenceCount: 1 })])
    expect(await store.readIncident(10_000, 1)).toEqual(incident)
    expect(store.status().bytes).toBeLessThan(128 * 1024 * 1024)

    await appendFile(join(root, 'runs', 'run-a', '1s.jsonl'), '{"schemaVersion":1,"prompt":"privacy-sentinel"}\n')
    const destination = join(root, 'report.json')
    const result = await store.exportReport(1000, 20_000, destination, { packageVersion: 'test', dirty: false })
    expect(result).toMatchObject({ ok: true, points: 20 })
    const report = await readFile(destination, 'utf8')
    expect(JSON.parse(report)).toMatchObject({ schemaVersion: 1, localOnly: true, build: { packageVersion: 'test' } })
    expect(report).not.toContain('privacy-sentinel')
    expect(JSON.parse(report).incidents[0]).toMatchObject({ scope: 'window-1', evidence: [{ scope: 'window-1' }] })
    expect(report).not.toContain('"scope":73')
    expect(store.status().state).toBe('degraded')

    expect(await store.clear()).toMatchObject({ state: 'healthy', bytes: 0, points: 0 })
    store.record(snapshot(20_000), null, [], 0, 0)
    await store.settled()
    expect((await store.query(20_000, 20_000, undefined, 7)).points).toHaveLength(1)
  })

  it('keeps an existing destination intact when report creation fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-code-monitor-'))
    roots.push(root)
    const store = new MonitorHistoryStore(root, 'run-b')
    await store.settled()
    const destination = join(root, 'existing.json')
    await appendFile(destination, 'keep-me')
    const result = await store.exportReport(2, 1, destination, {})
    expect(result).toEqual({ ok: false, code: 'invalid-range' })
    expect(await readFile(destination, 'utf8')).toBe('keep-me')
  })

  it('returns a bounded overview spanning the selected long range', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-code-monitor-'))
    roots.push(root)
    const points = Array.from({ length: 2001 }, (_, index) => ({
      schemaVersion: 1 as const, at: index * 60_000, resolution: '1m' as const,
      main: { cpuPercent: 2, rss: 1024, heapUsed: 256, heapLimit: 2048,
        loopP99Ms: 22, loopMaxMs: 25, sleepGap: false },
      processes: null,
      windows: { count: 0, visible: 0, maxLagMs: 0, longTaskMs: 0, maxInputMs: 0 },
      workerRss: 4096, droppedRecords: 0, restarts: 0,
    }))
    // The store indexes history once at startup and is its only writer, so
    // the fixture must exist before construction.
    await mkdir(join(root, 'runs', 'run-c'), { recursive: true })
    await appendFile(join(root, 'runs', 'run-c', '1m.jsonl'), `${points.map(point => JSON.stringify(point)).join('\n')}\n`)
    const store = new MonitorHistoryStore(root, 'run-c')
    await store.settled()

    const overview = await store.query(0, 7 * 24 * 60 * 60_000, undefined, 1000)
    expect(overview.points.length).toBeLessThanOrEqual(300)
    expect(overview.points[0]!.at).toBeLessThanOrEqual(34 * 60_000)
    expect(overview.points.at(-1)!.at).toBe(2000 * 60_000)
    expect(overview).toMatchObject({ complete: true, nextCursor: null })
  })

  it('preserves and interrupts same-run incidents across a helper restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-code-monitor-'))
    roots.push(root)
    const first = new MonitorHistoryStore(root, 'run-restarted')
    first.record(snapshot(10_000), null, [{ ...incident, state: 'capturing' }], 0, 0)
    await first.settled()

    const restarted = new MonitorHistoryStore(root, 'run-restarted')
    await restarted.settled()
    restarted.record(snapshot(11_000), null, [], 0, 1)
    await restarted.settled()

    expect(await restarted.readIncident(10_000, 1)).toMatchObject({
      rule: 'renderer-stall', state: 'interrupted', evidenceCount: 1,
    })
  })

  it('repairs a torn append and keeps coarse tiers peak-preserving', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-code-monitor-'))
    roots.push(root)
    await mkdir(join(root, 'runs', 'run-d'), { recursive: true })
    await writeFile(join(root, 'runs', 'run-d', '10s.jsonl'), '{"schemaVersion":1,"at":')
    const store = new MonitorHistoryStore(root, 'run-d', () => 30_000)
    for (let at = 1000; at <= 12_000; at += 1000) {
      const sample = snapshot(at)
      store.record(at === 5000 ? { ...sample, main: { ...sample.main!, loopMaxMs: 900 } } : sample, null, [], 0, 0)
    }
    await store.flush()
    const lines = (await readFile(join(root, 'runs', 'run-d', '10s.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    // The torn fragment is gone rather than fused with the first valid line,
    // and the 10 s bucket reports the 900 ms peak instead of its last sample.
    expect(lines.map(line => line.at)).toEqual([9000, 12_000])
    expect(lines[0].main.loopMaxMs).toBe(900)
    expect(store.status()).toMatchObject({ state: 'healthy', points: 12 + 2 + 1 })
  })

  it('falls back to a coarser tier when the fine tier no longer retains the range start', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-code-monitor-'))
    roots.push(root)
    const store = new MonitorHistoryStore(root, 'run-e', () => 20 * 60_000)
    for (let at = 0; at <= 20 * 60_000; at += 10_000) store.record(snapshot(at), null, [], 0, 0)
    await store.settled()
    expect((await store.query(60_000, 16 * 60_000, undefined, 7)).resolution).toBe('10s')
    expect((await store.query(10 * 60_000, 16 * 60_000, undefined, 7)).resolution).toBe('1s')
  })
})

// #1453 (q115 "unknown is never empty"): retention deleted any run folder
// its in-memory index did not know. A run created AFTER this store indexed,
// by a second store sharing the folder (`--packaging-smoke` skips the
// single-instance lock), was never examined, so it looked empty and was
// deleted on the next maintenance pass.
//
// WHY the real clock and aged fixtures (#1455 review c): retention also keeps
// any run touched within the retention window (touchedSince, review b). With a
// 1970-scale fake clock every fixture looked freshly touched, so that guard
// shadowed every other one and their mutations survived. Here each fixture's
// files AND folder are aged past retention, so only the guard a test names
// can keep the run.
describe('a run this store never examined', () => {
  const DAY = 24 * 60 * 60_000
  const aged = async (dir: string, now: number): Promise<void> => {
    const old = new Date(now - 30 * DAY)
    for (const name of await readdir(dir)) await utimes(join(dir, name), old, old)
    await utimes(dir, old, old)
  }
  const setup = async () => {
    const root = await mkdtemp(join(tmpdir(), 'monitor-unexamined-'))
    roots.push(root)
    const foreign = join(root, 'runs', 'run-a')
    return { root, foreign }
  }

  it('is kept by retention until a later start examines it, and its folder is removed once expired', async () => {
    const { root, foreign } = await setup()
    let now = Date.now()
    const first = new MonitorHistoryStore(root, 'run-b', () => now)
    await first.settled()
    // What the other store writes once it starts, with old mtimes (a copied
    // or restored folder): only the examinedRuns guard can keep it.
    await mkdir(foreign, { recursive: true })
    await writeFile(join(foreign, 'incidents.json'), JSON.stringify([{ ...incident, at: now }]))
    await writeFile(join(foreign, 'operations.json'), '[]')
    await aged(foreign, now)
    first.record(snapshot(now), null, [], 0, 0)
    await first.settled()
    expect(JSON.parse(await readFile(join(foreign, 'incidents.json'), 'utf8'))).toHaveLength(1)

    // A later start examines run-a; its incident is still within retention.
    const restarted = new MonitorHistoryStore(root, 'run-c', () => now)
    restarted.record(snapshot(now), null, [], 0, 0)
    await restarted.settled()
    expect(JSON.parse(await readFile(join(foreign, 'incidents.json'), 'utf8'))).toHaveLength(1)

    // Past retention, the examined run's incident goes, and then its folder:
    // the protection is not permanent (review c pins this direction).
    now += 8 * DAY
    restarted.record(snapshot(now), null, [], 0, 0)
    await restarted.settled()
    await expect(readFile(join(foreign, 'incidents.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    now += 2 * 60_000
    restarted.record(snapshot(now), null, [], 0, 0)
    await restarted.settled()
    await expect(readdir(foreign)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  // #1455 review a (1): an incident file that cannot be read at indexing is
  // UNKNOWN; the run was examined but its contents are not known.
  it('keeps a run whose incidents could not be read at indexing', async () => {
    const { root, foreign } = await setup()
    const now = Date.now()
    await mkdir(foreign, { recursive: true })
    await writeFile(join(foreign, 'incidents.json'), JSON.stringify([{ ...incident, at: now - 30 * DAY }]))
    await aged(foreign, now)
    await chmod(join(foreign, 'incidents.json'), 0o000)
    const store = new MonitorHistoryStore(root, 'run-b', () => now)
    try {
      await store.settled()
    } finally {
      await chmod(join(foreign, 'incidents.json'), 0o600)
    }
    await aged(foreign, now)
    store.record(snapshot(now), null, [], 0, 0)
    await store.settled()
    expect(JSON.parse(await readFile(join(foreign, 'incidents.json'), 'utf8'))).toHaveLength(1)
  })

  // #1455 review a (2): `examinedRuns` names a run, not what this store saw.
  // Recreated by another store after its deletion, the run is unexamined.
  it('does not treat a run recreated after its deletion as examined', async () => {
    const { root, foreign } = await setup()
    let now = Date.now()
    await mkdir(foreign, { recursive: true })
    await writeFile(join(foreign, 'incidents.json'), JSON.stringify([{ ...incident, at: now - 30 * DAY }]))
    await aged(foreign, now)
    const store = new MonitorHistoryStore(root, 'run-b', () => now)
    store.record(snapshot(now), null, [], 0, 0)
    await store.settled()
    // The expired incident file went; the emptied folder's fresh mtime keeps
    // it one more pass, so age it and let retention remove it.
    await aged(foreign, now)
    now += 2 * 60_000
    store.record(snapshot(now), null, [], 0, 0)
    await store.settled()
    await expect(readdir(foreign)).rejects.toMatchObject({ code: 'ENOENT' })
    // The other store recreates run-a (old mtimes: only the forgotten
    // examination can keep it).
    await mkdir(foreign, { recursive: true })
    await writeFile(join(foreign, 'incidents.json'), JSON.stringify([{ ...incident, at: now }]))
    await aged(foreign, now)
    now += 2 * 60_000
    store.record(snapshot(now), null, [], 0, 0)
    await store.settled()
    expect(JSON.parse(await readFile(join(foreign, 'incidents.json'), 'utf8'))).toHaveLength(1)
  })

  // #1455 review b (1): a tier file whose stat fails with anything but ENOENT
  // (ELOOP from a self-referencing link) makes the run unknown. Two guards hold
  // here: indexing marks the run unknown, and touchedSince counts an
  // unstat-able file as touched; removing one alone survives.
  it('keeps a run whose tier file cannot be stat-ed at indexing', async () => {
    const { root, foreign } = await setup()
    const now = Date.now()
    await mkdir(foreign, { recursive: true })
    await symlink(join(foreign, '1m.jsonl'), join(foreign, '1m.jsonl'))
    const store = new MonitorHistoryStore(root, 'run-b', () => now)
    store.record(snapshot(now), null, [], 0, 0)
    await store.settled()
    expect((await lstat(join(foreign, '1m.jsonl'))).isSymbolicLink()).toBe(true)
  })

  // #1455 review b (2): content the store cannot parse is unknown, not
  // expired. Aged, so only the "unparsed" guard can keep it.
  it('keeps a run whose tier file holds content it cannot parse', async () => {
    const { root, foreign } = await setup()
    const now = Date.now()
    await mkdir(foreign, { recursive: true })
    await writeFile(join(foreign, '1m.jsonl'), '{"private":"unparseable-point"}\n')
    await aged(foreign, now)
    const store = new MonitorHistoryStore(root, 'run-b', () => now)
    store.record(snapshot(now), null, [], 0, 0)
    await store.settled()
    expect(await readFile(join(foreign, '1m.jsonl'), 'utf8')).toContain('unparseable-point')
  })

  // #1455 review b (3): a run examined while EMPTY can be filled later by the
  // other store; its fresh files keep it (touchedSince).
  it('keeps a run that was empty when examined and filled afterwards', async () => {
    const { root, foreign } = await setup()
    const now = Date.now()
    await mkdir(foreign, { recursive: true })
    await aged(foreign, now)
    const store = new MonitorHistoryStore(root, 'run-b', () => now)
    await store.settled()
    await writeFile(join(foreign, 'incidents.json'), JSON.stringify([{ ...incident, at: now }]))
    store.record(snapshot(now), null, [], 0, 0)
    await store.settled()
    expect(JSON.parse(await readFile(join(foreign, 'incidents.json'), 'utf8'))).toHaveLength(1)
  })
})
