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

  it('repaints at once when the reconciler already holds a fresh catalog (#1450 verification a)', async () => {
    // A live event loaded the catalog before this pane's history arrived; only
    // the history's own gitWorktrees call timed out. refresh() then answers
    // 'cached' and never calls onCatalogReady, so without a replay the chunk
    // sat in the window and the pane stayed on the launch folder.
    let runtime: SessionRuntime = emptyRuntime()
    let reconciler!: LiveWorktreeReconciler
    reconciler = new LiveWorktreeReconciler({
      loadWorktrees: async () => ({ ok: true, worktrees: catalog }),
      onCatalogReady: cwd => {
        const projection = reconciler.project({ sessionId: 'resumed', cwd, projection: runtime })
        runtime = { ...runtime, ...projection }
      },
    })
    expect(await reconciler.refresh(codex.git.main.path)).toBe('ready')
    expect(runtime.workContext?.worktreePath).not.toBe(codex.git.ui?.path)
    const refs = { worktreeReconcilerRef: { current: reconciler }, latestRuntimesRef: { current: { resumed: runtime } } }

    handHistoryToReconciler(refs as never, 'resumed', codex.git.main.path, codex.records)
    await Promise.resolve()
    await Promise.resolve()

    expect(runtime.workContext?.worktreePath).toBe(codex.git.ui?.path)
  })

  it('an older page read during the timeout never outranks the newest chunk (#1450 B6 verify)', async () => {
    // B6's sequence: the initial history (newest) is handed over while git
    // times out; the user scrolls up while it still times out, and the older
    // page is handed over too; git recovers. The older page must stay OLDER
    // evidence: the pane belongs where the newest records put it.
    //
    // Older page = the recorded worktree-2 window. Newest chunk = the same
    // recorded records moved to worktree-1 and 1 h later (only cwd and
    // timestamp change, so the record shape is the recorded one).
    const worktree1 = catalog.find(w => w.path.endsWith('/worktree-1'))!.path
    const newest = codex.records.map(record => {
      const r = structuredClone(record) as { timestamp?: string; payload?: { item?: { cwd?: string } } }
      if (r.timestamp) r.timestamp = new Date(Date.parse(r.timestamp) + 3_600_000).toISOString()
      if (r.payload?.item?.cwd) r.payload.item.cwd = `file://${worktree1}`
      return r
    })
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

    handHistoryToReconciler(refs as never, 'resumed', codex.git.main.path, newest)
    expect(await reconciler.refresh(codex.git.main.path)).toBe('failed')
    handHistoryToReconciler(refs as never, 'resumed', codex.git.main.path, codex.records, 'older')
    expect(await reconciler.refresh(codex.git.main.path)).toBe('failed')
    gitAnswers = true
    expect(await reconciler.refresh(codex.git.main.path)).toBe('ready')

    expect(runtime.workContext?.worktreePath).toBe(worktree1)
  })

  it('does nothing without a reconciler or without records', () => {
    expect(() => handHistoryToReconciler({ worktreeReconcilerRef: { current: null }, latestRuntimesRef: { current: {} } } as never, 's', '/x', [{}])).not.toThrow()
  })
})
