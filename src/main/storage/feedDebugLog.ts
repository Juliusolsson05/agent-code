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

// Tombstone rows: ONE JSONL row is appended when a session's file first
// crosses the cap, then further appends short-circuit. To keep the on-disk
// drop count honest for long-running capped sessions (the first-batch count
// alone badly understates a renderer that keeps flooding for hours), a
// REFRESHED tombstone row is appended each time the total dropped-entry
// count doubles since the last row. Doubling keeps the extra rows
// log-bounded — a session that drops a million entries adds ~20 small rows,
// not a stream of markers — while the LAST tombstone row in the file is
// always within 2x of the true total.
type FeedDebugCapState = {
  bytesWritten: number
  tombstoneWritten: boolean
  droppedEntries: number
  // Drop count recorded in the most recent tombstone row on disk. 0 until a
  // tombstone lands (also stays 0 if the tombstone write failed, which keeps
  // the retry path below armed).
  lastTombstoneDrops: number
}
const feedDebugCapState = new Map<string, FeedDebugCapState>()

// Returns the current on-disk size, 0 for a not-yet-created file, or null
// when the size is UNKNOWN (stat failed for a reason other than ENOENT).
//
// WHY null instead of 0 on non-ENOENT errors: this value primes the cap
// counter exactly once per (session, process). Failing open — treating an
// EACCES/EIO/EMFILE error as "empty file" — would let an already-300-MiB
// file grow by another full cap's worth before the counter caught up, and
// fd exhaustion (EMFILE) is most likely under exactly the load conditions
// the cap exists to bound. The caller fails CLOSED on null: it skips the
// batch without advancing the cursor, so the renderer resends and we
// re-stat on the next batch.
async function loadInitialFileBytes(filePath: string): Promise<number | null> {
  try {
    const s = await stat(filePath)
    return Number.isFinite(s.size) ? s.size : 0
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 0 : null
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

// One shape for both the first tombstone and the doubling refreshes so
// readers grep for a single `__feedDebugCapped` marker. `fileBytesAtCap` is
// the counter value at emit time — on a refresh row it reflects the file
// size INCLUDING earlier tombstone rows, which is what a reader sizing the
// file actually wants.
function buildTombstoneLine(
  sessionId: string,
  capState: { bytesWritten: number; droppedEntries: number },
): string {
  return JSON.stringify({
    sessionId,
    __feedDebugCapped: true,
    reason: 'per-file-cap',
    capBytes: MAX_FEED_DEBUG_FILE_BYTES,
    fileBytesAtCap: capState.bytesWritten,
    droppedEntriesSoFar: capState.droppedEntries,
    ts: Date.now(),
  }) + '\n'
}

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
      // WHY the placeholder is inserted into the map BEFORE the stat() await:
      // forgetFeedDebugSession() runs synchronously at session end and deletes
      // the map entry. With the old get → await → set order, a forget that
      // fired during the await hit a not-yet-existing key (no-op delete), and
      // the resumed continuation then set an entry for a dead session. Session
      // ids are UUIDs and never reused, so that entry leaked for the life of
      // the main process — exactly the unbounded-map growth the forget hook
      // exists to prevent. Registering the placeholder first makes the forget
      // delete land; the identity re-check after the await detects it and
      // bails.
      //
      // WHY tombstoneWritten primes FALSE even for an already-over-cap file:
      // an earlier revision primed it true when startingBytes ≥ cap, which
      // routed the first batch into the "already capped" short-circuit — and
      // that branch never writes a tombstone. Net effect: the 60–300 MiB
      // pre-cap-era files that MOTIVATED this cap (issue #388) got their
      // appends silently dropped with no on-disk marker at all, violating the
      // "clean end-of-file marker" promise above. Priming false routes the
      // first batch through the cap branch below, which writes the tombstone
      // and THEN latches.
      let capState = feedDebugCapState.get(sessionId)
      if (!capState) {
        capState = {
          bytesWritten: 0,
          tombstoneWritten: false,
          droppedEntries: 0,
          lastTombstoneDrops: 0,
        }
        feedDebugCapState.set(sessionId, capState)
        const startingBytes = await loadInitialFileBytes(filePath)
        if (feedDebugCapState.get(sessionId) !== capState) {
          // forgetFeedDebugSession ran during the stat await — the session is
          // gone. Drop this final batch rather than resurrect state for it.
          return
        }
        if (startingBytes === null) {
          // Unknown on-disk size (stat failed, not-ENOENT). Fail CLOSED: un-
          // prime so the next batch re-stats, and return WITHOUT advancing the
          // cursor so the renderer resends these entries. Writing anyway on an
          // unknown baseline is how a 300 MiB file gains another 128 MiB.
          feedDebugCapState.delete(sessionId)
          return
        }
        capState.bytesWritten = startingBytes
      }

      // Already capped in a prior batch — count, drop, and keep the on-disk
      // drop count honest. A stale process-local cursor across runs doesn't
      // matter: bookkeeping stays proportional to actual disk state, so a
      // genuinely uncapped file will re-open on the next process; a truly-
      // over-cap file stays capped whichever way we came in.
      if (capState.tombstoneWritten) {
        capState.droppedEntries += freshEntries.length
        lastWrittenFeedDebugId.set(
          sessionId,
          Math.max(lastWritten, ...freshEntries.map(entry => entry.id)),
        )
        // Refresh the tombstone when drops have doubled since the last row —
        // see the doubling rationale on FeedDebugCapState. Without this the
        // on-disk `droppedEntriesSoFar` froze at the FIRST batch's count
        // forever (the in-memory total dies with the process), which lied to
        // forensics by orders of magnitude for exactly the flooding sessions
        // the cap targets.
        if (
          capState.lastTombstoneDrops > 0 &&
          capState.droppedEntries >= capState.lastTombstoneDrops * 2
        ) {
          const refreshed = buildTombstoneLine(sessionId, capState)
          try {
            await writeFile(filePath, refreshed, { encoding: 'utf8', flag: 'a' })
            capState.lastTombstoneDrops = capState.droppedEntries
            capState.bytesWritten += Buffer.byteLength(refreshed, 'utf8')
          } catch {
            // Best-effort — the refresh retries at the next doubling.
          }
        }
        return
      }

      // Serialize per-entry so the cap can cut WITHIN a batch. JSONL is line-
      // delimited: any prefix of complete lines is a valid file, so admitting
      // the entries that still fit and dropping only the overflow loses less
      // data than the earlier all-or-nothing drop (which discarded a whole
      // 40 MiB batch because its LAST bytes crossed the line). The admitted
      // prefix is written in the same writeFile call as the tombstone, so no
      // torn interleaving is possible.
      const lines = freshEntries.map(
        entry => JSON.stringify({ sessionId, ...entry }) + '\n',
      )
      let admitCount = 0
      let admitBytes = 0
      for (const line of lines) {
        const lineBytes = Buffer.byteLength(line, 'utf8')
        if (capState.bytesWritten + admitBytes + lineBytes > MAX_FEED_DEBUG_FILE_BYTES) break
        admitCount += 1
        admitBytes += lineBytes
      }

      if (admitCount === lines.length) {
        // Whole batch fits — the normal path. A write failure here propagates
        // into the queue's catch WITHOUT advancing the cursor, so the renderer
        // resends and the id-dedup above keeps the retry idempotent.
        await writeFile(filePath, lines.join(''), { encoding: 'utf8', flag: 'a' })
        capState.bytesWritten += admitBytes
        lastWrittenFeedDebugId.set(
          sessionId,
          Math.max(lastWritten, ...freshEntries.map(entry => entry.id)),
        )
        scheduleDebugStoragePrune('feed-debug-append')
        return
      }

      // Cap crossed inside this batch: write the admitted prefix plus the
      // first tombstone row in ONE append, then latch.
      capState.droppedEntries += lines.length - admitCount
      const tombLine = buildTombstoneLine(sessionId, capState)
      try {
        await writeFile(
          filePath,
          lines.slice(0, admitCount).join('') + tombLine,
          { encoding: 'utf8', flag: 'a' },
        )
        // Latch ONLY on success. The earlier revision latched in a bare catch
        // too, which turned an ENOSPC/EACCES/EIO on this write — disk-full
        // being the exact pressure this cap exists for — into a file with no
        // tombstone that the code nevertheless believed was cleanly marked.
        // On failure we leave the latch open: the dropped entries stay
        // dropped (cursor advances below; retrying data writes against a
        // full disk is hopeless), but the NEXT batch retries the tombstone,
        // one small append attempt per batch.
        capState.tombstoneWritten = true
        capState.lastTombstoneDrops = capState.droppedEntries
        capState.bytesWritten += admitBytes + Buffer.byteLength(tombLine, 'utf8')
      } catch {
        // Count the admitted prefix as dropped too — we can't know whether
        // the failed append landed partially, and over-reporting drops is the
        // honest direction for a forensic marker.
        capState.droppedEntries += admitCount
      }
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
        `tombstone ${capState.tombstoneWritten ? 'written' : 'write FAILED (will retry)'}, ` +
        'dropping further appends this run',
      )
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
