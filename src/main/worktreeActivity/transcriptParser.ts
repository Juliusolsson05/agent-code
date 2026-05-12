import { readFile } from 'fs/promises'

import type {
  WorktreeActivityEvent,
} from '@shared/work-context/types.js'
import {
  extractWorktreeActivityEvents,
} from '@shared/work-context/extractors.js'
import type {
  IndexedTranscript,
  TranscriptCandidate,
} from '@main/worktreeActivity/types.js'

export async function parseTranscriptForActivity(
  candidate: TranscriptCandidate,
): Promise<IndexedTranscript> {
  // This parser stores only compact worktree facts, never rendered
  // transcript content. That keeps the persisted index small and keeps
  // privacy/blast-radius sane: the raw Claude/Codex JSONL files remain
  // where the providers wrote them, while Agent Code stores enough
  // metadata to answer workspace orchestration questions quickly.
  const text = await readFile(candidate.file, 'utf8')
  const events: WorktreeActivityEvent[] = []
  let discoveredCwd = candidate.cwd

  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let raw: Record<string, unknown>
    try {
      raw = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    if (!discoveredCwd) discoveredCwd = extractCwd(raw)
    events.push(...extractWorktreeActivityEvents(raw, candidate.mtimeMs))
  }

  return {
    ...candidate,
    cwd: discoveredCwd,
    indexedAt: Date.now(),
    events: events
      .filter(event => event.path)
      .map(event => ({
        path: event.path,
        branch: event.branch,
        ts: event.ts,
        kind: event.kind,
        source: event.source,
        primaryWeight: event.primaryWeight,
      })),
  }
}

function extractCwd(raw: Record<string, unknown>): string {
  if (typeof raw.cwd === 'string' && raw.cwd.length > 0) return raw.cwd
  const payload = raw.payload as Record<string, unknown> | undefined
  if (typeof payload?.cwd === 'string' && payload.cwd.length > 0) return payload.cwd
  return ''
}
