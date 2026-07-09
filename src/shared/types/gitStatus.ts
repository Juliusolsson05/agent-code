// GitBar status IPC contract.
//
// WHY shared (and WHY the `GitBar` prefix): the `git:status` result is a
// multi-part shape — branch, numstat file rows, recent commits, and submodule
// rows with non-trivial state semantics. It was declared inline in three
// places (main `ipc/git.ts` return, preload `api/git.ts`, renderer `GitBar.tsx`
// GitData). The name `GitStatusResult` is ALREADY taken in
// `src/shared/git/gitParse.ts` for a porcelain-status parser result — a
// different concept — so reusing it would be confusing. Hence `GitBarStatusResult`.
//
// INVARIANTS the renderer depends on:
//   - `submodules` is `undefined` (not `[]`) when there are no changed
//     submodules, so the renderer can gate on `data.submodules?.length`.
//   - submodule `state` union stays 'dirty' | 'bumped' | 'both'.
//   - binary numstat rows are coerced to 0/0 (see shared parseNumstat) so the
//     UI never special-cases the '-' marker git emits for binaries.

export type GitNumstatLine = {
  file: string
  additions: number
  deletions: number
}

export type GitRecentCommit = {
  hash: string
  subject: string
  author: string
  relativeDate: string
}

export type GitSubmoduleStatus = {
  path: string
  state: 'dirty' | 'bumped' | 'both'
  /** Inner per-file numbers — the parent numstat only surfaces the gitlink. */
  files: GitNumstatLine[]
  range?: { from: string; to: string }
}

export type GitBarStatusResult =
  | {
      ok: true
      branch: string
      files: GitNumstatLine[]
      commits: GitRecentCommit[]
      submodules?: GitSubmoduleStatus[]
    }
  | {
      ok: false
      /** True when the git BINARY itself could not be spawned (ENOENT),
       *  as opposed to "cwd is not a git repository" (#495 A5). Before
       *  this flag both cases collapsed into the same { ok:false } and
       *  the renderer told a user without git "not a git repository" —
       *  a lie that hid the actual fix (install git / point Setup at
       *  it). Required, not optional: the producer must decide, and the
       *  renderer must branch. */
      gitMissing: boolean
    }
