import type {
  AgentWorkContext,
  WorktreeIdentity,
} from '@shared/work-context/types.js'

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
    // WHY Git wins even when its value is null: a matched identity describes
    // the checkout as it exists now. Provider branch strings are launch-time
    // metadata and the recorded Claude resume kept saying main after cwd/tool
    // paths moved to a linked worktree. `null` is also meaningful for detached
    // HEAD; falling back there would falsely relabel a detached checkout.
    branch: matched ? matched.branch : branch ?? null,
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
  let filesystemPath = path

  // WHY URL conversion belongs here instead of in the Codex adapter: the raw
  // event must retain its literal provider representation for historical
  // evidence and diagnostics, while every live matcher must compare the same
  // filesystem coordinate. Current Codex CommandExecution records uniformly
  // use non-hosted local file URLs. We intentionally reject hosted file URLs
  // instead of guessing remote/UNC semantics that do not exist in the
  // recorded corpus.
  if (path.startsWith('file://')) {
    try {
      const url = new URL(path)
      if (url.protocol === 'file:' && url.hostname === '') {
        filesystemPath = decodeURIComponent(url.pathname)
      }
    } catch {
      // A malformed provider URL is not safely equivalent to a local path.
      // Leaving it unchanged makes matching fail closed against Git roots.
    }
  }

  return filesystemPath.replace(/\/+$/, '') || '/'
}
