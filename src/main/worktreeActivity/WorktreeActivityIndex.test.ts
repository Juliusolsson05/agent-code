import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type { TranscriptCandidate } from '@main/worktreeActivity/types.js'

// #767 item 3: a background refresh that found nothing new used to re-stamp,
// re-stringify and replace the whole index (30 MB+ for heavy users) every 60 s,
// and the new timestamp invalidated the summary cache. The index store and the
// transcript parser are REAL here, against a temp state dir. Only discovery is
// replaced: it walks the developer's real ~/.claude and ~/.codex trees.

const scratch = await mkdtemp(join(tmpdir(), 'agent-code-worktree-activity-'))
vi.mock('@main/storage/paths.js', async importOriginal => ({ ...(await importOriginal<object>()), STATE_DIR: scratch }))
const candidates: TranscriptCandidate[] = []
vi.mock('@main/worktreeActivity/transcriptDiscovery.js', () => ({
  discoverTranscriptCandidates: async () => candidates.map(candidate => ({ ...candidate })),
}))

const { WorktreeActivityIndex } = await import('./WorktreeActivityIndex.js')

const indexFile = join(scratch, 'worktree-activity-index.json')
const sources = join(scratch, 'codex-sessions')

// The first line of a real Codex rollout: session_meta naming the checkout.
const rolloutLine = (cwd: string) => `${JSON.stringify({ type: 'session_meta', payload: { cwd, id: 'fixture' } })}\n`

async function addRollout(name: string, cwd: string): Promise<void> {
  const file = join(sources, `${name}.jsonl`)
  await writeFile(file, rolloutLine(cwd))
  const st = await stat(file)
  const existing = candidates.findIndex(candidate => candidate.file === file)
  const candidate: TranscriptCandidate = {
    provider: 'codex', providerSessionId: name, file, cwd: '', mtimeMs: st.mtimeMs, size: st.size,
  }
  if (existing >= 0) candidates[existing] = candidate
  else candidates.push(candidate)
}

const worktrees = [{ path: '/fixture/project', branch: 'main' }] as never

beforeEach(async () => {
  candidates.splice(0)
  await rm(indexFile, { force: true })
  await rm(sources, { recursive: true, force: true })
  await mkdir(sources, { recursive: true })
})

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true })
})

describe('WorktreeActivityIndex refresh persistence (#767)', () => {
  it('writes nothing and keeps the content generation when a refresh finds no changes', async () => {
    await addRollout('one', '/fixture/project')
    await addRollout('two', '/fixture/other')
    const index = new WorktreeActivityIndex()
    await index.getSummary({ worktrees, refresh: true })
    const written = await readFile(indexFile, 'utf8')
    const firstUpdatedAt = (JSON.parse(written) as { updatedAt: number }).updatedAt
    // Push the file's mtime into the past so a rewrite would be visible.
    const past = new Date(Date.now() - 60_000)
    await utimes(indexFile, past, past)
    const firstCheck = (await index.getSummary({ worktrees })).status.lastIndexedAt

    await new Promise(resolve => setTimeout(resolve, 5))
    const second = await index.getSummary({ worktrees, refresh: true })

    expect(second.status.cacheHits).toBe(2)
    expect(second.status.parsedFiles).toBe(0)
    expect(await readFile(indexFile, 'utf8')).toBe(written)
    // Unchanged mtime (filesystems store sub-ms precision, utimes takes ms).
    expect(Math.abs((await stat(indexFile)).mtimeMs - past.getTime())).toBeLessThan(1)
    // The re-check is still recorded, but the content generation is unchanged.
    expect(second.status.lastIndexedAt).toBeGreaterThan(firstCheck!)
    expect((JSON.parse(await readFile(indexFile, 'utf8')) as { updatedAt: number }).updatedAt).toBe(firstUpdatedAt)
  })

  it.each([
    ['a transcript changed', async () => { await addRollout('one', '/fixture/project-moved') }],
    ['a transcript was added', async () => { await addRollout('three', '/fixture/project') }],
    ['a transcript was deleted', async () => { candidates.pop() }],
  ])('persists when %s', async (_label, change) => {
    await addRollout('one', '/fixture/project')
    await addRollout('two', '/fixture/other')
    const index = new WorktreeActivityIndex()
    await index.getSummary({ worktrees, refresh: true })
    const before = (JSON.parse(await readFile(indexFile, 'utf8')) as { updatedAt: number }).updatedAt
    await new Promise(resolve => setTimeout(resolve, 5))
    await change()
    await index.getSummary({ worktrees, refresh: true })
    const after = JSON.parse(await readFile(indexFile, 'utf8')) as { updatedAt: number; transcripts: Record<string, unknown> }
    expect(after.updatedAt).toBeGreaterThan(before)
    expect(Object.keys(after.transcripts)).toHaveLength(candidates.length)
  })

  it('stores the same content generation on disk that it keeps in memory', async () => {
    await addRollout('one', '/fixture/project')
    const index = new WorktreeActivityIndex()
    const { status } = await index.getSummary({ worktrees, refresh: true })
    const onDisk = (JSON.parse(await readFile(indexFile, 'utf8')) as { updatedAt: number }).updatedAt
    expect(onDisk).toBe(status.lastIndexedAt)
  })
})
