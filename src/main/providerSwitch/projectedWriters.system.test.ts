import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// The two functions whose SEMANTICS this change altered — from overwrite to
// no-clobber — had zero direct coverage (#1076 review, finding 3, M7/M8).
// Every existing test that touches them mocks `shared.js` wholesale, so
// nothing anywhere exercised the real target filename or the real publish
// through them: renaming the Claude target to `<id>.WRONG` left 2150 tests
// green.
//
// Real directories, real files. Only the two ROOT resolvers are stubbed —
// those read the user's home, which a test cannot supply.
// ---------------------------------------------------------------------------

let root: string

vi.mock('@shared/runtime/projectDir.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@shared/runtime/projectDir.js')
  return { ...actual, getProjectDirForCwd: async () => join(root, 'claude-project') }
})
vi.mock('@providers/codex/runtime/projectDir.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@providers/codex/runtime/projectDir.js')
  return { ...actual, getCodexSessionsDir: () => join(root, 'codex-sessions') }
})

const { writeProjectedClaudeSessionFile, writeProjectedCodexRolloutFile } = await import('./shared.js')

beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'projected-writers-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const SESSION = '11111111-2222-4333-8444-555555555555'
const claudeValues = [
  { type: 'user', sessionId: SESSION, message: { role: 'user', content: 'hello' } },
  { type: 'assistant', sessionId: SESSION, message: { role: 'assistant', content: [] } },
]
const codexValues = [
  { timestamp: '2026-09-20T09:00:00.000Z', type: 'session_meta', payload: { id: SESSION, timestamp: '2026-09-20T09:00:00.000Z' } },
]

describe('writeProjectedClaudeSessionFile', () => {
  it('publishes at the native per-cwd path, named for the session', async () => {
    const path = await writeProjectedClaudeSessionFile('/repo', claudeValues)
    expect(path).toBe(join(root, 'claude-project', `${SESSION}.jsonl`))
    // JSONL, one object per line, trailing newline — what a native reader
    // expects, byte for byte.
    expect(await readFile(path, 'utf8'))
      .toBe(`${claudeValues.map(value => JSON.stringify(value)).join('\n')}\n`)
    expect(await readdir(join(root, 'claude-project'))).toEqual([`${SESSION}.jsonl`])
  })

  it('is idempotent, and refuses to overwrite a different session', async () => {
    const path = await writeProjectedClaudeSessionFile('/repo', claudeValues)
    await expect(writeProjectedClaudeSessionFile('/repo', claudeValues)).resolves.toBe(path)

    await expect(writeProjectedClaudeSessionFile('/repo', [
      { type: 'user', sessionId: SESSION, message: { role: 'user', content: 'different' } },
    ])).rejects.toThrow(/Refusing to overwrite/)
  })
})

describe('writeProjectedCodexRolloutFile', () => {
  it('publishes into the date bucket under the native rollout name', async () => {
    const path = await writeProjectedCodexRolloutFile(codexValues)
    expect(path).toMatch(new RegExp(`codex-sessions/2026/09/20/rollout-.*-${SESSION}\\.jsonl$`))
    expect(await readFile(path, 'utf8')).toBe(`${JSON.stringify(codexValues[0])}\n`)
  })

  it('is idempotent, and refuses to overwrite a different rollout', async () => {
    const path = await writeProjectedCodexRolloutFile(codexValues)
    await expect(writeProjectedCodexRolloutFile(codexValues)).resolves.toBe(path)

    await expect(writeProjectedCodexRolloutFile([
      { ...codexValues[0], payload: { id: SESSION, timestamp: '2026-09-20T09:00:00.000Z', extra: true } },
    ])).rejects.toThrow(/Refusing to overwrite/)
  })

  it('leaves no stage behind', async () => {
    await writeProjectedCodexRolloutFile(codexValues)
    const day = join(root, 'codex-sessions', '2026', '09', '20')
    expect((await readdir(day)).filter(name => name.includes('.partial'))).toEqual([])
  })
})
