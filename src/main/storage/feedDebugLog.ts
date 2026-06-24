import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'

import { FEED_DEBUG_DIR } from '@main/storage/paths.js'
import { scheduleDebugStoragePrune } from '@main/storage/debugRetention.js'
// Shared filename-safe token helper — same escape rule the debug-bundle folder
// suffix uses. See @shared/runtime/projectDir sanitizeFilenameToken.
import { sanitizeFilenameToken } from '@shared/runtime/projectDir.js'

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
  layer: 'STATE' | 'JSONL' | 'SEM' | 'RENDER' | 'GHOST'
  kind: string
  summary: string
  data?: unknown
}

const feedDebugWriteQueues = new Map<string, Promise<void>>()
const lastWrittenFeedDebugId = new Map<string, number>()

// Session ids are user-opaque uuids but the renderer also uses them as routing
// keys; they must be filename-safe so a malformed id can't escape
// FEED_DEBUG_DIR via path traversal. Delegated to the shared helper so this and
// the debug-bundle folder suffix share one escape rule.
const sanitizeSessionIdForPath = sanitizeFilenameToken

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
      const lastWritten = lastWrittenFeedDebugId.get(sessionId) ?? 0
      // The renderer advances its persisted cursor only after IPC
      // success, so two React effect passes can legally send the
      // same pending window while the first disk write is still in
      // flight. The comments in useFeedDebugPersist already rely on
      // idempotence by (sessionId,id); enforce that contract here
      // instead of making every reader mentally dedupe JSONL rows.
      // This is intentionally process-local, not reconstructed from
      // the existing file: a fresh app run should be able to append a
      // new diagnostic timeline for the same session even though ids
      // restart from 1 in renderer memory.
      const freshEntries = entries.filter(entry => entry.id > lastWritten)
      if (freshEntries.length === 0) return
      await mkdir(FEED_DEBUG_DIR, { recursive: true })
      const filePath = join(FEED_DEBUG_DIR, `${sanitizeSessionIdForPath(sessionId)}.jsonl`)
      const text = freshEntries
        .map(entry => JSON.stringify({ sessionId, ...entry }))
        .join('\n') + '\n'
      await writeFile(filePath, text, { encoding: 'utf8', flag: 'a' })
      lastWrittenFeedDebugId.set(
        sessionId,
        Math.max(lastWritten, ...freshEntries.map(entry => entry.id)),
      )
      scheduleDebugStoragePrune('feed-debug-append')
    })
  feedDebugWriteQueues.set(sessionId, next)

  // Reap the queue entry once it settles — but only if no NEWER
  // append has chained on top of `next`. The `===` check is the
  // critical safety: a concurrent `queueFeedDebugAppend` for the same
  // sessionId would have replaced the map value with a longer chain;
  // deleting it here would race the next caller's read of the
  // previous chain. Keeping the entry in those cases is correct —
  // the LATER settle will run this same hook and find no successor.
  void next
    .catch(() => {})
    .finally(() => {
      if (feedDebugWriteQueues.get(sessionId) === next) {
        feedDebugWriteQueues.delete(sessionId)
      }
    })

  return next
}

/** Drop in-memory bookkeeping for a session that has ended. The
 *  on-disk JSONL is intentionally LEFT IN PLACE — debug bundles for
 *  long-since-closed panes still benefit from reading the trail. The
 *  retention sweep in pruneStaleFeedDebugLogs is what eventually
 *  deletes the file. */
export function forgetFeedDebugSession(sessionId: string): void {
  // We never delete `feedDebugWriteQueues` synchronously here —
  // there might be an in-flight write that still owns the chain.
  // The settle-time reaper in queueFeedDebugAppend handles the queue
  // entry; what we own here is the cursor.
  lastWrittenFeedDebugId.delete(sessionId)
}
