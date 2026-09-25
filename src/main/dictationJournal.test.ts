import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const userData = { dir: tmpdir() }
vi.mock('electron', () => ({ app: { getPath: () => userData.dir } }))
const { DictationDebugJournal, DictationDebugJournalRegistry, dictationDebugLogPath } = await import('./dictationJournal.js')

// #1276 / #1299: one press whose recorder ran 32.8 h wrote a 1.196 GB journal,
// 96 % of it per-chunk and per-sample events, and — found only by #1301's
// review — chunks and NON-ZERO audio levels continued for ~26 h after
// deepgram:close. Layer/event pairs are the ones the emitters write
// (src/main/ipc/dictation.ts, useComposerDictation.ts); data is minimal.
const chunk = (i: number) => ({ layer: 'CHUNK' as const, event: 'main:received', data: { streamId: 'stream-1', chunkIndex: i, bytes: 78, sha8: 'deadbeef' } })
const sample = (peak = 0) => ({ layer: 'AUDIO_LEVEL' as const, event: 'sample', data: { levels: [0, 0, 0, 0, 0, 0, 0], peak } })
const close = { layer: 'PROVIDER' as const, event: 'deepgram:close', data: { streamId: 'stream-1' } }
const HIGH_FREQUENCY = [
  chunk(1),
  sample(),
  { layer: 'RECORDER' as const, event: 'recorder:dataavailable', data: { pendingChunkIndex: 1, size: 46 } },
  { layer: 'PROVIDER' as const, event: 'deepgram:chunk:queue', data: { streamId: 'stream-1' } },
  { layer: 'PROVIDER' as const, event: 'deepgram:chunk:send', data: { streamId: 'stream-1' } },
  { layer: 'PROVIDER' as const, event: 'deepgram:message', data: { streamId: 'stream-1' } },
  { layer: 'TRANSCRIPT' as const, event: 'preview:interim', data: { chars: 12 } },
]

const dirs: string[] = []
let clock = 0
beforeEach(() => {
  clock = Date.UTC(2026, 8, 25)
  vi.spyOn(Date, 'now').mockImplementation(() => clock)
})
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})
async function tempFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ac-dictation-'))
  dirs.push(dir)
  return join(dir, 'press.dictation.jsonl')
}
async function lines(path: string) {
  return (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { event: string; tMs: number; data?: Record<string, unknown> })
}
function fill(journal: InstanceType<typeof DictationDebugJournal>) {
  // Past a tiny budget with lifecycle-kind events, so every later count
  // belongs to the high-frequency inputs under test.
  for (let i = 0; i < 30; i++) journal.append({ layer: 'IPC', event: 'stream:start:request', data: { attempt: i, pad: 'x'.repeat(80) } })
}

it('summarizes every high-frequency kind past the budget, and keeps errors and outcomes', async () => {
  const path = await tempFile()
  const journal = new DictationDebugJournal(path, { maxBytes: 2048 })
  fill(journal)
  for (const input of HIGH_FREQUENCY) journal.append(input)
  journal.append({ layer: 'ERROR', event: 'stream-start:rejected', data: { reason: 'x' } })
  journal.append({ layer: 'OUTCOME', event: 'error', data: {} })
  await journal.flush()
  const written = await lines(path)
  const events = written.map(line => line.event)
  expect(events.filter(event => event === 'journal:high-frequency-suppressed')).toHaveLength(1)
  expect(events).toContain('stream-start:rejected')
  expect(events).toContain('error')
  // None of the high-frequency kinds was written raw after the marker...
  const afterMarker = events.slice(events.indexOf('journal:high-frequency-suppressed') + 1)
  for (const input of HIGH_FREQUENCY) expect(afterMarker).not.toContain(input.event)
  // ...and every one was counted.
  const counts = written.filter(line => line.event === 'journal:high-frequency-summary')
    .reduce<Record<string, number>>((all, line) => ({ ...all, ...(line.data?.counts as Record<string, number>) }), {})
  for (const input of HIGH_FREQUENCY) expect(counts[`${input.layer}/${input.event}`]).toBe(1)
})

it('keeps the #1299 tail visible: activity and real audio after the socket closed', async () => {
  const path = await tempFile()
  const journal = new DictationDebugJournal(path, { maxBytes: 2048 })
  fill(journal)
  journal.append(close)
  // A day of chunks and levels after the close, one pair per second.
  for (let s = 0; s < 24 * 3600; s += 1) {
    clock += 1000
    journal.append(chunk(100_000 + s))
    journal.append(sample(s === 5000 ? 0.5 : 0))
  }
  await journal.flush()
  const written = await lines(path)
  const closeAt = written.find(line => line.event === 'deepgram:close')!.tMs
  const summaries = written.filter(line => line.event === 'journal:high-frequency-summary')
  expect(summaries.at(-1)!.data!.untilTMs as number).toBeGreaterThan(closeAt + 23 * 3600_000)
  expect(summaries.some(line => line.data!.maxPeak === 0.5 && line.data!.nonZeroPeaks === 1)).toBe(true)
  expect(summaries.at(-1)!.data!.lastChunkIndex).toBe(100_000 + 24 * 3600 - 1)
  // Bounded: one summary per minute, not one line per event.
  expect(summaries.length).toBeLessThanOrEqual(24 * 60 + 2)
  expect((await stat(path)).size).toBeLessThan(2048 + (24 * 60 + 2) * 400)
})

it('keeps the budget when the registry re-creates a writer for an evicted press', async () => {
  userData.dir = await mkdtemp(join(tmpdir(), 'ac-dictation-user-'))
  dirs.push(userData.dir)
  const path = dictationDebugLogPath('press-0')
  await import('node:fs/promises').then(fs => fs.mkdir(join(userData.dir, 'dictation-debug'), { recursive: true }))
  // A press that already wrote past the 16 MiB budget before eviction.
  await writeFile(path, `${'x'.repeat(16 * 1024 * 1024)}\n`)
  const registry = new DictationDebugJournalRegistry()
  registry.get('press-0').append(chunk(1))
  await registry.flushAll()
  const tail = (await readFile(path, 'utf8')).slice(16 * 1024 * 1024 + 1)
  expect(tail).toContain('journal:high-frequency-suppressed')
  expect(tail).not.toContain('"event":"main:received"')
})

it("writes an evicted press's queued events before shutdown completes", async () => {
  userData.dir = await mkdtemp(join(tmpdir(), 'ac-dictation-user-'))
  dirs.push(userData.dir)
  const registry = new DictationDebugJournalRegistry()
  registry.get('press-0').append(close)
  for (let i = 1; i <= 64; i++) registry.get(`press-${i}`)
  expect(registry.size).toBeLessThanOrEqual(64)
  await registry.flushAll()
  expect(await readFile(dictationDebugLogPath('press-0'), 'utf8')).toContain('deepgram:close')
})
