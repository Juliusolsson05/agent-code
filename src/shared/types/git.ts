export type WorktreeIdentity = {
  path: string
  branch: string | null
  head: string | null
  detached: boolean
}

export type GitWorktreeStatusCategory =
  | 'main'
  | 'dirty'
  | 'active-unmerged'
  | 'stale-review'
  | 'patch-equivalent'
  | 'cleanup-merged'
  | 'detached'
  | 'review'

export type GitWorktreeStatus = WorktreeIdentity & {
  dirty: boolean
  mergedToMain: boolean | null
  ahead: number | null
  behind: number | null
  patchUniqueAhead: number | null
  lastCommitAt: number | null
  lastCommitRelative: string | null
  category: GitWorktreeStatusCategory
  /** A git command for this row hit the runner's timeout (#1250 row 11): the
   *  row is a guess, never a cleanup category, and a timed-out `git status`
   *  counts as dirty. */
  statusTimedOut?: boolean
}
