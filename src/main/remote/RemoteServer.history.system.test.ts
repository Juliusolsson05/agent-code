import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from '@providers/opencode/runtime/opencodeDatabase.testSupport.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createProjectionDatabase, listDurableFixtures, loadDurableFixture } from 'opencode-terminal-headless/testing/index'
import { opencodeDatabase } from '@providers/opencode/runtime/opencodeDatabase.js'
import { REMOTE_HISTORY_MAX_BYTES, REMOTE_HISTORY_TOO_LARGE } from '@shared/remoteOutputLimits.js'
import { dir, manager, openAuthed, waitFor, framesOfType } from './RemoteServer.testSupport.js'

// OpenCode history is read from a real database built from a recorded
// session instead of the user's own (and without running `opencode db path`).
const opencodeFixture = vi.hoisted(() => ({ file: '' }))
vi.mock('@providers/opencode/runtime/opencodeDatabase.js', async importOriginal => {
  const actual = await importOriginal<typeof import('@providers/opencode/runtime/opencodeDatabase.js')>()
  return {
    ...actual,
    opencodeDatabase: actual.createOpencodeDatabase({ resolveDbPath: async () => opencodeFixture.file }),
  }
})


const providerFixture = vi.hoisted(() => ({ enabled: false, load: vi.fn() }))
vi.mock('@providers/registry.main.js', async importOriginal => {
  const actual = await importOriginal<typeof import('@providers/registry.main.js')>()
  return { ...actual, getMainProvider: (kind: string) => kind === 'codex' && providerFixture.enabled ? {
    ...actual.getMainProvider(kind),
    transcriptLocator: (id: string) => `fixture-db:${id}`,
    parseTranscriptLocator: (locator: string) => locator.startsWith('fixture-db:') ? locator.slice(11) : null,
    loadHistoryChunk: providerFixture.load,
  } : actual.getMainProvider(kind) }
})

afterEach(() => {
  opencodeDatabase.release()
  providerFixture.enabled = false
  providerFixture.load.mockReset()
  vi.restoreAllMocks()
})

describe('remote history backfill', () => {
  it('get-history serves the newest chunk from the cached transcript file', async () => {
    // Write a real jsonl transcript and point the manager's file cache at
    // it — the exact shape RemoteServer reads for a live session.
    const transcript = join(dir, 'session.jsonl')
    const lines = Array.from({ length: 5 }, (_, i) =>
      JSON.stringify({
        type: 'user',
        uuid: `u-${i}`,
        message: { role: 'user', content: `prompt ${i}` },
      }),
    )
    await writeFile(transcript, lines.join('\n') + '\n', 'utf8')
    ;(manager.resolveTranscriptFile as ReturnType<typeof vi.fn>).mockResolvedValue(transcript)

    const { ws, frames, token } = await openAuthed()
    ws.send(JSON.stringify({
      token, id: 'h1',
      message: { type: 'get-history', sessionId: 's1', limit: 3 },
    }))
    await waitFor(frames, f => framesOfType(f, 'reply').length > 0)
    const reply = framesOfType(frames, 'reply')[0] as {
      ok: boolean
      result: { entries: Array<{ uuid: string }>; hasMore: boolean; totalEntries: number }
    }
    expect(reply.ok).toBe(true)
    // Newest `limit` records, in file order.
    expect(reply.result.entries.map(e => e.uuid)).toEqual(['u-2', 'u-3', 'u-4'])
    expect(reply.result.hasMore).toBe(true)
    expect(reply.result.totalEntries).toBe(5)

    // Older page anchored on the first entry of the previous chunk.
    ws.send(JSON.stringify({
      token, id: 'h2',
      message: { type: 'get-history', sessionId: 's1', beforeMarker: 'u-2', limit: 3 },
    }))
    await waitFor(frames, f => framesOfType(f, 'reply').length >= 2)
    const older = framesOfType(frames, 'reply')[1] as {
      ok: boolean
      result: { entries: Array<{ uuid: string }>; hasMore: boolean }
    }
    expect(older.ok).toBe(true)
    expect(older.result.entries.map(e => e.uuid)).toEqual(['u-0', 'u-1'])
    expect(older.result.hasMore).toBe(false)
    ws.close()
  })

  it('get-history carries physical cursors through duplicate markers without skipping records', async () => {
    const transcript = join(dir, 'duplicate-cursors.jsonl')
    const lines = Array.from({ length: 5 }, (_, index) => JSON.stringify({
      type: 'user', uuid: 'same', message: { role: 'user', content: `prompt ${index}` },
    }))
    await writeFile(transcript, lines.join('\n') + '\n', 'utf8')
    ;(manager.resolveTranscriptFile as ReturnType<typeof vi.fn>).mockResolvedValue(transcript)
    const { ws, frames, token } = await openAuthed()
    let beforeOffset: number | undefined
    const contents: string[] = []
    // Bound the fixture loop so a cursor regression fails instead of hanging
    // CI. Marker-only fallback would skip most of these identical UUIDs.
    for (let page = 0; page < 3; page += 1) {
      ws.send(JSON.stringify({ token, id: `cursor-${page}`, message: {
        type: 'get-history', sessionId: 's1', limit: 2,
        ...(beforeOffset === undefined ? {} : { beforeMarker: 'same', beforeOffset }),
      } }))
      await waitFor(frames, f => framesOfType(f, 'reply').length > page)
      const reply = framesOfType(frames, 'reply')[page] as {
        ok: boolean
        result: { entries: Array<{ message: { content: string } }>; offsets: number[]; hasMore: boolean }
      }
      expect(reply.ok).toBe(true)
      contents.unshift(...reply.result.entries.map(entry => entry.message.content))
      expect(reply.result.offsets).toHaveLength(reply.result.entries.length)
      const next = reply.result.offsets[0]!
      if (beforeOffset !== undefined) expect(next).toBeLessThan(beforeOffset)
      beforeOffset = next
      expect(reply.result.hasMore).toBe(page < 2)
    }
    expect(contents).toEqual(['prompt 0', 'prompt 1', 'prompt 2', 'prompt 3', 'prompt 4'])
    ws.close()
  })

  it('get-history pages an OpenCode session from its database by the locator the session publishes', async () => {
    // The compaction session: long enough for several pages, and it starts
    // with imported messages the event log never saw.
    const recorded = loadDurableFixture(listDurableFixtures().find(name => name.includes('ses_5a9eb743'))!)
    opencodeFixture.file = join(dir, 'opencode.db')
    createProjectionDatabase(recorded, opencodeFixture.file)
    const locator = `opencode://session/${recorded.meta.sessionID}`
    ;(manager.getSessionKind as ReturnType<typeof vi.fn>).mockReturnValue('opencode')
    ;(manager.resolveTranscriptFile as ReturnType<typeof vi.fn>).mockResolvedValue(locator)
    const projectionOrder = [...recorded.messages]
      .sort((a, b) => a.time_created - b.time_created || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map(row => row.id)

    try {
      const { ws, frames, token } = await openAuthed()
      const collected: string[] = []
      let beforeMarker: string | undefined
      for (let page = 0; page < 10; page += 1) {
        ws.send(JSON.stringify({ token, id: `oc-${page}`, message: {
          type: 'get-history', sessionId: 's1', limit: 50,
          ...(beforeMarker ? { beforeMarker } : {}),
        } }))
        await waitFor(frames, f => framesOfType(f, 'reply').length > page)
        const reply = framesOfType(frames, 'reply')[page] as {
          ok: boolean
          result: { entries: Array<{ info: { id: string } }>; hasMore: boolean; totalEntries?: number; file: string }
        }
        expect(reply.ok).toBe(true)
        expect(reply.result.file).toBe(locator)
        if (page === 0) expect(reply.result.totalEntries).toBe(recorded.messages.length)
        const ids = reply.result.entries.map(entry => entry.info.id)
        collected.unshift(...ids)
        if (!reply.result.hasMore) break
        beforeMarker = ids[0]
      }
      // Every message exactly once, oldest first, as OpenCode's projection
      // orders them.
      expect(collected).toEqual(projectionOrder)
      ws.close()
    } finally {
      opencodeDatabase.release()
    }
  })

  it('get-history fails cleanly before any transcript exists', async () => {
    const { ws, frames, token } = await openAuthed()
    ws.send(JSON.stringify({
      token, id: 'h1',
      message: { type: 'get-history', sessionId: 's1' },
    }))
    await waitFor(frames, f => framesOfType(f, 'reply').length > 0)
    expect(framesOfType(frames, 'reply')[0]).toMatchObject({
      ok: false, error: expect.stringContaining('no transcript'),
    })
    ws.close()
  })


  it('delegates a fake database provider by registry capability and its own locator grammar', async () => {
    providerFixture.enabled = true
    providerFixture.load.mockResolvedValue({ entries: [{ id: 'recorded-row' }], hasMore: false })
    const { providerSessionLocator } = await import('@main/agentTranscripts/transcriptLocator.js')
    const locator = providerSessionLocator('codex', 'native-history')
    expect(locator).toBe('fixture-db:native-history')
    vi.mocked(manager.getSessionKind).mockReturnValue('codex')
    vi.mocked(manager.resolveTranscriptFile).mockResolvedValue(locator)
    vi.mocked(manager.getSpawnCwd).mockReturnValue('/fixture')
    const { ws, frames, token } = await openAuthed()
    ws.send(JSON.stringify({ token, id: 'fake', message: { type: 'get-history', sessionId: 's1', beforeMarker: 'older-id', limit: 2 } }))
    await waitFor(frames, f => framesOfType(f, 'reply').length > 0)
    expect(providerFixture.load).toHaveBeenCalledExactlyOnceWith({ cwd: '/fixture', providerSessionId: 'native-history', beforeMarker: 'older-id', limit: 2 })
    expect(framesOfType(frames, 'reply')[0]).toMatchObject({ ok: true, result: { entries: [{ id: 'recorded-row' }], file: locator } })
  })

  it.each(['absent', 'unsupported', 'read-failure'] as const)('returns an error reply for an %s database', async failure => {
    opencodeFixture.file = join(dir, 'unavailable.db')
    if (failure === 'unsupported') {
      const db = new DatabaseSync(opencodeFixture.file)
      try { db.exec('CREATE TABLE session (id TEXT)') } finally { db.close() }
    }
    if (failure === 'read-failure') {
      createProjectionDatabase(loadDurableFixture(listDurableFixtures()[0]!), opencodeFixture.file)
      vi.spyOn(await opencodeDatabase.store(), 'readHistory').mockImplementation(() => { throw new Error('fixture read refused') })
    }
    vi.mocked(manager.getSessionKind).mockReturnValue('opencode')
    vi.mocked(manager.resolveTranscriptFile).mockResolvedValue('opencode://session/ses_any')
    const { ws, frames, token } = await openAuthed()
    ws.send(JSON.stringify({ token, id: 'unavailable', message: { type: 'get-history', sessionId: 's1' } }))
    await waitFor(frames, f => framesOfType(f, 'reply').length > 0)
    expect(framesOfType(frames, 'reply')[0]).toMatchObject({ ok: false, error: 'internal error applying message' })
    expect(framesOfType(frames, 'reply')[0]).not.toHaveProperty('result')
  })

  it.each(['deleted-anchor', 'oversized-newest', 'bounded-suffix'] as const)('handles %s from the real provider history source', async scenario => {
    const recorded = loadDurableFixture(listDurableFixtures().find(name => name.includes('ses_47fca639'))!)
    // The database uses raw hand-authored rows for byte budgets. Their expected
    // sizes/order do not depend on the package's record builder or pager.
    recorded.messages = [0, 1, 2].map(i => ({ id: `msg_${i}`, session_id: recorded.meta.sessionID, time_created: i, time_updated: i,
      data: { role: 'assistant', time: { created: i, completed: i + 1 } } }))
    recorded.parts = recorded.messages.map((message, i) => ({ id: `prt_${i}`, message_id: message.id, session_id: recorded.meta.sessionID, time_created: i, time_updated: i,
      data: { type: 'text', text: 'x'.repeat(scenario === 'oversized-newest' ? REMOTE_HISTORY_MAX_BYTES + 1 : Math.floor(REMOTE_HISTORY_MAX_BYTES / 2)) } }))
    recorded.events = []; recorded.sequence = null
    opencodeFixture.file = join(dir, 'budget.db')
    createProjectionDatabase(recorded, opencodeFixture.file)
    vi.mocked(manager.getSessionKind).mockReturnValue('opencode')
    vi.mocked(manager.resolveTranscriptFile).mockResolvedValue(`opencode://session/${recorded.meta.sessionID}`)
    const { ws, frames, token } = await openAuthed()
    const request = (id: string, beforeMarker?: string) => ws.send(JSON.stringify({ token, id, message: {
      type: 'get-history', sessionId: 's1', limit: 3, ...(beforeMarker ? { beforeMarker } : {}),
    } }))
    if (scenario === 'deleted-anchor') {
      // Obtain a real cursor, then delete it before asking for its older page.
      request('first')
      await waitFor(frames, f => framesOfType(f, 'reply').length === 1)
      const db = new DatabaseSync(opencodeFixture.file)
      try { db.exec("DELETE FROM message WHERE id = 'msg_2'") } finally { db.close() }
      request('deleted', 'msg_2')
      await waitFor(frames, f => framesOfType(f, 'reply').length === 2)
      // Revert removed the cursor's row, not all older history. The provider
      // resumes below its native id, and the byte budget keeps one row per page.
      expect(framesOfType(frames, 'reply')[1]).toMatchObject({ ok: true, result: { entries: [{ info: { id: 'msg_1' } }], hasMore: true } })
      request('oldest', 'msg_1')
      await waitFor(frames, f => framesOfType(f, 'reply').length === 3)
      expect(framesOfType(frames, 'reply')[2]).toMatchObject({ ok: true, result: { entries: [{ info: { id: 'msg_0' } }], hasMore: false } })
    } else if (scenario === 'oversized-newest') {
      request('oversize')
      await waitFor(frames, f => framesOfType(f, 'reply').length === 1)
      expect(framesOfType(frames, 'reply')[0]).toMatchObject({ ok: false, error: REMOTE_HISTORY_TOO_LARGE })
    } else {
      for (let page = 0; page < 3; page++) {
        request(`page-${page}`, page ? `msg_${3 - page}` : undefined)
        await waitFor(frames, f => framesOfType(f, 'reply').length > page)
        expect(framesOfType(frames, 'reply')[page]).toMatchObject({ ok: true, result: {
          entries: [{ info: { id: `msg_${2 - page}` } }], hasMore: page < 2,
        } })
      }
    }
  })
})
