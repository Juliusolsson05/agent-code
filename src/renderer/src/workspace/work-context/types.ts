import type { WorktreeIdentity } from '@shared/types/git'

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

export type { WorktreeIdentity }
