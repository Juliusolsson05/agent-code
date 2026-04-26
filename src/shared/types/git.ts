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
  | 'cleanup-merged'
  | 'detached'
  | 'review'

export type GitWorktreeStatus = WorktreeIdentity & {
  dirty: boolean
  mergedToMain: boolean | null
  ahead: number | null
  behind: number | null
  lastCommitAt: number | null
  lastCommitRelative: string | null
  category: GitWorktreeStatusCategory
}
