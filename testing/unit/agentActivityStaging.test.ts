import { lstat, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { writeStagedFile } from '../../scripts/agent-activity-staging'

// Review of #1353, round 5 a (manager q82): a concurrent process swapped the just-created staging
// DIRECTORY for a symlink before the by-path write, redirecting unaudited private bytes into a git
// worktree. These tests make that interleaving deterministic by swapping the staged PATH right
// between the exclusive open and the write.

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function root(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agent-activity-staging-test-'))
  roots.push(dir)
  return dir
}

describe.skipIf(process.platform === 'win32')('writeStagedFile', () => {
  it('writes through its descriptor: a path swapped after the open cannot redirect the bytes', async () => {
    const staging = await root()
    const elsewhere = await root()
    const victim = join(elsewhere, 'tracked.json')
    await writeFile(victim, 'SENTINEL')
    let moved = ''
    const path = await writeStagedFile(staging, 'private-bytes', async opened => {
      // The attack: move our file away and put a symlink to the victim where it was.
      moved = `${opened}.moved`
      await rename(opened, moved)
      await symlink(victim, opened)
    })
    expect(await readFile(victim, 'utf8')).toBe('SENTINEL')
    expect(await readFile(moved, 'utf8')).toBe('private-bytes')
    expect((await lstat(path)).isSymbolicLink()).toBe(true)
  })

  it('creates a new 0600 file and never reuses a name', async () => {
    const staging = await root()
    const first = await writeStagedFile(staging, 'a')
    const second = await writeStagedFile(staging, 'b')
    expect(first).not.toBe(second)
    expect((await stat(first)).mode & 0o777).toBe(0o600)
    expect(await readFile(second, 'utf8')).toBe('b')
  })
})
