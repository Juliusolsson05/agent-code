import { describe, expect, it, vi } from 'vitest'

import { RepoRootUnknown, resolveRepoRootAfterGit } from './resolveRepoRoot'

// #1430: a timed-out `git worktree list` used to file an agent's activity under
// its worktree folder instead of its repository (resolveRepoRoot read `[]` as
// "not a repository" and answered the cwd).
const MAIN = '/repo'
const WORKTREE = '/repo/.worktrees/feature'
const answered = { worktrees: [{ path: MAIN }, { path: WORKTREE }], timedOut: false }
const timeout = { worktrees: [], timedOut: true }

describe('resolveRepoRootAfterGit', () => {
  it('answers the main checkout when git answers', async () => {
    const list = vi.fn(async () => answered)
    expect(await resolveRepoRootAfterGit(list, WORKTREE)).toBe(MAIN)
    expect(list).toHaveBeenCalledTimes(1)
  })

  it('retries a timeout once, and files under the repository when the retry answers', async () => {
    const list = vi.fn().mockResolvedValueOnce(timeout).mockResolvedValueOnce(answered)
    expect(await resolveRepoRootAfterGit(list, WORKTREE)).toBe(MAIN)
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('throws after two timeouts instead of answering the worktree folder', async () => {
    const list = vi.fn(async () => timeout)
    await expect(resolveRepoRootAfterGit(list, WORKTREE)).rejects.toBeInstanceOf(RepoRootUnknown)
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('keeps the folder for a real non-repository (git answered, no worktrees)', async () => {
    expect(await resolveRepoRootAfterGit(async () => ({ worktrees: [], timedOut: false }), '/tmp/plain')).toBe('/tmp/plain')
  })
})
