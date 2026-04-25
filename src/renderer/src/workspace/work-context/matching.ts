import type {
  AgentWorkContext,
  WorktreeIdentity,
} from '@renderer/workspace/work-context/types'

export function matchWorktree(
  candidatePath: string | null | undefined,
  worktrees: WorktreeIdentity[],
): WorktreeIdentity | null {
  if (!candidatePath) return null
  const normalized = normalizePath(candidatePath)
  let best: WorktreeIdentity | null = null
  for (const worktree of worktrees) {
    const root = normalizePath(worktree.path)
    if (normalized === root || normalized.startsWith(`${root}/`)) {
      if (!best || root.length > normalizePath(best.path).length) best = worktree
    }
  }
  return best
}

export function contextFromPath(params: {
  path: string
  branch?: string | null
  confidence: AgentWorkContext['confidence']
  source: string
  worktrees: WorktreeIdentity[]
  now: number
}): AgentWorkContext {
  const { path, branch, confidence, source, worktrees, now } = params
  const matched = matchWorktree(path, worktrees)
  return {
    worktreePath: matched?.path ?? path,
    branch: branch ?? matched?.branch ?? null,
    repoRoot: worktrees[0]?.path ?? null,
    confidence,
    source,
    updatedAt: now,
  }
}

export function fallbackContext(
  sessionCwd: string,
  worktrees: WorktreeIdentity[],
  now = Date.now(),
  source = 'fallback:session-cwd',
): AgentWorkContext | null {
  if (!sessionCwd) return null
  return contextFromPath({
    path: sessionCwd,
    confidence: 'fallback',
    source,
    worktrees,
    now,
  })
}

export function normalizePath(path: string): string {
  return path.replace(/\/+$/, '') || '/'
}
