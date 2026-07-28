import { chmod, mkdtemp, readdir, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
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
  // Delete rather than resetTotals(): several tests deliberately leave a
  // corrupt / wrong-version / unreadable file behind, and resetTotals() now
  // (correctly) refuses to read those instead of clobbering them.
  await chmod(HISTORY_FILE, 0o600).catch(() => {})
  await rm(HISTORY_FILE, { force: true })
  for (const name of await readdir(join(scratch, 'dictation')).catch(() => [])) {
    await rm(join(scratch, 'dictation', name), { force: true })
  }
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

    const snapshot = await readHistory()
    expect(snapshot.entries).toHaveLength(3)
    expect(snapshot.stats.lifetimeSessions).toBe(3)
    expect(snapshot.stats.lifetimeWords).toBe(6)
  })

  it('flushHistoryWrites awaits an append that was never awaited', async () => {
    // The real shape of the hot path: fire-and-forget, then drain. A previous
    // version of this file called flushHistoryWrites only AFTER awaiting the
    // appends, so gutting the function to `return Promise.resolve()` left every
    // test green — it pinned nothing.
    void appendEntry(input('unawaited row'))

    await flushHistoryWrites()

    // Read the FILE, not readHistory(): readHistory joins the same chain, so it
    // would queue behind the pending append and pass even if flushHistoryWrites
    // were gutted to `Promise.resolve()`. Only touching the disk directly
    // proves the flush actually waited for the write to land.
    const onDisk = JSON.parse(await readFile(HISTORY_FILE, 'utf8')) as {
      entries: Array<{ text: string }>
    }
    expect(onDisk.entries).toHaveLength(1)
    expect(onDisk.entries[0]?.text).toBe('unawaited row')
  })

  it('keeps lifetime totals when entries are evicted past the cap', async () => {
    // The single invariant the whole stored-totals design exists to protect:
    // the retained list is a ring buffer, the totals are not. Nothing else in
    // this suite writes past MAX_ENTRIES, so without this a regression that
    // recomputed totals from `entries` — or truncated the wrong end of a
    // newest-first list — would pass everything.
    for (let i = 0; i < 205; i++) {
      await appendEntry(input(`entry number ${i}`))
    }

    const snapshot = await readHistory()
    expect(snapshot.entries).toHaveLength(200)
    expect(snapshot.stats.retainedEntries).toBe(200)
    // Every row was 3 words, and all 205 sessions still count.
    expect(snapshot.stats.lifetimeSessions).toBe(205)
    expect(snapshot.stats.lifetimeWords).toBe(205 * 3)
    // Newest kept, oldest dropped.
    expect(snapshot.entries[0]?.text).toBe('entry number 204')
    expect(snapshot.entries.at(-1)?.text).toBe('entry number 5')
  })

  it('quarantines an unparseable store instead of silently overwriting it', async () => {
    await mkdir(join(scratch, 'dictation'), { recursive: true })
    await writeFile(HISTORY_FILE, '{ this is not json')

    // A broken history file must not break dictation, but the bytes are moved
    // aside rather than destroyed.
    const snapshot = await readHistory()
    expect(snapshot.entries).toEqual([])
    expect(snapshot.stats.lifetimeWords).toBe(0)

    const quarantined = (await readdir(join(scratch, 'dictation'))).filter(name =>
      name.includes('.corrupt-'),
    )
    expect(quarantined).toHaveLength(1)
  })

  it('refuses to read — and therefore to overwrite — a store it cannot parse a version for', async () => {
    // A v2 file written by a newer build, then opened after a rollback. The old
    // build must not treat it as "empty" and clobber it on the next dictation.
    await mkdir(join(scratch, 'dictation'), { recursive: true })
    await writeFile(HISTORY_FILE, JSON.stringify({ v: 2, totals: {}, entries: [] }))

    await expect(readHistory()).rejects.toThrow(/version/i)
    await expect(appendEntry(input('should not land'))).rejects.toThrow(/version/i)

    // Still the newer file, untouched.
    const raw = JSON.parse(await readFile(HISTORY_FILE, 'utf8')) as { v: number }
    expect(raw.v).toBe(2)
  })

  it('refuses to overwrite a store that exists but cannot be read', async () => {
    // The data-destroying scenario: a transient read failure (EACCES, EMFILE,
    // EIO) must never be mistaken for "no history yet", because the very next
    // append would write an empty store over a healthy one and the atomic
    // rename would make that permanent.
    await appendEntry(input('one two three four five'))
    const before = await readFile(HISTORY_FILE, 'utf8')

    await chmod(HISTORY_FILE, 0o000)
    try {
      await expect(appendEntry(input('must not clobber'))).rejects.toThrow()
    } finally {
      await chmod(HISTORY_FILE, 0o600)
    }

    expect(await readFile(HISTORY_FILE, 'utf8')).toBe(before)
    const snapshot = await readHistory()
    expect(snapshot.stats.lifetimeWords).toBe(5)
    expect(snapshot.entries).toHaveLength(1)
  })

  it('never writes audio payloads, only counts', async () => {
    await appendEntry(input('privacy check'))
    const raw = await readFile(HISTORY_FILE, 'utf8')
    const parsed = JSON.parse(raw) as { entries: Array<Record<string, unknown>> }

    // Assert on the WHOLE key set rather than the absence of two names the
    // code never used — that version passed trivially and would not have
    // caught audio stored under any other key.
    expect(Object.keys(parsed.entries[0]!).sort()).toEqual([
      'audioBytes',
      'audioDurationMs',
      'chunkCount',
      'id',
      'provider',
      'sttMs',
      'text',
      'ts',
      'words',
    ])
    // And no value in the file is large enough to be audio.
    expect(raw.length).toBeLessThan(2000)
  })
})
