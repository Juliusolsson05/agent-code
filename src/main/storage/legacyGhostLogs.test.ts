import { mkdtemp, mkdir, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { removeLegacyGhostLogs } from './legacyGhostLogs.js'

// The on-disk ghost log was removed (2026-09-25). What older builds left in
// <userData>/ghost-logs must go on the next launch, and nothing else may:
// userData also holds the workspace's other state.
describe('removeLegacyGhostLogs', () => {
  it('deletes the ghost-logs directory and leaves its siblings alone', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'agent-code-userdata-'))
    await mkdir(join(userData, 'ghost-logs'))
    await writeFile(join(userData, 'ghost-logs', 'abc.ghost.jsonl'), '{"uuid":"g-1"}\n')
    await writeFile(join(userData, 'Preferences'), '{}')

    await removeLegacyGhostLogs(userData)

    expect(await readdir(userData)).toEqual(['Preferences'])
  })

  it('is a quiet no-op when there is nothing to remove', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'agent-code-userdata-'))
    await expect(removeLegacyGhostLogs(userData)).resolves.toBeUndefined()
    expect(await readdir(userData)).toEqual([])
  })
})
