import type { WorktreeActivityKind } from '@shared/work-context/types.js'

export type WorktreeActivityProvider = 'claude' | 'codex'

export type WorktreeActivityCounts = {
  reads: number
  writes: number
  commands: number
  commits: number
  pushes: number
  verifications: number
}

export type WorktreeActivitySummary = {
  worktreePath: string
  branch: string | null
  lastActivityAt: number
  lastProvider: WorktreeActivityProvider
  lastProviderSessionId: string
  lastTranscriptFile: string
  lastSource: string
  score: number
  eventCounts: WorktreeActivityCounts
}

export type IndexedWorktreeActivityEvent = {
  path: string
  branch: string | null
  ts: number
  kind: WorktreeActivityKind
  source: string
  primaryWeight: number
}

export type IndexedTranscriptMeta = {
  file: string
  provider: WorktreeActivityProvider
  providerSessionId: string
  cwd: string
  mtimeMs: number
  size: number
  indexedAt: number
}

export type IndexedTranscript = IndexedTranscriptMeta & {
  events: IndexedWorktreeActivityEvent[]
}

export type WorktreeActivityIndexFile = {
  version: number
  updatedAt: number
  transcripts: Record<string, IndexedTranscript>
}

export type WorktreeActivityIndexStatus = {
  lastIndexedAt: number | null
  refreshing: boolean
  stale: boolean
  cacheHits: number
  parsedFiles: number
  skippedFiles: number
}

export type TranscriptCandidate = {
  provider: WorktreeActivityProvider
  providerSessionId: string
  file: string
  cwd: string
  mtimeMs: number
  size: number
}

export function emptyCounts(): WorktreeActivityCounts {
  return {
    reads: 0,
    writes: 0,
    commands: 0,
    commits: 0,
    pushes: 0,
    verifications: 0,
  }
}

export function incrementCounts(
  counts: WorktreeActivityCounts,
  kind: WorktreeActivityKind,
): WorktreeActivityCounts {
  const next = { ...counts }
  if (kind === 'file-read') next.reads += 1
  if (kind === 'file-write') next.writes += 1
  if (kind === 'command' || kind === 'git-branch' || kind === 'pr-create' || kind === 'pr-merge') {
    next.commands += 1
  }
  if (kind === 'git-commit') next.commits += 1
  if (kind === 'git-push') next.pushes += 1
  if (kind === 'verification') next.verifications += 1
  return next
}
