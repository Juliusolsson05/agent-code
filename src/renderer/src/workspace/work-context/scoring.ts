import type {
  WorkContextConfidence,
  WorktreeActivityKind,
} from '@renderer/workspace/work-context/types'

export const confidenceRank: Record<WorkContextConfidence, number> = {
  fallback: 0,
  weak: 1,
  medium: 2,
  strong: 3,
  explicit: 4,
}

export function classifyCommand(command: string | null | undefined): WorktreeActivityKind {
  const normalized = (command ?? '').trim()
  if (!normalized) return 'command'

  if (/^git\s+commit\b/.test(normalized)) return 'git-commit'
  if (/^git\s+push\b/.test(normalized)) return 'git-push'
  if (/^git\s+(checkout|switch|branch)\b/.test(normalized)) return 'git-branch'
  if (/^gh\s+pr\s+create\b/.test(normalized)) return 'pr-create'
  if (/^gh\s+pr\s+merge\b/.test(normalized)) return 'pr-merge'
  if (
    /^git\s+(status|log|diff|show|rev-parse|ls-remote|pull|fetch)\b/.test(normalized) ||
    /^gh\s+pr\s+(view|status|checks)\b/.test(normalized)
  ) {
    return 'verification'
  }
  return 'command'
}

export function primaryWeightFor(kind: WorktreeActivityKind): number {
  switch (kind) {
    case 'worktree-enter':
      return 20
    case 'git-commit':
    case 'git-push':
    case 'pr-create':
      return 12
    case 'file-write':
      return 9
    case 'git-branch':
      return 6
    case 'command':
      return 4
    case 'file-read':
      return 2
    case 'verification':
    case 'pr-merge':
      return 1
    case 'session-cwd':
    case 'worktree-exit':
      return 0
  }
}

export function confidenceForKind(kind: WorktreeActivityKind): WorkContextConfidence {
  switch (kind) {
    case 'worktree-enter':
      return 'explicit'
    case 'git-commit':
    case 'git-push':
    case 'git-branch':
    case 'pr-create':
    case 'pr-merge':
    case 'command':
    case 'file-write':
      return 'strong'
    case 'verification':
      return 'medium'
    case 'file-read':
      return 'weak'
    case 'session-cwd':
    case 'worktree-exit':
      return 'fallback'
  }
}
