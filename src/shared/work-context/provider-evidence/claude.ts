import { asRecord } from '@shared/lib/asRecord.js'
import type { WorktreeActivityEventSeed } from '@shared/work-context/provider-evidence/types.js'
import { confidenceForKind } from '@shared/work-context/scoring.js'
import type { Entry } from '@shared/types/transcript.js'
import { isConversationEntry } from '@shared/types/transcript.js'

export function extractClaudeWorktreeActivitySeeds(
  record: Record<string, unknown>,
): WorktreeActivityEventSeed[] {
  if (record.type === 'worktree-state') {
    const session = asRecord(record.worktreeSession)
    if (!session) {
      return [{
        kind: 'worktree-exit',
        source: 'claude:worktree-state:exit',
        path: '',
        branch: null,
        confidence: 'explicit',
        active: true,
      }]
    }
    const worktreePath = stringField(session, 'worktreePath')
    return worktreePath
      ? [{
          kind: 'worktree-enter',
          source: 'claude:worktree-state',
          path: worktreePath,
          branch: stringField(session, 'worktreeBranch'),
          confidence: 'explicit',
          active: true,
        }]
      : []
  }

  // Claude conversation envelopes and Codex rollout envelopes are disjoint.
  // Return before allocating the tool-event accumulator for the many Codex and
  // metadata records that pass through the shared facade during a full scan.
  if (!isConversationEntry(record as Entry)) return []

  const seeds: WorktreeActivityEventSeed[] = []
  const cwd = stringField(record, 'cwd')
  if (cwd) {
    seeds.push({
      kind: 'session-cwd',
      source: 'claude:entry.cwd',
      path: cwd,
      branch: stringField(record, 'gitBranch'),
      confidence: 'fallback',
      active: true,
      requiresWorktreeMatch: true,
    })
  }

  // WHY envelope affinity is emitted before its tool blocks: the provider can
  // serialize stale top-level cwd/gitBranch alongside an operation whose exact
  // target is in another worktree (the recorded #685 shape). Within one
  // envelope, direct activity is the later and stronger fact. The shared
  // tracker separately prevents a generic cwd in a later envelope from
  // repossessing activity, so correctness does not depend on array order alone.
  seeds.push(...conversationToolSeeds(record))

  return seeds
}

function conversationToolSeeds(
  record: Record<string, unknown>,
): WorktreeActivityEventSeed[] {
  const content = (record as Entry & { message?: { content?: unknown } }).message?.content
  if (!Array.isArray(content)) return []

  const events: WorktreeActivityEventSeed[] = []
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
    if (!directPath?.startsWith('/')) continue

    const kind = isWriteTool(toolName) ? 'file-write' : 'file-read'
    events.push({
      kind,
      source: `tool:${toolName}:path`,
      path: directPath,
      branch: null,
      confidence: confidenceForKind(kind),
      active: true,
      requiresWorktreeMatch: true,
      filePaths: [directPath],
    })
  }
  return events
}

function isWriteTool(toolName: string): boolean {
  return toolName === 'Edit' ||
    toolName === 'Write' ||
    toolName === 'MultiEdit' ||
    toolName === 'NotebookEdit' ||
    toolName === 'apply_patch'
}

function stringField(
  record: Record<string, unknown> | null,
  key: string,
): string | null {
  const value = record?.[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}
