import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

// The ledger's stat() fields are controlled for ONE path so a replacement can
// match size, mtime AND ctime and differ only in the inode: a real rename
// always moves ctime, so no portable filesystem sequence isolates the inode.
// Everything else, including the ledger's content, is the real filesystem.
// Its own file because this mock covers the module.
const identity = vi.hoisted(() => ({ path: '', ino: 1 }))
vi.mock('node:fs/promises', async importOriginal => {
  const real = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...real,
    stat: (async (...args: Parameters<typeof real.stat>) => {
      const info = await real.stat(...args)
      if (String(args[0]) !== identity.path) return info
      return Object.assign(Object.create(Object.getPrototypeOf(info)), info, {
        ino: identity.ino, ctimeMs: 1_000, mtimeMs: 1_000, size: info.size,
      })
    }) as typeof real.stat,
  }
})
const { cachedManualLegacyBundlePaths } = await import('./debugRetention.js')

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

// Manager verification of #1417: removing the inode from the cache key passed
// every test. A ledger replaced by another file with the same size, mtime and
// ctime (a restore from backup, a rename-over within the timestamp resolution)
// is a DIFFERENT file, and only the inode says so; a stale cached parse would
// keep classifying bundles from the old ledger.
it('re-parses a replacement that only a new inode distinguishes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ledger-identity-'))
  dirs.push(root)
  const ledger = join(root, 'saved-debug-bundles.jsonl')
  identity.path = ledger
  const row = (bundlePath: string) => `${JSON.stringify({ event: 'saved', reason: 'manual', bundlePath })}\n`
  writeFileSync(ledger, row('/bundles/2026-01-01T00-00-01'))
  expect(await cachedManualLegacyBundlePaths(ledger)).toEqual(new Set(['/bundles/2026-01-01T00-00-01']))

  // Same size, and the mocked stat keeps mtime and ctime equal too.
  writeFileSync(ledger, row('/bundles/2026-01-01T00-00-02'))
  identity.ino = 2
  expect(await cachedManualLegacyBundlePaths(ledger)).toEqual(new Set(['/bundles/2026-01-01T00-00-02']))
})
