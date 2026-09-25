import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))
const { DictationDebugJournal, DictationDebugJournalRegistry } = await import('./dictationJournal.js')

// #1276: one press whose recorder ran 32.8 h wrote a 1.196 GB journal, 96 % of
// it per-chunk and per-sample events. These are the recorded shapes (layer,
// event, data), minimal.
const chunk = (i: number) => ({ layer: 'CHUNK' as const, event: 'main:received', data: { streamId: 'stream-1', chunkIndex: i, bytes: 78, sha8: 'deadbeef' } })
const sample = { layer: 'AUDIO_LEVEL' as const, event: 'sample', data: { levels: [0, 0, 0, 0, 0, 0, 0], peak: 0 } }
const lifecycle = { layer: 'PROVIDER' as const, event: 'deepgram:close', data: { streamId: 'stream-1' } }

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })

it('stops writing per-chunk events past its budget but keeps lifecycle events', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ac-dictation-'))
  dirs.push(dir)
  const path = join(dir, 'press.dictation.jsonl')
  const journal = new DictationDebugJournal(path, { maxBytes: 4096 })
  for (let i = 0; i < 2000; i++) {
    journal.append(chunk(i))
    journal.append(sample)
    if (i % 100 === 0) await journal.flush()
  }
  journal.append(lifecycle)
  await journal.flush()
  const size = (await stat(path)).size
  expect(size).toBeLessThan(4096 + 1024)
  const text = await readFile(path, 'utf8')
  expect(text).toContain('journal:high-frequency-suppressed')
  expect(text).toContain('deepgram:close')
})

it('keeps a bounded number of journals', () => {
  const registry = new DictationDebugJournalRegistry()
  for (let i = 0; i < 500; i++) registry.get(`press-${i}`)
  expect(registry.size).toBeLessThanOrEqual(64)
})
