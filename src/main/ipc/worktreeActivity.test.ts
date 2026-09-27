import { beforeEach, describe, expect, it, vi } from 'vitest'

// #1430: the REAL worktree-activity handler; Electron's ipcMain is captured and
// the git lister is the edge. A timed-out `git worktree list` used to throw
// "not a git worktree" here and answer `{ ok: false }` — indistinguishable from
// a non-repository, and shown as a missing activity index.
const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>()
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) => handlers.set(channel, handler) } }))
const git = vi.hoisted(() => ({ listWorktreesForCwdDetailed: vi.fn() }))
vi.mock('@main/ipc/git.js', () => git)

import { registerWorktreeActivityIpc } from './worktreeActivity'

const getSummary = vi.fn(async () => ({ summaries: [], status: { lastIndexedAt: null } }))
beforeEach(() => {
  handlers.clear()
  getSummary.mockClear()
  registerWorktreeActivityIpc({ getSummary } as never)
})
const summary = (cwd: string) => handlers.get('worktree-activity:summary')!({}, cwd, false)

describe('worktree-activity:summary', () => {
  it('says a git timeout instead of answering "not a repository"', async () => {
    git.listWorktreesForCwdDetailed.mockResolvedValue({ worktrees: [], timedOut: true })
    expect(await summary('/repo')).toEqual({ ok: false, timedOut: true })
    expect(getSummary).not.toHaveBeenCalled()
  })

  it('keeps a plain non-repository a plain failure', async () => {
    git.listWorktreesForCwdDetailed.mockResolvedValue({ worktrees: [], timedOut: false })
    expect(await summary('/tmp/plain')).toEqual({ ok: false })
  })

  it('summarises a repository git answered for', async () => {
    git.listWorktreesForCwdDetailed.mockResolvedValue({ worktrees: [{ path: '/repo' }], timedOut: false })
    expect(await summary('/repo')).toMatchObject({ ok: true, summaries: [] })
    expect(getSummary).toHaveBeenCalledWith({ worktrees: [{ path: '/repo' }], refresh: false })
  })
})
