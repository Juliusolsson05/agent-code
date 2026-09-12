import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createProjectionDatabase, listDurableFixtures, loadDurableFixture, type DurableFixture } from 'opencode-terminal-headless/testing/index'
import { type ControlContext } from '@control-sdk'
import { opencodeDatabase } from '@providers/opencode/runtime/opencodeDatabase'
import { DatabaseSync } from '@providers/opencode/runtime/opencodeDatabase.testSupport'
import { sessionHistoryControlCapabilities } from './control'

const fixture = vi.hoisted(() => ({ file: '', transcriptFile: '', export: vi.fn(), process: vi.fn() }))
vi.mock('node-pty', () => ({ spawn: vi.fn() }))
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execFile: fixture.process, spawn: fixture.process }
})
vi.mock('@providers/opencode/runtime/opencodeCliSessions', async importOriginal => ({
  ...await importOriginal<typeof import('@providers/opencode/runtime/opencodeCliSessions')>(),
  exportOpencodeSession: fixture.export,
}))
vi.mock('@providers/opencode/runtime/opencodeDatabase', async importOriginal => {
  const actual = await importOriginal<typeof import('@providers/opencode/runtime/opencodeDatabase')>()
  return { ...actual, opencodeDatabase: actual.createOpencodeDatabase({ resolveDbPath: async () => fixture.file }) }
})
vi.mock('@main/providerSwitch/shared', () => ({ resolveProviderTranscriptPath: async () => fixture.transcriptFile || null }))

const context: ControlContext = { requestId: 'test', caller: { kind: 'application', id: 'test' }, owner: { kind: 'main', generation: 'test' } }
let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'control-history-'))
  fixture.file = join(dir, 'opencode.db')
  fixture.transcriptFile = ''
  fixture.export.mockReset().mockImplementation(() => { throw new Error('control reads must not export') })
  fixture.process.mockReset().mockImplementation(() => { throw new Error('control reads must not execute a process') })
  // Cursor expiry is clock-owned, not dependent on waiting five real minutes.
  // Clearing this test-owned timer queue also releases capability prune timers.
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
})
afterEach(() => {
  try { opencodeDatabase.release() } finally {
    vi.clearAllTimers()
    vi.useRealTimers()
    rmSync(dir, { recursive: true, force: true })
  }
})
function recorded(fragment = 'ses_47fca639'): DurableFixture {
  return loadDurableFixture(listDurableFixtures().find(name => name.includes(fragment))!)
}
function setup(session = recorded()) {
  createProjectionDatabase(session, fixture.file)
  const capability = sessionHistoryControlCapabilities()[0]
  const request = { provider: 'opencode' as const, cwd: '/fixture', providerSessionId: session.meta.sessionID, maxRecords: 1 }
  const invoke = (cursor?: string) => capability.execute({ ...request, ...(cursor ? { cursor } : {}) }, context)
  return { session, capability, request, invoke }
}
function messageId(entry: Record<string, unknown>): string { return (entry.info as { id: string }).id }
function projectionIds(session: DurableFixture): string[] {
  return [...session.messages].sort((a, b) => a.time_created - b.time_created || a.id.localeCompare(b.id)).map(row => row.id)
}

it('pages recorded history down to its first message with one-record windows and no provider process', async () => {
  const { session, invoke } = setup(recorded('ses_5a9eb743'))
  const expected = projectionIds(session)
  const collected: string[] = []
  let cursor: string | undefined
  let ended = false
  const seenCursors = new Set<string>()
  for (let index = 0; index < expected.length; index++) {
    const result = await invoke(cursor)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.error.message)
    expect(result.value.source).toBe('provider-history')
    expect(result.value.sourceIdentity).toBe(`opencode://session/${session.meta.sessionID}`)
    expect(result.value.entries.map(messageId)).toEqual([expected[expected.length - index - 1]])
    collected.unshift(...result.value.entries.map(messageId))
    const next = result.value.olderCursor
    if (!next) { ended = true; break }
    expect(next).not.toContain('msg_')
    expect(seenCursors.has(next)).toBe(false)
    seenCursors.add(next)
    cursor = next
  }
  expect(ended).toBe(true)
  expect(collected).toEqual(expected)
  expect(fixture.export).not.toHaveBeenCalled()
  expect(fixture.process).not.toHaveBeenCalled()
})

it('reads older windows from the current projection and continues when revert deletes its anchor', async () => {
  const { session, invoke } = setup()
  const ids = projectionIds(session)
  expect(ids.length).toBeGreaterThanOrEqual(3)
  const first = await invoke()
  if (!first.ok) throw new Error(first.error.message)
  expect(first.value.entries.map(messageId)).toEqual([ids.at(-1)])
  const db = new DatabaseSync(fixture.file)
  try {
    db.prepare('DELETE FROM message WHERE id = ?').run(ids.at(-1)!)
    // An immutable export retained in the cursor would miss this later edit.
    // The raw row, not a reader-produced value, supplies the content oracle.
    db.prepare('UPDATE message SET data = ? WHERE id = ?').run(JSON.stringify({ role: 'assistant', time: { created: 1, completed: 2 }, title: 'changed after cursor' }), ids.at(-2)!)
  } finally { db.close() }
  let cursor = first.value.olderCursor!
  for (let i = ids.length - 2; i >= 0; i--) {
    const result = await invoke(cursor)
    if (!result.ok) throw new Error(result.error.message)
    expect(result.value.entries.map(messageId)).toEqual([ids[i]])
    if (i === ids.length - 2) expect(result.value.entries[0].info).toMatchObject({ title: 'changed after cursor' })
    expect(result.value.sourceIdentity).toBe(first.value.sourceIdentity)
    expect(result.value.olderCursor === null).toBe(i === 0)
    cursor = result.value.olderCursor!
  }
  expect(fixture.export).not.toHaveBeenCalled()
})

it.each(['provider', 'cwd', 'providerSessionId', 'expired', 'unknown'] as const)('rejects a %s cursor mismatch before any history read', async field => {
  const { capability, request, invoke } = setup()
  const first = await invoke()
  if (!first.ok) throw new Error(first.error.message)
  const altered = { ...request, cursor: first.value.olderCursor! }
  if (field === 'expired') vi.setSystemTime(Date.now() + 5 * 60_000 + 1)
  if (field === 'unknown') altered.cursor = 'not-a-minted-cursor'
  const result = await capability.execute({ ...altered,
    ...(field === 'provider' ? { provider: 'codex' } : {}),
    ...(field === 'cwd' ? { cwd: '/different' } : {}),
    ...(field === 'providerSessionId' ? { providerSessionId: 'ses_other' } : {}),
  }, context)
  expect(result).toMatchObject({ ok: false, error: { code: 'stale_cursor' } })
})

it.each(['unsupported_schema', 'open_failed'] as const)('reports %s as unavailable, including the typed category', async code => {
  if (code === 'unsupported_schema') {
    const db = new DatabaseSync(fixture.file)
    try { db.exec('CREATE TABLE session (id TEXT)') } finally { db.close() }
  }
  const result = await sessionHistoryControlCapabilities()[0].execute({ provider: 'opencode', cwd: '/fixture', providerSessionId: 'ses_old', maxRecords: 1 }, context)
  expect(result).toMatchObject({ ok: false, error: { code: 'unavailable', message: expect.stringContaining(code) } })
  expect(fixture.export).not.toHaveBeenCalled()
  expect(fixture.process).not.toHaveBeenCalled()
})

it('preserves file-backed paging and cursor source identity', async () => {
  fixture.transcriptFile = join(dir, 'claude.jsonl')
  writeFileSync(fixture.transcriptFile, [{ uuid: 'older' }, { uuid: 'newer' }].map(row => JSON.stringify(row)).join('\n') + '\n')
  const capability = sessionHistoryControlCapabilities()[0]
  const request = { provider: 'claude', cwd: dir, providerSessionId: 'claude-file', maxRecords: 1 }
  const first = await capability.execute(request, context)
  if (!first.ok) throw new Error(first.error.message)
  expect(first.value.entries).toEqual([{ uuid: 'newer' }])
  expect(first.value.source).toBe('provider-file')
  const older = await capability.execute({ ...request, cursor: first.value.olderCursor }, context)
  expect(older).toMatchObject({ ok: true, value: { entries: [{ uuid: 'older' }], olderCursor: null, sourceIdentity: first.value.sourceIdentity } })
})
