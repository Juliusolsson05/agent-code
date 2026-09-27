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

// Review of #1417 (b, c): a writer evicted while its timer drain is mid-append
// used to be "flushed" by a drain that returned at once, so flushAll resolved
// before that append landed. A re-created writer for the same paste could
// also append first, reversing the file's order.
it('drains an evicted writer whose append is already in flight, and keeps the file in event order', async () => {
  userData.dir = await mkdtemp(join(tmpdir(), 'ac-paste-user-'))
  dirs.push(userData.dir)
  const { appendFile: realAppend } = await import('node:fs/promises')
  let release: () => void = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  let firstHeld = false
  const appendFile = (async (...args: Parameters<typeof realAppend>) => {
    if (!firstHeld && String(args[0]).endsWith('paste-0.paste.jsonl')) {
      firstHeld = true
      await gate
    }
    return realAppend(...args)
  }) as typeof realAppend
  const registry = new PasteDebugJournalRegistry({ appendFile })
  registry.get('paste-0').append({ layer: 'RENDER', event: 'first' })
  await vi.waitFor(() => expect(firstHeld).toBe(true))

  for (let i = 1; i <= 64; i++) registry.get(`paste-${i}`)
  registry.get('paste-0').append({ layer: 'RENDER', event: 'second' })
  let shutdownDone = false
  const shutdown = registry.flushAll().then(() => { shutdownDone = true })
  await new Promise(resolve => setTimeout(resolve, 50))
  expect(shutdownDone).toBe(false)

  release()
  await shutdown
  const lines = (await readFile(pasteDebugLogPath('paste-0'), 'utf8')).trim().split('\n').map(line => JSON.parse(line).event)
  expect(lines).toEqual(['first', 'second'])
})
