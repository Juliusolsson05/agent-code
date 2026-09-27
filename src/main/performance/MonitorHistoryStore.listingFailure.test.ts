import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { MonitorWorkerSnapshot } from '@shared/performance/monitorSnapshot.js'

// One per-run listing fails, once, while the parent listing succeeds: the
// shape of a transient EIO/EACCES on a single run directory. Everything else
// is the real filesystem. Its own file because this mock covers the module.
const failOnce = vi.hoisted(() => ({ path: null as string | null }))
vi.mock('node:fs/promises', async importOriginal => {
  const real = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...real,
    readdir: ((...args: Parameters<typeof real.readdir>) => {
      // Only the plain name listing (no options): cleanupTemps and runBytes list
      // the same directory with file types first and must not absorb the fault.
      if (failOnce.path !== null && String(args[0]) === failOnce.path && args[1] === undefined) {
        failOnce.path = null
        return Promise.reject(Object.assign(new Error('injected EIO'), { code: 'EIO' }))
      }
      return (real.readdir as (...a: unknown[]) => unknown)(...args)
    }) as typeof real.readdir,
  }
})
const { MonitorHistoryStore } = await import('./MonitorHistoryStore.js')

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const snapshot = (at: number): MonitorWorkerSnapshot => ({
  schemaVersion: 1, sampledAt: at,
  main: { at, cpuPercent: 2, rss: 1024, heapUsed: 256, heapLimit: 2048, loopMeanMs: 20, loopP99Ms: 22, loopMaxMs: 25, sleepGap: false },
  windows: [], operations: [], recent: [], workerRss: 4096,
})

// Steering q115: startup found set-aside refused files by listing each run
// and read a failed listing as "no files" (`.catch(() => [])`). A prior run
// holding ONLY a set-aside file then had no marker at all, and the next
// maintenance deleted it with the refused bytes, the same unknown-as-empty
// shape q109 forbade for the debug ledger.
it('keeps a run whose listing failed at startup, with its set-aside bytes intact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-code-monitor-'))
  roots.push(root)
  const runOld = join(root, 'runs', 'run-old')
  await mkdir(runOld, { recursive: true })
  const aside = 'incidents.refused-1-00000000-0000-4000-8000-000000000000.json'
  const refused = JSON.stringify({ version: 2, incidents: ['evidence'] })
  await writeFile(join(runOld, aside), refused)

  failOnce.path = runOld
  const store = new MonitorHistoryStore(root, 'run-now')
  await store.settled()
  expect(failOnce.path).toBeNull()
  store.record(snapshot(90_000), null, [], 0, 0)
  await store.settled()

  expect(await readdir(runOld)).toContain(aside)
  expect(await readFile(join(runOld, aside), 'utf8')).toBe(refused)
  expect(store.status().state).toBe('degraded')
})
