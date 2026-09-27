import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

const userData = { dir: tmpdir() }
vi.mock('electron', () => ({ app: { getPath: () => userData.dir } }))
const { PasteDebugJournalRegistry, pasteDebugLogPath } = await import('./pasteDebugJournal.js')

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })

// #1278: a paste id is a fresh UUID per Enter and dispose() had no caller, so
// the registry kept one writer per paste for the life of the process.
it('keeps at most 64 writers, never evicts the one it hands out, and still writes an evicted paste on shutdown', async () => {
  userData.dir = await mkdtemp(join(tmpdir(), 'ac-paste-user-'))
  dirs.push(userData.dir)
  const registry = new PasteDebugJournalRegistry()
  registry.get('paste-0').append({ layer: 'RENDER', event: 'enter:observed' })
  for (let i = 1; i <= 200; i++) registry.get(`paste-${i}`)
  expect(registry.size).toBe(64)
  const newest = registry.get('paste-200')
  expect(registry.get('paste-200')).toBe(newest)

  await registry.flushAll()
  expect(await readFile(pasteDebugLogPath('paste-0'), 'utf8')).toContain('enter:observed')
})
