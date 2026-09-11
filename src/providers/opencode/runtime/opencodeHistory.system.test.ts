import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createProjectionDatabase,
  listDurableFixtures,
  loadDurableFixture,
  projectionRecord,
  type DurableFixture,
} from 'opencode-terminal-headless/testing/index'

import { createOpencodeHistorySource, type OpencodeHistorySource } from './opencodeHistory.js'

// History for parked and reloaded OpenCode panes, read from a real SQLite file
// with OpenCode's own schema, loaded with a sanitised real session. The
// expectations come from that session's projection rows — the same rows
// OpenCode itself would serve — never from the reader.

let dir: string
let sources: OpencodeHistorySource[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oc-history-'))
  sources = []
})
afterEach(() => {
  for (const source of sources) source.release()
  rmSync(dir, { recursive: true, force: true })
})

function fixture(fragment: string): DurableFixture {
  const name = listDurableFixtures().find(candidate => candidate.includes(fragment))
  if (!name) throw new Error(`missing fixture ${fragment}`)
  return loadDurableFixture(name)
}

function sourceFor(fixtures: DurableFixture[]): OpencodeHistorySource {
  const file = join(dir, 'opencode.db')
  createProjectionDatabase(fixtures, file)
  const source = createOpencodeHistorySource({ resolveDbPath: async () => file })
  sources.push(source)
  return source
}

function projectionOrder(f: DurableFixture): string[] {
  return [...f.messages]
    .sort((a, b) => a.time_created - b.time_created || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(row => row.id)
}

describe('OpenCode history from the durable store', () => {
  it('returns the newest window with the durable total, then pages back to the first message', async () => {
    // The compaction session: its log starts mid-history, so this also proves
    // imported messages (never in the event log) are still served as history.
    const session = fixture('ses_5a9eb743')
    const source = sourceFor([session])
    const expected = projectionOrder(session)

    const first = await source.loadHistoryChunk({ cwd: '/any', providerSessionId: session.meta.sessionID, limit: 20 })
    expect(first.totalEntries).toBe(session.messages.length)
    expect(first.hasMore).toBe(expected.length > 20)
    expect(first.entries.map(entry => (entry as { info: { id: string } }).info.id)).toEqual(expected.slice(-20))

    const collected = first.entries.map(entry => (entry as { info: { id: string } }).info.id)
    let cursor = collected[0]
    let more = first.hasMore
    while (more) {
      const page = await source.loadHistoryChunk({ cwd: '/any', providerSessionId: session.meta.sessionID, limit: 20, beforeMarker: cursor })
      expect(page.totalEntries).toBeUndefined()
      const ids = page.entries.map(entry => (entry as { info: { id: string } }).info.id)
      collected.unshift(...ids)
      cursor = ids[0]
      more = page.hasMore
    }
    expect(collected).toEqual(expected)
  })

  it('serves records exactly as OpenCode\'s projection holds them, for the renderer mapper', async () => {
    const session = fixture('ses_47fca639')
    const source = sourceFor([session])
    const chunk = await source.loadHistoryChunk({ cwd: '/any', providerSessionId: session.meta.sessionID, limit: 1000 })
    for (const entry of chunk.entries) {
      const id = (entry as { info: { id: string } }).info.id
      expect(entry).toEqual(projectionRecord(session, id))
    }
  })

  it('keeps sessions apart in a database shared by a parent and its task child', async () => {
    const parent = fixture('ses_f96bdb53')
    const child = fixture('ses_f963831c')
    const source = sourceFor([parent, child])
    const chunk = await source.loadHistoryChunk({ cwd: '/any', providerSessionId: parent.meta.sessionID, limit: 1000 })
    expect(chunk.entries.every(entry => (entry as { info: { sessionID: string } }).info.sessionID === parent.meta.sessionID)).toBe(true)
    expect(chunk.totalEntries).toBe(parent.messages.length)
  })

  it('answers empty (not an error) without a database, and retries on the next request', async () => {
    const session = fixture('ses_47fca639')
    const file = join(dir, 'opencode.db')
    createProjectionDatabase(session, file)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let attempts = 0
    const source = createOpencodeHistorySource({
      resolveDbPath: async () => {
        attempts += 1
        if (attempts === 1) throw new Error('opencode is not installed')
        return file
      },
    })
    sources.push(source)
    await expect(source.loadHistoryChunk({ cwd: '/any', providerSessionId: session.meta.sessionID, limit: 5 })).resolves.toEqual({ entries: [], hasMore: false, totalEntries: 0 })
    const second = await source.loadHistoryChunk({ cwd: '/any', providerSessionId: session.meta.sessionID, limit: 5 })
    expect(second.entries.length).toBeGreaterThan(0)
    expect(attempts).toBe(2)
    warn.mockRestore()
  })
})
