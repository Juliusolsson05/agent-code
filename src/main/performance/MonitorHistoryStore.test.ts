import { appendFile, chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
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

  // #1352 verification b: the store's persistence slice is the third place
  // that capped operation histograms at a literal 100 (26 operations x 4
  // outcomes = 104). The aggregator test cannot see this path; only the
  // saved operations.json shows whether every legal pair reaches history.
  it('persists a histogram for every legal operation and outcome', async () => {
    const { MONITOR_OPERATIONS, MONITOR_OUTCOMES } = await import('@shared/performance/monitorPolicy.js')
    const { MonitorAggregator } = await import('./MonitorAggregator.js')
    const aggregator = new MonitorAggregator()
    for (const name of MONITOR_OPERATIONS) {
      for (const outcome of MONITOR_OUTCOMES) {
        aggregator.accept([{ kind: 'operation', at: 1000, windowId: null, sample: { kind: 'operation', name, outcome, durationMs: 5 } }])
      }
    }
    const root = await mkdtemp(join(tmpdir(), 'agent-code-monitor-'))
    roots.push(root)
    const store = new MonitorHistoryStore(root, 'run-ops', () => 2000)
    store.record({ ...snapshot(2000), operations: aggregator.snapshot(2000, 100).operations }, null, null, 0, 0)
    await store.settled()
    const saved = JSON.parse(await readFile(join(root, 'runs', 'run-ops', 'operations.json'), 'utf8')) as Array<{ name: string; outcome: string }>
    expect(saved).toHaveLength(MONITOR_OPERATIONS.length * MONITOR_OUTCOMES.length)
    expect(saved.map(entry => `${entry.name}:${entry.outcome}`)).toContain('heap.snapshot:timeout')
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

  it('keeps readable incidents and never erases a row it does not recognise (#1251 row 9)', async () => {
    // A preview build can write an incident rule this build does not know, and
    // the owner moves between the Preview and stable channels. One such row
    // used to hide the run's whole incident list AND, on a helper restart in
    // that run, persistIncidents replaced the file with only the new engine's
    // rows, erasing the evidence it could not read.
    const root = await mkdtemp(join(tmpdir(), 'agent-code-monitor-'))
    roots.push(root)
    const foreign = { ...incident, id: 9, at: 10_500, rule: 'rule-from-a-newer-build' }
    await mkdir(join(root, 'runs', 'run-mixed'), { recursive: true })
    await writeFile(join(root, 'runs', 'run-mixed', 'incidents.json'), JSON.stringify([incident, foreign]))

    const restarted = new MonitorHistoryStore(root, 'run-mixed')
    await restarted.settled()
    restarted.record(snapshot(11_000), null, [{ ...incident, id: 2, at: 11_000 }], 0, 1)
    await restarted.settled()

    expect(await restarted.readIncident(10_000, 1)).toMatchObject({ rule: 'renderer-stall' })
    expect(await restarted.readIncident(11_000, 2)).toMatchObject({ rule: 'renderer-stall' })
    expect(restarted.status().state).toBe('degraded')
    const onDisk = JSON.parse(await readFile(join(root, 'runs', 'run-mixed', 'incidents.json'), 'utf8')) as Array<{ id: number; rule: string }>
    expect(onDisk.map(row => row.id).sort()).toEqual([1, 2, 9])
    expect(onDisk.find(row => row.id === 9)).toEqual(foreign)
  })

  // Review of #1411 (a, b, c): a file refused WHOLE (not an array, a newer
  // format, over the row limit, oversized) kept no marker, so a restarted
  // helper's next incident replaced it with only the new row, and it was lost.
  for (const [label, body] of [
    ['a newer-format object', JSON.stringify({ version: 2, incidents: [incident] })],
    ['51 valid rows, one over the limit', JSON.stringify(Array.from({ length: 51 }, (_, index) => ({ ...incident, id: index + 1, at: 1000 + index })))],
    ['malformed JSON', '[{"id":1,'],
  ] as const) {
    it(`sets a wholly refused current-run incident file aside instead of overwriting it: ${label}`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'agent-code-monitor-'))
      roots.push(root)
      const runDir = join(root, 'runs', 'run-refused')
      await mkdir(runDir, { recursive: true })
      await writeFile(join(runDir, 'incidents.json'), body)

      const restarted = new MonitorHistoryStore(root, 'run-refused')
      await restarted.settled()
      restarted.record(snapshot(11_000), null, [{ ...incident, id: 99, at: 11_000 }], 0, 1)
      await restarted.settled()

      expect(await restarted.readIncident(11_000, 99)).toMatchObject({ rule: 'renderer-stall' })
      const aside = (await readdir(runDir)).filter(name => name.startsWith('incidents.refused-'))
      expect(aside).toHaveLength(1)
      expect(await readFile(join(runDir, aside[0]!), 'utf8')).toBe(body)
      expect(restarted.status().state).toBe('degraded')
    })
  }

  // Review of #1411, round 2 (a, b, c): once the refused file was set aside,
  // nothing marked its run, so a later run's retention expired the run's
  // readable incidents, found it empty, and deleted the directory with the
  // set-aside bytes in it.
  it('keeps a run holding a set-aside refused file after its readable incidents expire', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-code-monitor-'))
    roots.push(root)
    const runA = join(root, 'runs', 'run-a')
    const refused = JSON.stringify({ version: 2, incidents: [incident] })
    await mkdir(runA, { recursive: true })
    await writeFile(join(runA, 'incidents.json'), refused)
    const first = new MonitorHistoryStore(root, 'run-a')
    await first.settled()
    first.record(snapshot(11_000), null, [{ ...incident, id: 2, at: 11_000 }], 0, 1)
    await first.settled()

    const later = new MonitorHistoryStore(root, 'run-b')
    await later.settled()
    later.record(snapshot(11_000 + 8 * 24 * 60 * 60_000), null, [], 0, 0)
    await later.settled()

    const aside = (await readdir(runA)).filter(name => name.startsWith('incidents.refused-'))
    expect(aside).toHaveLength(1)
    expect(await readFile(join(runA, aside[0]!), 'utf8')).toBe(refused)
  })

  // Review of #1411, round 2 (a, b, c): the set-aside name was only the time,
  // and rename replaces an existing file, so a second refusal in the same
  // millisecond erased the first. Also pins that recording again after a
  // set-aside writes normally and does not set the new file aside (a stale
  // refusal marker survived mutation in round 2).
  it('keeps every refused file when two refusals set aside in the same millisecond', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(123_456)
    try {
      const root = await mkdtemp(join(tmpdir(), 'agent-code-monitor-'))
      roots.push(root)
      const runDir = join(root, 'runs', 'run-twice')
      await mkdir(runDir, { recursive: true })
      const firstBody = JSON.stringify({ version: 2, generation: 'first' })
      const secondBody = JSON.stringify({ version: 3, generation: 'second' })
      await writeFile(join(runDir, 'incidents.json'), firstBody)
      const store = new MonitorHistoryStore(root, 'run-twice')
      await store.settled()
      store.record(snapshot(11_000), null, [{ ...incident, id: 2, at: 11_000 }], 0, 1)
      await store.settled()
      store.record(snapshot(12_000), null, [{ ...incident, id: 2, at: 11_000 }, { ...incident, id: 3, at: 12_000 }], 0, 1)
      await store.settled()
      expect((await readdir(runDir)).filter(name => name.startsWith('incidents.refused-'))).toHaveLength(1)
      const current = JSON.parse(await readFile(join(runDir, 'incidents.json'), 'utf8')) as Array<{ id: number }>
      expect(current.map(row => row.id)).toEqual([2, 3])

      await writeFile(join(runDir, 'incidents.json'), secondBody)
      const restarted = new MonitorHistoryStore(root, 'run-twice')
      await restarted.settled()
      restarted.record(snapshot(13_000), null, [{ ...incident, id: 4, at: 13_000 }], 0, 1)
      await restarted.settled()

      const aside = (await readdir(runDir)).filter(name => name.startsWith('incidents.refused-'))
      const bodies = await Promise.all(aside.map(name => readFile(join(runDir, name), 'utf8')))
      expect(bodies.sort()).toEqual([firstBody, secondBody].sort())
    } finally {
      vi.useRealTimers()
    }
  })

  // Review of #1411, round 2 (b): the guard that writes nothing when the
  // set-aside rename fails was unpinned. Losing the new rows beats
  // overwriting the refused ones.
  it('writes nothing over a refused file it could not set aside', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-code-monitor-'))
    roots.push(root)
    const runDir = join(root, 'runs', 'run-stuck')
    await mkdir(runDir, { recursive: true })
    const refused = JSON.stringify({ version: 2 })
    await writeFile(join(runDir, 'incidents.json'), refused)
    const store = new MonitorHistoryStore(root, 'run-stuck')
    await store.settled()
    await chmod(runDir, 0o500)
    try {
      store.record(snapshot(11_000), null, [{ ...incident, id: 2, at: 11_000 }], 0, 1)
      await store.settled()
    } finally {
      await chmod(runDir, 0o700)
    }
    expect(await readFile(join(runDir, 'incidents.json'), 'utf8')).toBe(refused)
    expect(store.status().shortened).toBe(true)
  })

  // Review of #1411 (a, b, c), a surviving mutation: maintenance deletes a
  // prior run it believes empty. A run whose incident file holds only rows
  // this build cannot read, or that it refused whole, is not empty.
  it('never expires a prior run whose incidents it could not read', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-code-monitor-'))
    roots.push(root)
    const foreignOnly = join(root, 'runs', 'run-foreign-only')
    const refused = join(root, 'runs', 'run-refused-whole')
    await mkdir(foreignOnly, { recursive: true })
    await mkdir(refused, { recursive: true })
    await writeFile(join(foreignOnly, 'incidents.json'), JSON.stringify([{ ...incident, rule: 'rule-from-a-newer-build' }]))
    await writeFile(join(refused, 'incidents.json'), JSON.stringify({ version: 2 }))

    const store = new MonitorHistoryStore(root, 'run-now')
    await store.settled()
    store.record(snapshot(90_000), null, [], 0, 0)
    await store.settled()

    await expect(stat(foreignOnly)).resolves.toBeTruthy()
    await expect(stat(refused)).resolves.toBeTruthy()
  })

  // Review of #1411 (a): with the run's file full of carried rows, a new
  // readable incident has no room. Keeping the carried rows is right; hiding
  // that the new one was not kept is not.
  it('reports coverage as shortened when carried rows leave no room for a new incident', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-code-monitor-'))
    roots.push(root)
    const runDir = join(root, 'runs', 'run-full')
    await mkdir(runDir, { recursive: true })
    await writeFile(join(runDir, 'incidents.json'), JSON.stringify(Array.from({ length: 50 }, (_, index) => ({ ...incident, id: index + 1, rule: 'rule-from-a-newer-build' }))))

    const store = new MonitorHistoryStore(root, 'run-full')
    await store.settled()
    store.record(snapshot(11_000), null, [{ ...incident, id: 99, at: 11_000 }], 0, 1)
    await store.settled()

    expect(store.status().shortened).toBe(true)
    const onDisk = JSON.parse(await readFile(join(runDir, 'incidents.json'), 'utf8')) as unknown[]
    expect(onDisk).toHaveLength(50)
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
