import type { Entry } from '@shared/types/transcript'
import { isConversationEntry } from '@shared/types/transcript'
import type {
  AgentWorkContext,
  WorkContextConfidence,
  WorktreeIdentity,
} from '@renderer/workspace/work-context/types'

type Evidence = {
  path: string
  branch?: string | null
  confidence: WorkContextConfidence
  source: string
  requiresWorktreeMatch?: boolean
}

const confidenceRank: Record<WorkContextConfidence, number> = {
  fallback: 0,
  weak: 1,
  medium: 2,
  strong: 3,
  explicit: 4,
}

export function reduceWorkContextFromRaw(
  previous: AgentWorkContext | null,
  raw: unknown,
  worktrees: WorktreeIdentity[],
  sessionCwd: string,
  now = Date.now(),
): AgentWorkContext | null {
  const evidence = evidenceFromRaw(raw)
  if (!evidence) return previous

  if (evidence.source === 'claude:worktree-state:exit') {
    const fallback = fallbackContext(sessionCwd, worktrees, now, evidence.source)
    return fallback
      ? { ...fallback, confidence: 'medium', source: evidence.source }
      : previous
  }

  const matched = matchWorktree(evidence.path, worktrees)
  if (evidence.requiresWorktreeMatch && !matched) return previous

  const next: AgentWorkContext = {
    worktreePath: matched?.path ?? evidence.path,
    branch: evidence.branch ?? matched?.branch ?? null,
    repoRoot: worktrees[0]?.path ?? null,
    confidence: evidence.confidence,
    source: evidence.source,
    updatedAt: now,
  }

  if (!previous) return next

  // Do not let weak, older read/search evidence dislodge a stronger explicit
  // EnterWorktree state. Stronger or equal evidence is recency-based and wins.
  return confidenceRank[next.confidence] >= confidenceRank[previous.confidence]
    ? next
    : previous
}

export function fallbackContext(
  sessionCwd: string,
  worktrees: WorktreeIdentity[],
  now = Date.now(),
  source = 'fallback:session-cwd',
): AgentWorkContext | null {
  if (!sessionCwd) return null
  const matched = matchWorktree(sessionCwd, worktrees)
  return {
    worktreePath: matched?.path ?? sessionCwd,
    branch: matched?.branch ?? null,
    repoRoot: worktrees[0]?.path ?? null,
    confidence: 'fallback',
    source,
    updatedAt: now,
  }
}

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

function evidenceFromRaw(raw: unknown): Evidence | null {
  const record = asRecord(raw)
  if (!record) return null

  if (record.type === 'worktree-state') {
    const session = asRecord(record.worktreeSession)
    if (!session) {
      return {
        path: '',
        confidence: 'explicit',
        source: 'claude:worktree-state:exit',
      }
    }
    const worktreePath = stringField(session, 'worktreePath')
    if (!worktreePath) return null
    return {
      path: worktreePath,
      branch: stringField(session, 'worktreeBranch'),
      confidence: 'explicit',
      source: 'claude:worktree-state',
    }
  }

  const codexPayload = asRecord(record.payload)
  if (record.type === 'event_msg' && codexPayload?.type === 'exec_command_end') {
    const cwd = stringField(codexPayload, 'cwd')
    if (cwd) {
      return {
        path: cwd,
        confidence: 'strong',
        source: 'codex:exec_command_end.cwd',
      }
    }
  }

  if (record.type === 'response_item' && codexPayload?.type === 'local_shell_call') {
    const action = asRecord(codexPayload.action)
    const cwd = stringField(action, 'working_directory')
    if (cwd) {
      return {
        path: cwd,
        confidence: 'medium',
        source: 'codex:local_shell_call.cwd',
      }
    }
  }

  if (!isConversationEntry(record as Entry)) return null
  const content = (record as Entry & { message?: { content?: unknown } }).message?.content
  if (!Array.isArray(content)) return null

  for (const block of content) {
    const b = asRecord(block)
    if (!b || b.type !== 'tool_use') continue
    const input = asRecord(b.input)
    if (!input) continue

    const toolName = stringField(b, 'name') ?? 'tool'
    const directPath =
      stringField(input, 'file_path') ??
      stringField(input, 'path') ??
      stringField(input, 'cwd') ??
      stringField(input, 'workdir')
    if (directPath && directPath.startsWith('/')) {
      return {
        path: directPath,
        confidence: isWriteTool(toolName) ? 'strong' : 'weak',
        source: `tool:${toolName}:path`,
        requiresWorktreeMatch: true,
      }
    }
  }

  const cwd = stringField(record, 'cwd')
  if (cwd) {
    return {
      path: cwd,
      branch: stringField(record, 'gitBranch'),
      confidence: 'medium',
      source: 'claude:entry.cwd',
      requiresWorktreeMatch: true,
    }
  }

  return null
}

function isWriteTool(toolName: string): boolean {
  return toolName === 'Edit' ||
    toolName === 'Write' ||
    toolName === 'MultiEdit' ||
    toolName === 'NotebookEdit' ||
    toolName === 'apply_patch'
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function stringField(
  record: Record<string, unknown> | null,
  key: string,
): string | null {
  const value = record?.[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

function normalizePath(path: string): string {
  return path.replace(/\/+$/, '') || '/'
}
