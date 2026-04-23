import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'

import { FEED_DEBUG_DIR } from '@main/storage/paths.js'

// Per-session feed-debug log writer.
//
// Why a per-session serialized queue instead of fire-and-forget writes:
//   The renderer flushes batches of debug entries on a timer. Without
//   serialization, two overlapping batches from the same session would
//   race at the filesystem and produce interleaved / truncated JSONL.
//   Serializing per-session keeps lines whole; serializing per-file
//   (a single global queue) would have worked but would starve
//   high-traffic sessions waiting behind unrelated writes.
//
// Why writeFile with { flag: 'a' } instead of appendFile:
//   They're equivalent, but writeFile makes the "first-write creates
//   the dir" bootstrap a single line — we mkdir then open-with-append,
//   no branch on existence.

export type FeedDebugPersistEntry = {
  id: number
  ts: number
  tMs: number
  layer: 'STATE' | 'JSONL' | 'SEM' | 'RENDER'
  kind: string
  summary: string
  data?: unknown
}

const feedDebugWriteQueues = new Map<string, Promise<void>>()

function sanitizeSessionIdForPath(sessionId: string): string {
  // Session ids are user-opaque uuids but the renderer also uses them
  // as routing keys; they must be filename-safe. Strip anything that
  // isn't [A-Za-z0-9._-] so a malformed id can't escape FEED_DEBUG_DIR
  // via path traversal (`../`, etc.).
  return sessionId.replace(/[^a-zA-Z0-9._-]/g, '_')
}

/**
 * Append `entries` to the session's feed-debug JSONL, serialized
 * behind any in-flight write for the same session. Returns when the
 * write is durable.
 */
export function queueFeedDebugAppend(
  sessionId: string,
  entries: FeedDebugPersistEntry[],
): Promise<void> {
  const previous = feedDebugWriteQueues.get(sessionId) ?? Promise.resolve()
  const next = previous
    .catch(() => {})
    .then(async () => {
      if (entries.length === 0) return
      await mkdir(FEED_DEBUG_DIR, { recursive: true })
      const filePath = join(FEED_DEBUG_DIR, `${sanitizeSessionIdForPath(sessionId)}.jsonl`)
      const text = entries
        .map(entry => JSON.stringify({ sessionId, ...entry }))
        .join('\n') + '\n'
      await writeFile(filePath, text, { encoding: 'utf8', flag: 'a' })
    })
  feedDebugWriteQueues.set(sessionId, next)
  return next
}
