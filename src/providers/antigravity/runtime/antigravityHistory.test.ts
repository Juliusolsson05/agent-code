import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AntigravityRow } from 'antigravity-acp-headless'

import {
  antigravityTranscriptLocator,
  liveAntigravityRows,
  loadAntigravityHistoryChunk,
  parseAntigravityTranscriptLocator,
  registerAntigravityHistory,
} from './antigravityHistory.js'

// Antigravity history pages from the LIVE registry, and the locator grammar.
//
// Paging contract (the renderer's history loader relies on all of it):
//   - pages are served newest first, `limit` rows at a time, in conversation
//     order within a page;
//   - `beforeMarker` is the mapper's history marker (= the row key) and means
//     "strictly older than that row";
//   - `oldestMarker` is present exactly when there is more to load, and is the
//     key of the page's first row;
//   - `totalEntries` is reported on the first (marker-less) page only.
//
// Every test here keeps the conversation registered: an unregistered id
// falls back to spawning `agy acp` for a replay, which these unit tests must
// never do (the replay path has its own system test with a fake agy).

const unregister: Array<() => void> = []
afterEach(() => {
  for (const drop of unregister.splice(0)) drop()
})

function rowsFor(sessionId: string, count: number): AntigravityRow[] {
  return Array.from({ length: count }, (_, ordinal) => ({
    type: 'antigravity-row' as const,
    sessionId,
    key: `ag:${sessionId}:${ordinal}`,
    ordinal,
    role: ordinal % 2 === 0 ? 'user' as const : 'assistant' as const,
    text: `message ${ordinal}`,
    timestamp: 1_700_000_000_000 + ordinal,
  }))
}

function live(sessionId: string, rows: AntigravityRow[]) {
  unregister.push(registerAntigravityHistory(sessionId, { rows: () => rows }))
  return rows
}

const noSpawn = { spawn: () => { throw new Error('test must not spawn agy') } }
const page = (providerSessionId: string, limit: number, beforeMarker?: string) =>
  loadAntigravityHistoryChunk({ cwd: '/work', providerSessionId, limit, ...(beforeMarker ? { beforeMarker } : {}) }, noSpawn)
const keys = (entries: Record<string, unknown>[]) => entries.map(entry => entry.key)

describe('loadAntigravityHistoryChunk over the live registry', () => {
  it('the first page is the newest `limit` rows with the total and the marker of its oldest row', async () => {
    const rows = live('sess-a', rowsFor('sess-a', 5))
    const chunk = await page('sess-a', 2)
    expect(keys(chunk.entries)).toEqual([rows[3]!.key, rows[4]!.key])
    expect(chunk).toMatchObject({ hasMore: true, totalEntries: 5, oldestMarker: rows[3]!.key })
  })

  it('beforeMarker serves rows strictly older than the marker, without a total', async () => {
    const rows = live('sess-b', rowsFor('sess-b', 5))
    const chunk = await page('sess-b', 2, rows[3]!.key)
    expect(keys(chunk.entries)).toEqual([rows[1]!.key, rows[2]!.key])
    expect(chunk.hasMore).toBe(true)
    expect(chunk.oldestMarker).toBe(rows[1]!.key)
    expect('totalEntries' in chunk).toBe(false)
  })

  it('the last page has no oldestMarker and says there is nothing more', async () => {
    const rows = live('sess-c', rowsFor('sess-c', 5))
    const chunk = await page('sess-c', 2, rows[1]!.key)
    expect(keys(chunk.entries)).toEqual([rows[0]!.key])
    expect(chunk.hasMore).toBe(false)
    expect('oldestMarker' in chunk).toBe(false)
  })

  it('walking oldestMarker from the first page returns every row exactly once, in order', async () => {
    const rows = live('sess-d', rowsFor('sess-d', 7))
    const seen: unknown[] = []
    let chunk = await page('sess-d', 3)
    seen.unshift(...keys(chunk.entries))
    while (chunk.hasMore) {
      chunk = await page('sess-d', 3, chunk.oldestMarker)
      seen.unshift(...keys(chunk.entries))
    }
    expect(seen).toEqual(rows.map(row => row.key))
  })

  it('a limit beyond the conversation serves it whole with no more to load', async () => {
    const rows = live('sess-e', rowsFor('sess-e', 3))
    const chunk = await page('sess-e', 50)
    expect(keys(chunk.entries)).toEqual(rows.map(row => row.key))
    expect(chunk).toMatchObject({ hasMore: false, totalEntries: 3 })
    expect('oldestMarker' in chunk).toBe(false)
  })

  it('a marker the conversation does not hold serves nothing rather than a duplicate page', async () => {
    // E.g. a marker from before a history reset: re-serving the newest page
    // under it would show those rows twice.
    live('sess-f', rowsFor('sess-f', 4))
    const chunk = await page('sess-f', 2, 'ag:other:9')
    expect(chunk.entries).toEqual([])
    expect(chunk.hasMore).toBe(false)
  })

  it('entries are copies: the renderer side cannot mutate the live session rows', async () => {
    const rows = live('sess-g', rowsFor('sess-g', 2))
    const chunk = await page('sess-g', 2)
    chunk.entries[0]!.text = 'tampered'
    expect(rows[0]!.text).toBe('message 0')
    expect(chunk.entries[1]).toEqual(rows[1])
  })

  it('reads the source lazily, so rows committed after registration are served', async () => {
    const rows = live('sess-h', rowsFor('sess-h', 1))
    rows.push(rowsFor('sess-h', 2)[1]!)
    expect(keys((await page('sess-h', 10)).entries)).toEqual(['ag:sess-h:0', 'ag:sess-h:1'])
  })

  it('a conversation that is not live falls back to a replay, and a failed replay is an `unreadable` error', async () => {
    const spawn = vi.fn(() => {
      throw new Error('spawn agy ENOENT')
    })
    const attempt = loadAntigravityHistoryChunk({ cwd: '/work', providerSessionId: 'not-live', limit: 10 }, { spawn })
    await expect(attempt).rejects.toMatchObject({ code: 'unreadable' })
    await expect(attempt).rejects.toThrow(/^unreadable: Antigravity history unavailable: spawn agy ENOENT$/)
    expect(spawn).toHaveBeenCalledWith('agy', ['acp'], { cwd: '/work' })
  })
})

describe('registerAntigravityHistory', () => {
  it('unregistering removes the live source', () => {
    const drop = registerAntigravityHistory('sess-r', { rows: () => rowsFor('sess-r', 1) })
    expect(liveAntigravityRows('sess-r')).toHaveLength(1)
    drop()
    expect(liveAntigravityRows('sess-r')).toBeNull()
  })

  it('a stale unregister never removes a newer source for the same conversation', () => {
    // A pane rebinding the same id (or a successor process) registers again
    // before the old session's stop() runs its unregister.
    const dropOld = registerAntigravityHistory('sess-s', { rows: () => rowsFor('sess-s', 1) })
    const newer = rowsFor('sess-s', 3)
    unregister.push(registerAntigravityHistory('sess-s', { rows: () => newer }))
    dropOld()
    expect(liveAntigravityRows('sess-s')).toBe(newer)
  })
})

describe('antigravity transcript locator', () => {
  it('round-trips agy conversation ids', () => {
    for (const id of ['3f0c2a9e-6b1d-4c55-9a43-1d2e7f8b9c10', 'conv_01', 'A-b_9']) {
      const locator = antigravityTranscriptLocator(id)
      expect(locator).toBe(`antigravity://session/${id}`)
      expect(parseAntigravityTranscriptLocator(locator)).toBe(id)
    }
  })

  it('rejects malformed locators instead of extracting a partial or unsafe id', () => {
    for (const locator of [
      '',
      'antigravity://session/',
      'antigravity://session/a/b',
      'antigravity://session/../conversations',
      'antigravity://session/a b',
      'antigravity://session/abc\n',
      'antigravity://session/abc?x=1',
      'antigravity://sessions/abc',
      'hermes://session/abc',
      'ANTIGRAVITY://session/abc',
      '/Users/me/.gemini/antigravity-cli/conversations/abc.db',
      'x-antigravity://session/abc',
    ]) {
      expect(parseAntigravityTranscriptLocator(locator), locator).toBeNull()
    }
  })
})
