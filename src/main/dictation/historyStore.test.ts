import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

// STATE_DIR is resolved from homedir() at import time, so the store has to be
// pointed at a scratch directory before it loads. One temp dir for the whole
// file; each test clears the store between runs.
const scratch = await mkdtemp(join(tmpdir(), 'agent-code-dictation-history-'))
vi.mock('@main/storage/paths.js', () => ({ STATE_DIR: scratch }))

const {
  appendEntry,
  clearEntries,
  deleteEntry,
  flushHistoryWrites,
  readHistory,
  resetTotals,
} = await import('./historyStore.js')

const HISTORY_FILE = join(scratch, 'dictation', 'history.json')

function input(text: string, audioDurationMs = 60_000) {
  return {
    text,
    provider: 'deepgram' as const,
    audioDurationMs,
    audioBytes: 1000,
    chunkCount: 5,
    sttMs: 200,
  }
}

beforeEach(async () => {
  await resetTotals()
})

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true })
})

describe('dictation history store', () => {
  it('accumulates lifetime totals across entries', async () => {
    await appendEntry(input('one two three'))
    const snapshot = await appendEntry(input('four five'))

    expect(snapshot.stats.lifetimeWords).toBe(5)
    expect(snapshot.stats.lifetimeSessions).toBe(2)
    expect(snapshot.entries).toHaveLength(2)
    // Newest first — the UI is the only consumer and always wants that order.
    expect(snapshot.entries[0]?.text).toBe('four five')
  })

  it('keeps lifetime totals when a single entry is deleted', async () => {
    const first = await appendEntry(input('alpha beta gamma'))
    const id = first.entries[0]!.id

    const after = await deleteEntry(id)

    // The whole reason totals are stored rather than summed from `entries`:
    // deleting a row means "stop showing me this", not "I never said it".
    expect(after.entries).toHaveLength(0)
    expect(after.stats.lifetimeWords).toBe(3)
    expect(after.stats.lifetimeSessions).toBe(1)
  })

  it('keeps lifetime totals when the list is cleared, and drops them only on reset', async () => {
    await appendEntry(input('one two'))
    const cleared = await clearEntries()
    expect(cleared.entries).toHaveLength(0)
    expect(cleared.stats.lifetimeWords).toBe(2)

    const reset = await resetTotals()
    expect(reset.stats.lifetimeWords).toBe(0)
    expect(reset.stats.lifetimeSessions).toBe(0)
  })

  it('computes words per minute from accumulated spoken time', async () => {
    // 120 words over exactly two minutes.
    await appendEntry(input(Array.from({ length: 60 }, (_, i) => `w${i}`).join(' '), 60_000))
    const snapshot = await appendEntry(
      input(Array.from({ length: 60 }, (_, i) => `x${i}`).join(' '), 60_000),
    )

    expect(snapshot.stats.averageWpm).toBe(60)
  })

  it('never reports NaN or Infinity when no measurable audio was recorded', async () => {
    const snapshot = await appendEntry(input('spoken', 0))

    // A zero duration must not enter the denominator; both NaN and Infinity
    // reach the DOM as literal text.
    expect(snapshot.stats.lifetimeWords).toBe(1)
    expect(snapshot.stats.averageWpm).toBe(0)
    expect(Number.isFinite(snapshot.stats.averageWpm)).toBe(true)
  })

  it('does not lose entries when appends overlap', async () => {
    // appendEntry is called WITHOUT await from the stream-stop handler, so
    // concurrent read-modify-write is a real scenario. Without serialization
    // the later write clobbers the earlier one and a row silently vanishes.
    await Promise.all([
      appendEntry(input('first entry')),
      appendEntry(input('second entry')),
      appendEntry(input('third entry')),
    ])
    await flushHistoryWrites()

    const snapshot = await readHistory()
    expect(snapshot.entries).toHaveLength(3)
    expect(snapshot.stats.lifetimeSessions).toBe(3)
    expect(snapshot.stats.lifetimeWords).toBe(6)
  })

  it('degrades to an empty store when the file is corrupt rather than throwing', async () => {
    await mkdir(join(scratch, 'dictation'), { recursive: true })
    await writeFile(HISTORY_FILE, '{ this is not json')

    // A broken history file must never be able to break dictation itself.
    const snapshot = await readHistory()
    expect(snapshot.entries).toEqual([])
    expect(snapshot.stats.lifetimeWords).toBe(0)
  })

  it('never stores audio bytes, only counts', async () => {
    await appendEntry(input('privacy check'))
    const raw = await readFile(HISTORY_FILE, 'utf8')
    const parsed = JSON.parse(raw) as { entries: Array<Record<string, unknown>> }

    const entry = parsed.entries[0]!
    expect(entry.audioBytes).toBe(1000)
    expect(entry).not.toHaveProperty('audio')
    expect(entry).not.toHaveProperty('chunks')
  })
})
