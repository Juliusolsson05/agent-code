import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { emptyRuntime, type SessionRuntime } from '@renderer/session-runtime/state'
import { LiveWorktreeReconciler } from '@renderer/workspace/work-context/LiveWorktreeReconciler'
import { handHistoryToReconciler } from './initialHistory'

// #1430 review a/b: a history chunk read while `git worktree list` timed out
// was skipped for worktree attribution, and nothing else ever saw it: the live
// reconciler replays only what it observed, so a quiet session whose writes were
// in a linked worktree stayed on the launch folder after git recovered. The
// loaders now hand such a chunk to the reconciler (handHistoryToReconciler),
// whose window replays it when the catalog answers.
//
// Recorded data: the Codex worktree window (13 records, main
// /fixture/project-1, the agent's actual worktree .../worktree-2) and the
// recorded `git worktree list` identities.
const fixtureDir = resolve(process.cwd(), 'testing', 'fixtures', 'worktree-live-attribution')
const codex = JSON.parse(readFileSync(resolve(fixtureDir, 'codex-0151-worktree-window.json'), 'utf8')) as {
  git: { main: { path: string }; ui?: { path: string; branch: string } }
  records: unknown[]
}
const catalog = (JSON.parse(readFileSync(resolve(fixtureDir, 'git-worktree-identities.json'), 'utf8')) as {
  worktrees: Array<{ path: string; branch: string; detached: boolean }>
}).worktrees.map(worktree => ({ ...worktree, head: null }))

describe('history read while git timed out (#1430 review a/b)', () => {
  it('reaches the worktree the agent wrote in once git answers', async () => {
    let gitAnswers = false
    let runtime: SessionRuntime = emptyRuntime()
    let reconciler!: LiveWorktreeReconciler
    reconciler = new LiveWorktreeReconciler({
      loadWorktrees: async () => gitAnswers ? { ok: true, worktrees: catalog } : { ok: false, gitMissing: false, timedOut: true } as never,
      onCatalogReady: cwd => {
        const projection = reconciler.project({ sessionId: 'resumed', cwd, projection: runtime })
        runtime = { ...runtime, ...projection }
      },
    })
    const refs = { worktreeReconcilerRef: { current: reconciler }, latestRuntimesRef: { current: { resumed: runtime } } }

    // The initial history load: git timed out, so the chunk is handed over.
    handHistoryToReconciler(refs as never, 'resumed', codex.git.main.path, codex.records)
    // The refresh the loader asked for still sees git time out; a failed probe
    // is not cached, so the next refresh (any live batch or catalog event)
    // asks again — and git has recovered by then.
    expect(await reconciler.refresh(codex.git.main.path)).toBe('failed')
    expect(runtime.workContext).toBeNull()
    gitAnswers = true
    expect(await reconciler.refresh(codex.git.main.path)).toBe('ready')

    expect(runtime.workContext?.worktreePath).toBe(codex.git.ui?.path)
  })

  it('does nothing without a reconciler or without records', () => {
    expect(() => handHistoryToReconciler({ worktreeReconcilerRef: { current: null }, latestRuntimesRef: { current: {} } } as never, 's', '/x', [{}])).not.toThrow()
  })
})
