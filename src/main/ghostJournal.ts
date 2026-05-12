// Disk writer for ghost entries.
//
// Ghost entries are minted, updated, superseded, and orphaned in the
// renderer (via agent-transcript-parser + `src/renderer/src/workspace/ghosts.ts`).
// This file handles the durable side: append each produced ghost to
// an Agent Code-owned JSONL file so the live view survives a crash, a
// window reload, or an Electron restart.
//
// See docs/design/ghost-system.md for the canonical explanation
// of the ghost subsystem — what it does, when ghosts surface in
// the rendered feed, and why this file exists at all. DO NOT
// change the persistence model (one file per session, append-
// only, 100 ms batch) without re-reading that doc; resume + the
// reduceGhostLog last-write-wins rule depend on it.
//
// -----------------------------------------------------------------------------
// Why a separate file and not upstream's JSONL
// -----------------------------------------------------------------------------
//
// We do NOT write into `~/.claude/projects/<proj>/<sid>.jsonl` or
// `~/.codex/sessions/.../rollout-*.jsonl`. Those belong to the CLI
// and are actively written by its own batched queue; two writers on
// the same file is a lost-write / torn-line disaster. Native parsers
// also do not need to see our ghosts — ghosts are an Agent Code concern.
//
// Our ghost log sits under `app.getPath('userData')` which is the
// standard Electron-managed profile dir (macOS:
// `~/Library/Application Support/Agent Code`). One file per sessionId:
//
//   <userData>/ghost-logs/<sessionId>.ghost.jsonl
//
// -----------------------------------------------------------------------------
// Why this file contains no atp logic
// -----------------------------------------------------------------------------
//
// `GhostEntry` is a plain JSON object by the time it arrives here.
// The creating / updating / superseding / orphaning all happen in
// the renderer. This process is a mail clerk: JSON in, bytes on
// disk. The only import from atp is the `GhostEntry` type for
// static safety — it disappears at runtime.
//
// -----------------------------------------------------------------------------
// Why 100 ms batching
// -----------------------------------------------------------------------------
//
// Mirrors upstream Claude Code's own transcript batch interval in
// `claude-code-src/full/utils/sessionStorage.ts` (`FLUSH_INTERVAL_MS = 100`).
// Per-entry fsync during streaming would be tens of writes per second
// for a single fast turn across every pane; batching collapses that
// into one append-per-100ms-per-session. The trade-off — up to 100 ms
// of data loss on crash — is acceptable because ghost is provisional
// by definition and the authoritative CLI JSONL survives independently.

import { createReadStream } from 'node:fs'
import { appendFile, mkdir } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { dirname, join } from 'node:path'
import { app } from 'electron'

import { isGhost, type GhostEntry } from 'agent-transcript-parser/ghost'

/**
 * Flush interval matches upstream Claude's batcher. Anything shorter
 * just burns syscalls; anything longer risks visibly delayed writes
 * during slow streams.
 */
const FLUSH_INTERVAL_MS = 100

/**
 * Append-only writer for a single session's ghost log. Not shared
 * across sessions — use `GhostJournalRegistry` below for that.
 *
 * Construct with a full path; the writer will create parent
 * directories on first write. No lifecycle teardown: the process
 * owns its writer until app quit, when `flushAll()` drains every
 * queue before `app.exit`.
 */
export class GhostJournal {
  private queue: string[] = []
  private timer: NodeJS.Timeout | null = null
  private ensuredDir = false
  /**
   * Guards against overlapping drains. `scheduleDrain` sets the timer
   * and nulls it inside the callback BEFORE awaiting `drain()`, so in
   * theory a new `append` could schedule a second drain while the
   * first is still flushing. This boolean short-circuits that. On
   * macOS HFS+ / APFS `appendFile` serializes at the FS level anyway,
   * but relying on that is implementation-defined.
   */
  private draining = false

  constructor(private readonly filePath: string) {}

  /**
   * Enqueue one ghost for the next drain. Returns immediately — the
   * actual disk write is up to 100 ms later. Callers that need a
   * durability barrier should call `flush()`.
   */
  append(ghost: GhostEntry): void {
    this.queue.push(JSON.stringify(ghost) + '\n')
    this.scheduleDrain()
  }

  /**
   * Force a drain and wait for it. Used on shutdown to guarantee
   * every queued ghost reaches disk before `app.exit`, and by
   * tests that need deterministic on-disk state.
   */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    await this.drain()
  }

  private scheduleDrain(): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.drain()
    }, FLUSH_INTERVAL_MS)
  }

  private async drain(): Promise<void> {
    if (this.draining) return
    if (this.queue.length === 0) return
    this.draining = true
    try {
      const batch = this.queue.splice(0).join('')
      await this.appendRaw(batch)
    } finally {
      this.draining = false
    }
    // A write that arrived during the drain may have armed the timer;
    // if not, arm it now so late arrivals get picked up.
    if (this.queue.length > 0 && !this.timer) this.scheduleDrain()
  }

  private async appendRaw(content: string): Promise<void> {
    try {
      await appendFile(this.filePath, content, { mode: 0o600 })
    } catch {
      // Directory creation only needed on first-ever write for this
      // session. After it succeeds once, future appends hit the file
      // directly. Duplicating the try/catch here (rather than
      // pre-checking) saves a stat on every drain; failure path runs
      // at most once per session.
      if (!this.ensuredDir) {
        await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 })
        this.ensuredDir = true
        await appendFile(this.filePath, content, { mode: 0o600 })
      } else {
        // Already ensured the dir — re-throw so the caller's log
        // captures the real fs error. Swallowing here would silently
        // lose ghost writes.
        throw new Error(`ghost append failed for ${this.filePath}`)
      }
    }
  }
}

/**
 * Keeps one `GhostJournal` per sessionId. Built lazily — a session
 * that never produces a ghost never creates a writer or file.
 */
export class GhostJournalRegistry {
  private journals = new Map<string, GhostJournal>()

  get(sessionId: string): GhostJournal {
    let j = this.journals.get(sessionId)
    if (!j) {
      j = new GhostJournal(ghostLogPath(sessionId))
      this.journals.set(sessionId, j)
    }
    return j
  }

  /**
   * Drain every active session's queue. Called during `before-quit`
   * so no ghost write is lost to a clean shutdown. Errors on one
   * session do not abort the others.
   */
  async flushAll(): Promise<void> {
    const drains = [...this.journals.values()].map(j =>
      j.flush().catch(err => {
        console.warn('[ghostJournal] flush error:', err)
      }),
    )
    await Promise.all(drains)
  }

  /**
   * Drop a session's writer. Called when a session is killed so we
   * don't hold a closed-tab file open indefinitely. The underlying
   * file is left intact on disk — read-back on resume still works.
   */
  dispose(sessionId: string): void {
    const j = this.journals.get(sessionId)
    if (!j) return
    // Fire-and-forget flush; next write to this session will mint a
    // fresh writer that targets the same file.
    void j.flush().catch(err => {
      console.warn('[ghostJournal] dispose flush error:', err)
    })
    this.journals.delete(sessionId)
  }
}

/**
 * Read the ghost log for a session and return only the compact final
 * ghost state that the renderer needs on bootstrap.
 *
 * WHY this streams + reduces in main instead of returning raw JSONL:
 *   The original implementation did `readFile(..., 'utf8')`, split
 *   the entire file, parsed every line into an array, and then sent
 *   that full array over IPC so the renderer could reduce it. That
 *   shape was fine while ghost logs were KB-sized. It became a main-
 *   process OOM hazard once real user state accumulated multi-100 MB
 *   logs: on 2026-05-11 this machine had `ghost-logs/` at 2.1 GB,
 *   with individual session files at 169 MB, 156 MB, 129 MB, etc.
 *   Restoring several tmux-backed sessions caused main to allocate
 *   the raw string, the split line array, tens of thousands of parsed
 *   objects, and the IPC clone all at once. The crash log showed V8
 *   dying around a 1.2 GB old-space cap before the old heap watchdog's
 *   fixed 3 GB threshold could even trip.
 *
 *   The append-only ghost log's contract is last-write-wins by
 *   `(uuid, _atp.updatedAt)`, with equal timestamps resolved by later
 *   file order. We can preserve that contract while holding only one
 *   final object per uuid in memory. Superseded ghosts are dropped
 *   before returning because Agent Code imports `reduceGhostLogSansSuperseded`
 *   on the renderer side for this same bootstrap path; doing the drop
 *   here avoids shipping forensic-only entries across IPC.
 *
 * Missing files and malformed tail lines are not errors. A missing
 * file just means no ghosts were ever written for this session; a
 * malformed line usually means the app crashed mid-append and the
 * earlier valid JSONL lines are still useful.
 */
export async function readGhostLog(sessionId: string): Promise<GhostEntry[]> {
  const path = ghostLogPath(sessionId)
  const current = new Map<string, GhostEntry>()
  const stream = createReadStream(path, { encoding: 'utf8' })
  stream.on('error', () => {
    // Swallow ENOENT and other read errors through the async iterator's
    // close path below. The reader is best-effort bootstrap state; a
    // missing/unreadable ghost log should never prevent session spawn.
  })
  const lines = createInterface({
    input: stream,
    crlfDelay: Infinity,
  })

  try {
    for await (const line of lines) {
      if (!line) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        continue
      }
      if (!isGhost(parsed)) continue
      const existing = current.get(parsed.uuid)
      if (!existing || parsed._atp.updatedAt >= existing._atp.updatedAt) {
        current.set(parsed.uuid, parsed)
      }
    }
  } catch {
    return []
  }

  for (const [uuid, ghost] of current) {
    if (ghost._atp.supersededBy !== undefined) current.delete(uuid)
  }
  return [...current.values()]
}

/**
 * Deterministic path resolver. Exported so the IPC handler and the
 * reader agree on the same location.
 */
export function ghostLogPath(sessionId: string): string {
  return join(app.getPath('userData'), 'ghost-logs', `${sessionId}.ghost.jsonl`)
}
