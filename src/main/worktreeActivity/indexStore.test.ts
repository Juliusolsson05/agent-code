import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const scratch = await mkdtemp(join(tmpdir(), 'agent-code-worktree-index-'))
vi.mock('@main/storage/paths.js', () => ({ STATE_DIR: scratch }))

const {
  loadWorktreeActivityIndex,
  WORKTREE_ACTIVITY_INDEX_VERSION,
} = await import('./indexStore.js')

const indexFile = join(scratch, 'worktree-activity-index.json')
const rawTranscript = join(scratch, 'provider-source', 'rollout.jsonl')

beforeEach(async () => {
  await rm(indexFile, { force: true })
  await rm(join(scratch, 'provider-source'), { recursive: true, force: true })
  await mkdir(join(scratch, 'provider-source'), { recursive: true })
})

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true })
})

describe('worktree activity index persistence', () => {
  it('invalidates the old derived parser cache without touching raw transcripts', async () => {
    const rawBytes = '{"type":"session_meta","payload":{"cwd":"/fixture/project"}}\n'
    await writeFile(rawTranscript, rawBytes)
    await writeFile(indexFile, JSON.stringify({
      version: 2,
      updatedAt: 123,
      transcripts: {
        [rawTranscript]: {
          file: rawTranscript,
          events: [],
        },
      },
    }))

    const loaded = await loadWorktreeActivityIndex()

    // WHY assert the provider bytes separately: the cache is disposable, but
    // the JSONL is the user's durable source of truth. A version mismatch must
    // make the in-memory cache empty and let the normal refresh rebuild it;
    // it must never "clean up" or rewrite provider-owned recordings.
    expect(loaded).toEqual({
      version: WORKTREE_ACTIVITY_INDEX_VERSION,
      updatedAt: 0,
      transcripts: {},
    })
    expect(await readFile(rawTranscript, 'utf8')).toBe(rawBytes)
  })
})
