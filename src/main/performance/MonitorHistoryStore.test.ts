import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises'
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

describe('bounded local performance history', () => {
  it('persists tiered points, pages them, rejects a corrupt privacy-bearing tail and exports incrementally', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-code-monitor-'))
    roots.push(root)
    const store = new MonitorHistoryStore(root, 'run-a', () => 30_000)
    for (let at = 1000; at <= 20_000; at += 1000) store.record(snapshot(at), null, [], 0, 0)
    await store.settled()

    const first = await store.query(1000, 20_000, undefined, 7)
    expect(first.resolution).toBe('1s')
    expect(first.points).toHaveLength(7)
    expect(first.nextCursor).toBe('7')
    expect(store.status().bytes).toBeLessThan(128 * 1024 * 1024)

    await appendFile(join(root, 'runs', 'run-a', '1s.jsonl'), '{"schemaVersion":1,"prompt":"privacy-sentinel"}\n')
    const destination = join(root, 'report.json')
    const result = await store.exportReport(1000, 20_000, destination, { packageVersion: 'test', dirty: false })
    expect(result).toMatchObject({ ok: true, points: 20 })
    const report = await readFile(destination, 'utf8')
    expect(JSON.parse(report)).toMatchObject({ schemaVersion: 1, localOnly: true, build: { packageVersion: 'test' } })
    expect(report).not.toContain('privacy-sentinel')
    expect(store.status().state).toBe('degraded')
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
})
