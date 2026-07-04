import { mkdir, stat, writeFile } from 'fs/promises'
import { join } from 'path'

import { FEED_DEBUG_DIR } from '@main/storage/paths.js'
import { scheduleDebugStoragePrune } from '@main/storage/debugRetention.js'
// Shared filename-safe token helper — same escape rule the debug-bundle folder
// suffix uses. See @shared/runtime/projectDir sanitizeFilenameToken.
import { sanitizeFilenameToken } from '@shared/runtime/projectDir.js'

// Per-file cap for a single session's feed-debug JSONL.
//
// WHY 128 MiB: forensics from the 2026-07-04 crash (issue #388) showed
// individual session files reaching 60–300 MiB, and the IPC pipeline that
// delivered those bytes to main dominated the last 30 spans before a
// mark-compact abort. debugRetention already caps the WHOLE feed-debug bucket
// at ~3 GiB (22% of ~13.8 GiB), but that's a global figure — a single
// pathological session could still eat the entire bucket by itself.
//
// 128 MiB per file is roughly:
//   - 4 hours of dense debug output from one very chatty session,
//   - large enough to be useful in a debug bundle (still holds hours of
//     context around a bug),
//   - small enough that a single unbounded file cannot dominate the
//     bucket, and that on-disk work per append stays proportional to what
//     the renderer is actually doing.
//
// WHY a hard drop instead of rotation: rotation to `.1.jsonl`, `.2.jsonl`
// etc. would need the debug-bundle collector to glob all shards, and would
// silently keep letting one session grow forever across many files. A hard
// drop with a tombstone line is the opposite: forensics readers see a clear
// "we stopped writing at this point and dropped N further entries", the
// underlying cause (renderer sending too much) is not hidden by rotation.
// The renderer already retains its in-memory debug window; the disk trail
// is a bonus, not the source of truth, so bounding it is safe.
const MAX_FEED_DEBUG_FILE_BYTES = 128 * 1024 * 1024

// Tombstone line: exactly ONE JSONL row is appended the first time a
// session's file crosses the cap, then further appends short-circuit. This
// gives a clean end-of-file marker for readers without producing an
// unbounded stream of "capped" markers.
type FeedDebugCapState = {
  bytesWritten: number
  tombstoneWritten: boolean
  droppedEntries: number
}
const feedDebugCapState = new Map<string, FeedDebugCapState>()

async function loadInitialFileBytes(filePath: string): Promise<number> {
  try {
    const s = await stat(filePath)
    return Number.isFinite(s.size) ? s.size : 0
  } catch {
    // ENOENT is expected for the first-write case.
    return 0
  }
}

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

      // Per-file cap bookkeeping. The counter is process-local: the on-disk
      // file might already contain bytes from a previous run (feed-debug lives
      // across restarts), so we stat once and prime the counter from the true
      // file size before deciding whether to write.
      //
      // We advance the counter cursor to the CURRENT lastWritten position on
      // fetch so that if the counter got out-of-sync between runs (e.g. we
      // restarted mid-cap), the tombstone check still keys off real disk size.
      let capState = feedDebugCapState.get(sessionId)
      if (!capState) {
        const startingBytes = await loadInitialFileBytes(filePath)
        capState = {
          bytesWritten: startingBytes,
          tombstoneWritten: startingBytes >= MAX_FEED_DEBUG_FILE_BYTES,
          droppedEntries: 0,
        }
        feedDebugCapState.set(sessionId, capState)
      }

      // Already capped in a prior batch — count and drop. A stale process-local
      // cursor across runs doesn't matter: bookkeeping stays proportional to
      // actual disk state, so a genuinely uncapped file will re-open on the
      // next process; a truly-over-cap file stays capped whichever way we came
      // in.
      if (capState.tombstoneWritten) {
        capState.droppedEntries += freshEntries.length
        lastWrittenFeedDebugId.set(
          sessionId,
          Math.max(lastWritten, ...freshEntries.map(entry => entry.id)),
        )
        return
      }

      const text = freshEntries
        .map(entry => JSON.stringify({ sessionId, ...entry }))
        .join('\n') + '\n'
      const textBytes = Buffer.byteLength(text, 'utf8')

      // If admitting this batch would cross the cap, write ONE final tombstone
      // line instead. The tombstone records how many entries we dropped in this
      // batch — future batches append their drop counts to droppedEntries but
      // do NOT re-write the tombstone. The batch itself is discarded; we
      // deliberately do not truncate to fit, because a half-written batch would
      // interleave with the tombstone in a way readers can't cleanly parse.
      if (capState.bytesWritten + textBytes > MAX_FEED_DEBUG_FILE_BYTES) {
        capState.droppedEntries += freshEntries.length
        const tombstone = {
          sessionId,
          __feedDebugCapped: true,
          reason: 'per-file-cap',
          capBytes: MAX_FEED_DEBUG_FILE_BYTES,
          fileBytesAtCap: capState.bytesWritten,
          droppedEntriesSoFar: capState.droppedEntries,
          ts: Date.now(),
        }
        const tombLine = JSON.stringify(tombstone) + '\n'
        try {
          await writeFile(filePath, tombLine, { encoding: 'utf8', flag: 'a' })
        } catch {
          // Best-effort — capping ourselves is the safety behavior; failing to
          // write the tombstone still means we stop writing entries for this
          // session, which is the load-bearing invariant.
        }
        capState.tombstoneWritten = true
        capState.bytesWritten += Buffer.byteLength(tombLine, 'utf8')
        lastWrittenFeedDebugId.set(
          sessionId,
          Math.max(lastWritten, ...freshEntries.map(entry => entry.id)),
        )
        // Prune sooner rather than later: reaching the per-file cap is exactly
        // the signal that this session may already have contributed most of the
        // bucket. The bucket-cap pass in debugRetention.pruneDebugStorage will
        // start freeing older feed-debug files.
        scheduleDebugStoragePrune('feed-debug-per-file-cap')
        // eslint-disable-next-line no-console
        console.warn(
          `[feed-debug] session ${sessionId} reached per-file cap ` +
          `(${capState.bytesWritten} bytes ≥ ${MAX_FEED_DEBUG_FILE_BYTES}); ` +
          `wrote tombstone and dropping further appends this run`,
        )
        return
      }

      await writeFile(filePath, text, { encoding: 'utf8', flag: 'a' })
      capState.bytesWritten += textBytes
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
 *  unified sweep in storage/debugRetention.ts is what eventually
 *  deletes the file. */
export function forgetFeedDebugSession(sessionId: string): void {
  // We never delete `feedDebugWriteQueues` synchronously here —
  // there might be an in-flight write that still owns the chain.
  // The settle-time reaper in queueFeedDebugAppend handles the queue
  // entry; what we own here is the cursor.
  lastWrittenFeedDebugId.delete(sessionId)
  // Drop the cap-state entry too. If the same sessionId is re-registered later
  // in this process, we'll re-stat the on-disk file and prime a fresh counter;
  // never carrying stale cap state across "session forgotten" boundaries keeps
  // the map from growing unbounded across long-lived main processes.
  feedDebugCapState.delete(sessionId)
}
