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

// Review of #1417, round 2 (a, b, c): a failed append dropped its batch for
// good, the timer's failure was an unhandled rejection, and a flush that
// joined the failed write resolved as if it had landed.
it('keeps a failed batch, retries it in order, and never resolves a flush over a lost write', async () => {
  userData.dir = await mkdtemp(join(tmpdir(), 'ac-paste-user-'))
  dirs.push(userData.dir)
  const { appendFile: realAppend } = await import('node:fs/promises')
  let failures = 2
  const appendFile = (async (...args: Parameters<typeof realAppend>) => {
    if (failures > 0) {
      failures--
      throw Object.assign(new Error('injected EIO'), { code: 'EIO' })
    }
    return realAppend(...args)
  }) as typeof realAppend
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown) => { unhandled.push(reason) }
  process.on('unhandledRejection', onUnhandled)
  try {
    const registry = new PasteDebugJournalRegistry({ appendFile })
    const journal = registry.get('paste-retry')
    journal.append({ layer: 'RENDER', event: 'first' })
    // The timer's drain fails twice (the append and its mkdir retry).
    await vi.waitFor(() => expect(failures).toBe(0))
    await new Promise(resolve => setTimeout(resolve, 20))
    journal.append({ layer: 'RENDER', event: 'second' })
    await registry.flushAll()

    const events = (await readFile(pasteDebugLogPath('paste-retry'), 'utf8')).trim().split('\n').map(line => JSON.parse(line).event)
    expect(events).toEqual(['first', 'second'])
    expect(unhandled).toEqual([])
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
})

it('a flush that cannot write rejects instead of reporting success', async () => {
  userData.dir = await mkdtemp(join(tmpdir(), 'ac-paste-user-'))
  dirs.push(userData.dir)
  const appendFile = (async () => { throw Object.assign(new Error('injected EIO'), { code: 'EIO' }) }) as unknown as typeof import('node:fs/promises').appendFile
  const journal = new PasteDebugJournalRegistry({ appendFile }).get('paste-dead-disk')
  journal.append({ layer: 'RENDER', event: 'lost?' })
  // Both callers, including the one that joined the other's write (round 2,
  // c: it used to settle as fulfilled).
  const settled = await Promise.allSettled([journal.flush(), journal.flush()])
  expect(settled.map(result => result.status)).toEqual(['rejected', 'rejected'])
})

// The retry queue is itself bounded: a disk that keeps failing must not turn
// this writer into the unbounded growth #1278 is about.
it('holds at most 1000 lines while writes fail, and reports what it dropped once they work', async () => {
  userData.dir = await mkdtemp(join(tmpdir(), 'ac-paste-user-'))
  dirs.push(userData.dir)
  const { appendFile: realAppend } = await import('node:fs/promises')
  let broken = true
  const appendFile = (async (...args: Parameters<typeof realAppend>) => {
    if (broken) throw Object.assign(new Error('injected EIO'), { code: 'EIO' })
    return realAppend(...args)
  }) as typeof realAppend
  const journal = new PasteDebugJournalRegistry({ appendFile }).get('paste-bounded')
  for (let i = 0; i < 1500; i++) journal.append({ layer: 'RENDER', event: `e${i}` })
  await expect(journal.flush()).rejects.toThrow()

  broken = false
  await journal.flush()
  const events = (await readFile(pasteDebugLogPath('paste-bounded'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  expect(events[0]).toMatchObject({ layer: 'ERROR', event: 'journal:dropped-lines', data: { lines: 500 } })
  expect(events.slice(1).map(event => event.event)).toEqual(Array.from({ length: 1000 }, (_, i) => `e${i + 500}`))
})

// Manager verification of #1417: re-queueing a failed batch at the BACK passed
// every test. A line appended while the failing write was in flight must land
// after the retried batch; the reader takes a session's start from line one.
it('retries a failed batch ahead of lines appended while it was writing', async () => {
  userData.dir = await mkdtemp(join(tmpdir(), 'ac-paste-user-'))
  dirs.push(userData.dir)
  const { appendFile: realAppend } = await import('node:fs/promises')
  let release: () => void = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  let calls = 0
  const appendFile = (async (...args: Parameters<typeof realAppend>) => {
    calls++
    if (calls <= 2) {
      // The first write and its mkdir retry: held, then both fail.
      await gate
      throw Object.assign(new Error('injected EIO'), { code: 'EIO' })
    }
    return realAppend(...args)
  }) as typeof realAppend
  const journal = new PasteDebugJournalRegistry({ appendFile }).get('paste-order')
  journal.append({ layer: 'RENDER', event: 'first' })
  await vi.waitFor(() => expect(calls).toBe(1))
  journal.append({ layer: 'RENDER', event: 'second' })
  release()
  await journal.flush()

  const events = (await readFile(pasteDebugLogPath('paste-order'), 'utf8')).trim().split('\n').map(line => JSON.parse(line).event)
  expect(events).toEqual(['first', 'second'])
})
