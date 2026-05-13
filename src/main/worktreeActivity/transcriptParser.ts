import type {
  WorktreeActivityEvent,
} from '@shared/work-context/types.js'
import {
  extractWorktreeActivityEvents,
} from '@shared/work-context/extractors.js'
import { streamJsonl } from '@shared/runtime/streamJsonl.js'
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
  //
  // WHY streaming instead of `readFile(...).then(t => t.split('\n'))`:
  // this function is called once per transcript inside the
  // WorktreeActivityIndex 60s background refresh loop. With heavy
  // users carrying 5+ MB transcripts, the whole-file pattern allocated
  // 3-4x the file size transiently (Buffer + string + split array +
  // parsed objects), producing the 100-200 MB spike pattern visible in
  // the system-perf popover every ~60 seconds. Streaming line-by-line
  // drops the transient peak to one line at a time (~tens of KB even
  // for large tool_use entries) at no semantic cost.
  const events: WorktreeActivityEvent[] = []
  let discoveredCwd = candidate.cwd

  for await (const raw of streamJsonl<Record<string, unknown>>(candidate.file)) {
    // streamJsonl yields null for malformed lines (partial writes,
    // truncations). Skip them — matches the prior catch-and-continue.
    if (raw === null) continue
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
