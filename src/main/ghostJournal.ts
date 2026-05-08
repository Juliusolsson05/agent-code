// Disk writer for ghost entries.
//
// Ghost entries are minted, updated, superseded, and orphaned in the
// renderer (via agent-transcript-parser + `src/renderer/src/workspace/ghosts.ts`).
// This file handles the durable side: append each produced ghost to
// a cc-shell-owned JSONL file so the live view survives a crash, a
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
// also do not need to see our ghosts — ghosts are a cc-shell concern.
//
// Our ghost log sits under `app.getPath('userData')` which is the
// standard Electron-managed profile dir (macOS:
// `~/Library/Application Support/cc-shell`). One file per sessionId:
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

import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { app } from 'electron'

import type { GhostEntry } from 'agent-transcript-parser'

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
 * Read the full ghost log for a session. Returns parsed ghosts in
 * file order; caller folds them through atp's `reduceGhostLog` in
 * the renderer to get current state. A missing file is not an
 * error — no ghosts have been written for this session yet.
 */
export async function readGhostLog(sessionId: string): Promise<GhostEntry[]> {
  const path = ghostLogPath(sessionId)
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return []
  }
  const out: GhostEntry[] = []
  for (const line of raw.split('\n')) {
    if (!line) continue
    try {
      out.push(JSON.parse(line) as GhostEntry)
    } catch {
      // Skip malformed lines — a partial last line from a crash mid-
      // flush would land here. The rest of the file is still valid
      // JSONL and still renderable.
      continue
    }
  }
  return out
}

/**
 * Deterministic path resolver. Exported so the IPC handler and the
 * reader agree on the same location.
 */
export function ghostLogPath(sessionId: string): string {
  return join(app.getPath('userData'), 'ghost-logs', `${sessionId}.ghost.jsonl`)
}
