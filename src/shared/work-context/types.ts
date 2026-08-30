import type { WorktreeIdentity } from '@shared/types/git.js'

export type WorkContextConfidence =
  | 'explicit'
  | 'strong'
  | 'medium'
  | 'weak'
  | 'fallback'

export type AgentWorkContext = {
  worktreePath: string | null
  branch: string | null
  repoRoot: string | null
  confidence: WorkContextConfidence
  source: string
  updatedAt: number
}

export type WorktreeActivityKind =
  | 'session-cwd'
  | 'worktree-enter'
  | 'worktree-exit'
  | 'command'
  | 'file-read'
  | 'file-write'
  | 'git-commit'
  | 'git-push'
  | 'git-branch'
  | 'pr-create'
  | 'pr-merge'
  | 'verification'

export type WorktreeActivityEvent = {
  key: string
  ts: number
  kind: WorktreeActivityKind
  source: string
  path: string
  branch: string | null
  confidence: WorkContextConfidence
  primaryWeight: number
  active: boolean
  requiresWorktreeMatch?: boolean
  command?: string
  filePaths?: string[]
  /**
   * The checkout selected when this event was ingested.
   *
   * WHY retain this provenance beside the raw evidence path: a later Git
   * catalog can reveal that an earlier, smaller catalog attributed the event
   * to the parent checkout. Reconciliation must be able to reverse that exact
   * touch contribution before replay; the raw path alone cannot tell us which
   * checkout received the old score.
   */
  resolvedWorktreePath?: string
}

export type WorktreeTouchSummary = {
  worktreePath: string
  branch: string | null
  score: number
  lastAt: number
  eventCount: number
  writeCount: number
  commandCount: number
  source: string
}

export type WorktreeActivityState = {
  active: AgentWorkContext | null
  primary: AgentWorkContext | null
  touched: Record<string, WorktreeTouchSummary>
  timeline: WorktreeActivityEvent[]
  recentKeys: string[]
  updatedAt: number
}

export type { WorktreeIdentity }
