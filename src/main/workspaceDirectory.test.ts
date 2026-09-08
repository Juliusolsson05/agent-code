import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  MissingWorkspaceDirectoryError,
  assertWorkspaceDirectoryExists,
} from './workspaceDirectory.js'

// WHY this suite touches the real filesystem instead of mocking node:fs: the
// entire point of the guard is to predict whether a forked child's chdir will
// succeed. A mocked stat would only assert that we call stat, which is the one
// thing that cannot regress silently. Real temp directories test the property
// we actually care about, including the symlink case that a naive lstat
// implementation would get wrong.
const made: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'agent-code-wsdir-'))
  made.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(made.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('assertWorkspaceDirectoryExists', () => {
  it('accepts a directory that exists', async () => {
    const dir = await tempDir()
    await expect(assertWorkspaceDirectoryExists(dir)).resolves.toBeUndefined()
  })

  it('names the resolved path when the directory is gone', async () => {
    const dir = await tempDir()
    const missing = path.join(dir, 'deleted-worktree')
    await expect(assertWorkspaceDirectoryExists(missing))
      .rejects.toThrow(MissingWorkspaceDirectoryError)
    // The path is the whole value of this error — a message that says only
    // "folder is missing" reproduces the failure it was written to replace.
    await expect(assertWorkspaceDirectoryExists(missing))
      .rejects.toThrow(missing)
  })

  it('rejects a path that exists but is a file', async () => {
    const dir = await tempDir()
    const file = path.join(dir, 'not-a-directory')
    await writeFile(file, '')
    await expect(assertWorkspaceDirectoryExists(file))
      .rejects.toThrow(MissingWorkspaceDirectoryError)
  })

  it('follows symlinks, accepting a link to a live directory', async () => {
    const dir = await tempDir()
    const target = path.join(dir, 'target')
    const link = path.join(dir, 'link')
    await mkdir(target)
    await symlink(target, link)
    await expect(assertWorkspaceDirectoryExists(link)).resolves.toBeUndefined()
  })

  it('rejects a dangling symlink, which is what a deleted worktree leaves behind', async () => {
    const dir = await tempDir()
    const link = path.join(dir, 'link')
    await symlink(path.join(dir, 'never-existed'), link)
    // stat (not lstat) is the deliberate choice: chdir follows the link too,
    // so the child would fail here exactly as this guard does.
    await expect(assertWorkspaceDirectoryExists(link))
      .rejects.toThrow(MissingWorkspaceDirectoryError)
  })

  it('resolves a relative path before reporting it', async () => {
    await expect(assertWorkspaceDirectoryExists('definitely-not-here'))
      .rejects.toThrow(path.resolve('definitely-not-here'))
  })
})
