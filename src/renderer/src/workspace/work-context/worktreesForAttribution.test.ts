import { describe, expect, it } from 'vitest'

import { worktreesForAttribution } from './worktreesForAttribution'

// #1430: history chunks attributed a TIMED-OUT worktree list as `[]` (no
// worktrees), recording the pane's work as outside any worktree. The three
// answers `git:worktrees` gives (see src/preload/api/git.ts) map to three
// different things.
describe('worktreesForAttribution', () => {
  const worktrees = [{ path: '/repo' }, { path: '/repo/.worktrees/a' }]

  it('attributes against the list git answered', () => {
    expect(worktreesForAttribution({ ok: true, worktrees })).toBe(worktrees)
  })

  it('skips attribution when git timed out: the family is unknown, not empty', () => {
    expect(worktreesForAttribution({ ok: false, gitMissing: false, timedOut: true } as never)).toBeNull()
  })

  it('attributes against no worktrees for a real non-repository or missing git', () => {
    expect(worktreesForAttribution({ ok: false, gitMissing: false } as never)).toEqual([])
    expect(worktreesForAttribution({ ok: false, gitMissing: true } as never)).toEqual([])
  })
})
