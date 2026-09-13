import { mkdtemp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { closeSync, constants, openSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { decodeGrokConversation, projectGrokNativeResume } from 'agent-transcript-parser'
import { listGrokSessions, resolveGrokTranscriptPath } from 'grok-code-headless'
import { readGrokTranscript, writeProjectedGrokSession } from './grokTranscript.js'

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, writeFile: vi.fn(actual.writeFile), rename: vi.fn(actual.rename) }
})

const id = '00000000-0000-4000-8000-000000000001'
const recorded = await readFile(new URL('../../../packages/grok-code-headless/testing/fixtures/recorded/session-014.jsonl', import.meta.url), 'utf8')
const conversation = decodeGrokConversation(recorded.trimEnd().split('\n').map(line => JSON.parse(line)))
let root: string
let cwd: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'grok-host-files-'))
  cwd = join(root, 'project (fixture)')
  await mkdir(cwd)
  vi.stubEnv('GROK_HOME', join(root, 'home'))
})
afterEach(async () => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})
const project = () => projectGrokNativeResume(conversation, {
  cwd, targetSessionId: id, now: '2026-09-08T00:00:00.000Z', model: 'fixture-model',
})

describe('Grok host transcript file-set integration', () => {
  it('publishes real parser output as a discoverable native file set with no fake identity rows', async () => {
    const projection = project()
    const before = structuredClone(projection)
    const path = await writeProjectedGrokSession(cwd, projection)
    expect(path).toBe(resolveGrokTranscriptPath(cwd, id))
    expect(await readdir(dirname(path))).toEqual(['chat_history.jsonl', 'summary.json', 'updates.jsonl'])
    expect(JSON.parse(await readFile(join(dirname(path), 'summary.json'), 'utf8'))).toMatchObject({
      info: { id }, num_chat_messages: projection.values.length, num_messages: 0,
    })
    expect(await readFile(join(dirname(path), 'updates.jsonl'), 'utf8')).toBe('')
    expect((await readFile(path, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line))).toEqual(projection.values)
    expect(listGrokSessions({ cwd })).toHaveLength(1)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect((await stat(dirname(path))).mode & 0o777).toBe(0o700)
    expect(await readGrokTranscript(cwd, id)).toMatchObject({ sourceProvider: 'grok', sourceSessionIds: [id] })
    expect(projection).toEqual(before)
  })

  it('gives concurrent publishers exactly one owner and never clobbers an existing session', async () => {
    const projection = project()
    const results = await Promise.allSettled([writeProjectedGrokSession(cwd, projection), writeProjectedGrokSession(cwd, projection)])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    const path = resolveGrokTranscriptPath(cwd, id)
    const before = await readFile(path, 'utf8')
    await expect(writeProjectedGrokSession(cwd, projection)).rejects.toThrow()
    expect(await readFile(path, 'utf8')).toBe(before)
  })

  it('validates native rows, counts, identity and cwd before creating session storage', async () => {
    const invalidRow = project()
    invalidRow.values[0] = { type: 'assistant', content: 42 }
    await expect(writeProjectedGrokSession(cwd, invalidRow)).rejects.toThrow()
    const invalidCounts = project()
    invalidCounts.summary.num_chat_messages++
    await expect(writeProjectedGrokSession(cwd, invalidCounts)).rejects.toThrow('counter')
    const invalidId = project()
    invalidId.summary.info.id = '../../outside'
    await expect(writeProjectedGrokSession(cwd, invalidId)).rejects.toThrow()
    const invalidCwd = project()
    invalidCwd.summary.info.cwd = root
    await expect(writeProjectedGrokSession(cwd, invalidCwd)).rejects.toThrow('cwd')
    expect(await readdir(root)).toEqual(['project (fixture)'])
  })

  it('removes only its unpublished directory when a file write fails before summary publication', async () => {
    vi.mocked(writeFile).mockRejectedValueOnce(new Error('controlled disk failure'))
    await expect(writeProjectedGrokSession(cwd, project())).rejects.toThrow('controlled disk failure')
    await expect(stat(dirname(resolveGrokTranscriptPath(cwd, id)))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(listGrokSessions({ cwd })).toEqual([])
  })

  it('keeps discovery hidden until summary publication and rolls back a failed summary rename', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    vi.mocked(rename).mockImplementationOnce(actual.rename).mockImplementationOnce(async (_from, to) => {
      expect(String(to)).toBe(join(dirname(resolveGrokTranscriptPath(cwd, id)), 'summary.json'))
      expect(listGrokSessions({ cwd })).toEqual([])
      expect(await readFile(resolveGrokTranscriptPath(cwd, id), 'utf8')).not.toBe('')
      expect(await readFile(join(dirname(String(to)), 'updates.jsonl'), 'utf8')).toBe('')
      throw new Error('controlled summary publication failure')
    })
    await expect(writeProjectedGrokSession(cwd, project())).rejects.toThrow('controlled summary publication failure')
    await expect(stat(dirname(resolveGrokTranscriptPath(cwd, id)))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses partial or corrupt source history rather than silently switching a valid prefix', async () => {
    const path = await writeProjectedGrokSession(cwd, project())
    await writeFile(path, recorded + '{"type":"assistant"')
    await expect(readGrokTranscript(cwd, id)).rejects.toThrow('unterminated')
    await writeFile(path, 'not JSON\n' + recorded)
    await expect(readGrokTranscript(cwd, id)).rejects.toThrow()
  })

  it('refuses unsupported source formats before interpreting superficially valid rows', async () => {
    const path = await writeProjectedGrokSession(cwd, project())
    const summaryPath = join(dirname(path), 'summary.json')
    const summary = JSON.parse(await readFile(summaryPath, 'utf8'))
    await writeFile(summaryPath, JSON.stringify({ ...summary, chat_format_version: 2 }))
    await expect(readGrokTranscript(cwd, id)).rejects.toThrow('Unsupported Grok chat format')
  })

  it.skipIf(process.platform === 'win32').each(['chat_history.jsonl', 'summary.json'])('refuses a FIFO %s without waiting for another process to open it', async name => {
    const history = await writeProjectedGrokSession(cwd, project())
    const path = join(dirname(history), name)
    await rm(path)
    execFileSync('mkfifo', [path])
    const result = readGrokTranscript(cwd, id).then(() => 'accepted', (error: Error) => error.message)
    let timer: ReturnType<typeof setTimeout> | undefined
    const observed = await Promise.race([result, new Promise<string>(resolve => { timer = setTimeout(() => resolve('blocked waiting for FIFO writer'), 1000) })])
    clearTimeout(timer)
    // Release a blocking regression before asserting, so the failing test
    // cannot strand a libuv worker or hang suite shutdown.
    if (observed === 'blocked waiting for FIFO writer') {
      const writer = openSync(path, constants.O_RDWR | constants.O_NONBLOCK)
      closeSync(writer)
      await result
    }
    expect(observed).toBe('Grok session file is not a regular file')
  })
})
