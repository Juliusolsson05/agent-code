import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from './opencodeDatabase.testSupport.js'
import { openOpencodeStore, OpencodeStoreError } from 'opencode-terminal-headless'
import {
  createProjectionDatabase,
  listDurableFixtures,
  loadDurableFixture,
  type DurableFixture,
} from 'opencode-terminal-headless/testing/index'

import { createOpencodeDatabase, type OpencodeDatabase } from './opencodeDatabase.js'
import { createOpencodeHistorySource, type OpencodeHistorySource } from './opencodeHistory.js'

// History for parked and reloaded OpenCode panes, read from a real SQLite file
// with OpenCode's own schema, loaded with a sanitised real session. The
// expectations come from that session's projection rows — the same rows
// OpenCode itself would serve — never from the reader.

let dir: string
let databases: OpencodeDatabase[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oc-history-'))
  databases = []
})
afterEach(() => {
  for (const database of databases) database.release()
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
  const database = createOpencodeDatabase({ resolveDbPath: async () => file })
  databases.push(database)
  return createOpencodeHistorySource(database)
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
    for (let pageIndex = 0; more && pageIndex < expected.length; pageIndex += 1) {
      const page = await source.loadHistoryChunk({ cwd: '/any', providerSessionId: session.meta.sessionID, limit: 20, beforeMarker: cursor })
      expect(page.totalEntries).toBeUndefined()
      const ids = page.entries.map(entry => (entry as { info: { id: string } }).info.id)
      expect(ids.length).toBeGreaterThan(0)
      expect(ids[0]).not.toBe(cursor)
      expect(expected.indexOf(ids[0])).toBeLessThan(expected.indexOf(cursor))
      collected.unshift(...ids)
      cursor = ids[0]
      more = page.hasMore
    }
    expect(more).toBe(false)
    expect(collected).toEqual(expected)
  })

  it('serves records exactly as OpenCode\'s projection holds them, for the renderer mapper', async () => {
    const session = fixture('ses_47fca639')
    const source = sourceFor([session])
    const chunk = await source.loadHistoryChunk({ cwd: '/any', providerSessionId: session.meta.sessionID, limit: 1000 })
    for (const entry of chunk.entries) {
      const id = (entry as { info: { id: string } }).info.id
      const row = session.messages.find(message => message.id === id)!
      // Reconstruct the upstream row contract directly. projectionRecord calls
      // production's builder and would bless a shared field-loss regression.
      expect(entry).toEqual({
        info: { ...row.data, id: row.id, sessionID: session.meta.sessionID },
        parts: session.parts.filter(part => part.message_id === id)
          .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
          .map(part => ({ ...part.data, id: part.id, sessionID: session.meta.sessionID, messageID: id })),
      })
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

  it('throws an unavailable error and can recover on a later request', async () => {
    const session = fixture('ses_47fca639')
    const file = join(dir, 'opencode.db')
    const database = createOpencodeDatabase({ resolveDbPath: async () => file })
    databases.push(database)
    const source = createOpencodeHistorySource(database)
    const request = { cwd: '/any', providerSessionId: session.meta.sessionID, limit: 5 }
    await expect(source.loadHistoryChunk(request)).rejects.toMatchObject({ code: 'open_failed' })
    createProjectionDatabase(session, file)
    expect((await source.loadHistoryChunk(request)).entries).toHaveLength(Math.min(5, session.messages.length))
  })

  it('refuses a database without the supported event schema', async () => {
    const file = join(dir, 'old.db')
    const writer = new DatabaseSync(file)
    try { writer.exec('CREATE TABLE session (id TEXT PRIMARY KEY)') } finally { writer.close() }
    const database = createOpencodeDatabase({ resolveDbPath: async () => file })
    databases.push(database)
    await expect(createOpencodeHistorySource(database).loadHistoryChunk({ cwd: '/any', providerSessionId: 'ses_old', limit: 5 }))
      .rejects.toMatchObject({ code: 'unsupported_schema' })
  })

  it('retries first-open BUSY within the request and serves the recorded history', async () => {
    const session = fixture('ses_47fca639')
    const file = join(dir, 'opencode.db')
    createProjectionDatabase(session, file)
    let attempts = 0
    const database = createOpencodeDatabase({ resolveDbPath: async () => file, openStore: path => {
      if (++attempts === 1) throw new OpencodeStoreError('busy', 'fixture writer holds lock')
      return openOpencodeStore(path)
    } })
    databases.push(database)
    const page = await createOpencodeHistorySource(database).loadHistoryChunk({ cwd: '/any', providerSessionId: session.meta.sessionID, limit: 5 })
    expect(page.entries.map(entry => (entry.info as { id: string }).id)).toEqual(projectionOrder(session).slice(-5))
    expect(attempts).toBe(2)
  })

  it('reserves empty success for a readable empty or missing session', async () => {
    const session = fixture('ses_47fca639')
    session.messages = []; session.parts = []; session.events = []; session.sequence = null
    const source = sourceFor([session])
    for (const providerSessionId of [session.meta.sessionID, 'ses_missing']) {
      await expect(source.loadHistoryChunk({ cwd: '/any', providerSessionId, limit: 5 }))
        .resolves.toEqual({ entries: [], hasMore: false, totalEntries: 0 })
    }
  })
})
