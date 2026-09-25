import { mkdtemp, mkdir, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

// The on-disk ghost log was removed (2026-09-25). What older builds left in
// <userData>/ghost-logs must go on the next launch, and nothing else may:
// userData also holds the workspace's other state.
const fsState = vi.hoisted(() => ({ failWith: null as Error | null }))
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rm: (...args: Parameters<typeof actual.rm>) =>
      fsState.failWith ? Promise.reject(fsState.failWith) : actual.rm(...args),
  }
})

const { removeLegacyGhostLogs } = await import('./legacyGhostLogs.js')

afterEach(() => {
  fsState.failWith = null
  vi.restoreAllMocks()
})

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
    // Every launch after the first finds no directory; that must not warn.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const userData = await mkdtemp(join(tmpdir(), 'agent-code-userdata-'))
    await expect(removeLegacyGhostLogs(userData)).resolves.toBeUndefined()
    expect(await readdir(userData)).toEqual([])
    expect(warn).not.toHaveBeenCalled()
  })

  it('never rejects, because its launch call site does not wait for it', async () => {
    // The call in main/index.ts is fire-and-forget (`void`). A permissions
    // error or a Windows EBUSY must log, not surface as an unhandled
    // rejection in main on every launch.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    fsState.failWith = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    await expect(removeLegacyGhostLogs('/nowhere')).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledOnce()
  })
})
