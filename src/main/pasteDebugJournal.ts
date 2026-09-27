// Per-paste debug-event writer.
//
// Mirror of `src/main/dictationJournal.ts` from PR #68. Same 100 ms
// drain cadence, same mkdir-on-first-write trick, same "process owns
// the writer until quit, flushAll on before-quit" lifecycle. The two
// files are deliberately near-duplicates; a shared
// `BatchedJsonlWriter` is YAGNI until a third caller shows up.
//
// One file per paste-press:
//   <userData>/paste-debug/<pasteId>.paste.jsonl
//
// `pasteId` is a renderer-minted UUID stamped at the moment Enter is
// observed in the composer keydown handler. Keying the file on it
// rather than on, say, the sessionId guarantees that every paste —
// including ones that never reach the PTY — has its own file. That
// matters for the "first Enter does nothing" bug we are chasing: a
// dropped paste won't share a file with the eventual successful one
// after the user presses Enter again.
//
// Privacy contract:
//   * file mode 0o600, dir mode 0o700
//   * never log raw PTY bytes — callers send sha8 + byte count
//   * composer text head (truncated 240 chars) IS logged; the whole
//     point is to see what reached Claude vs. what the user typed
//   * file is local user-private; no network surface
//
// Disk-pressure contract:
//   * `pruneOldPasteDebugLogs()` runs at startup; 14-day retention
//   * a file per paste × hundreds of pastes/day adds up; without
//     pruning we'd grow forever

import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  stat,
  unlink,
} from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { app } from 'electron'

import type {
  PasteDebugEvent,
  PasteDebugEventInput,
  PasteDebugSession,
} from '@preload/api/types.js'

const FLUSH_INTERVAL_MS = 100

// Bound on lines held while appends keep failing (review of #1417, round 2).
// A paste logs tens of lines; a thousand is many pastes' worth of retries.
const MAX_QUEUED_LINES = 1000

const PRUNE_AFTER_MS = 14 * 24 * 60 * 60 * 1000

export class PasteDebugJournal {
  private queue: string[] = []
  private timer: NodeJS.Timeout | null = null
  private ensuredDir = false
  // The append currently writing, if any (review of #1417, b and c). The old
  // `draining` boolean made a second drain return at once, so flush() on a
  // writer whose timer drain was mid-append resolved before that append
  // landed: an evicted writer then escaped the shutdown drain and a quit could
  // lose its events. flush() now joins this promise, then writes the rest.
  private inFlight: Promise<void> | null = null
  // Lines dropped because the queue hit MAX_QUEUED_LINES while appends kept
  // failing; reported as one ERROR line once a write succeeds.
  private dropped = 0
  private sessionStartedAtMs: number | null = null

  constructor(
    private readonly filePath: string,
    private readonly options: {
      appendFile?: typeof appendFile
      // A previous writer for the same file whose final flush is still
      // landing (an evicted paste that is written to again). This writer's
      // first append waits for it, so the file keeps event order: the reader
      // takes a session's start from its first line.
      after?: Promise<void>
    } = {},
  ) {}

  append(input: PasteDebugEventInput): void {
    const now = Date.now()
    if (this.sessionStartedAtMs === null) this.sessionStartedAtMs = now
    const event: PasteDebugEvent = {
      ts: now,
      tMs: now - this.sessionStartedAtMs,
      ...input,
    }
    this.queue.push(JSON.stringify(event) + '\n')
    this.scheduleDrain()
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    for (;;) {
      if (this.inFlight) {
        // A joined drain that failed put its batch back in the queue (see
        // drain), so the next pass retries it and THIS flush reports the
        // outcome of that retry. It never resolves over a lost batch (review
        // of #1417, round 2, c).
        await this.inFlight.catch(() => {})
        continue
      }
      if (this.queue.length === 0) return
      await this.drain()
    }
  }

  private scheduleDrain(): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      // No caller awaits the timer: without this catch a failed append was an
      // unhandled rejection in the main process (review of #1417, round 2, c).
      // The batch is already back in the queue; the next append or flush
      // retries it.
      this.drain().catch(error => { console.warn('[pasteDebugJournal] append failed; will retry:', error) })
    }, FLUSH_INTERVAL_MS)
  }

  private drain(): Promise<void> {
    if (this.inFlight) return this.inFlight
    if (this.queue.length === 0) return Promise.resolve()
    const lines = this.queue.splice(0)
    const dropped = this.dropped
    const batch = (dropped ? this.droppedLine(dropped) : '') + lines.join('')
    const writing = this.appendRaw(batch).then(
      () => {
        this.dropped -= dropped
        // Lines appended while this write was in flight: their timer found the
        // write busy and joined it, so drain them now. Only after SUCCESS: after
        // a failure the next append or flush retries, instead of a dead disk
        // being hammered every 100 ms.
        if (this.queue.length > 0 && !this.timer) this.scheduleDrain()
      },
      (error: unknown) => {
        // A failed append used to drop its batch for good (review of #1417,
        // round 2, a, b, c). Put it back IN FRONT, so order holds and the next
        // drain retries it, but bounded: a disk that keeps failing must not
        // turn this into unbounded memory (#1278 is about exactly that).
        this.queue.unshift(...lines)
        const excess = this.queue.length - MAX_QUEUED_LINES
        if (excess > 0) {
          this.queue.splice(0, excess)
          this.dropped += excess
        }
        throw error
      },
    ).finally(() => {
      this.inFlight = null
    })
    this.inFlight = writing
    return writing
  }

  private droppedLine(lines: number): string {
    const now = Date.now()
    const event: PasteDebugEvent = {
      ts: now,
      tMs: this.sessionStartedAtMs === null ? 0 : now - this.sessionStartedAtMs,
      layer: 'ERROR',
      event: 'journal:dropped-lines',
      data: { lines },
    }
    return JSON.stringify(event) + '\n'
  }

  private async appendRaw(content: string): Promise<void> {
    if (this.options.after) await this.options.after.catch(() => {})
    const append = this.options.appendFile ?? appendFile
    try {
      await append(this.filePath, content, { mode: 0o600 })
    } catch {
      if (!this.ensuredDir) {
        await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 })
        this.ensuredDir = true
        await append(this.filePath, content, { mode: 0o600 })
      } else {
        throw new Error(`paste-debug append failed for ${this.filePath}`)
      }
    }
  }
}

/**
 * How many paste writers the registry keeps (#1278), the same bound and
 * eviction as dictationJournal's MAX_OPEN_JOURNALS (#1276). A paste id is a
 * fresh renderer UUID that is never reused, and dispose() has no caller, so a
 * long-running app kept one writer (and its queue) per paste forever. A paste
 * logs for a second or two around one Enter, so evicting the oldest of 64 never
 * touches a live one in practice; if it ever did, get() just opens a new writer
 * that appends to the same file.
 */
const MAX_OPEN_JOURNALS = 64

export class PasteDebugJournalRegistry {
  private journals = new Map<string, PasteDebugJournal>()
  /** Flushes started by dispose(), until they settle; see flushAll. */
  private readonly disposing = new Set<Promise<void>>()
  /** The same flushes by paste id, so a re-created writer appends after them. */
  private readonly disposingById = new Map<string, Promise<void>>()

  constructor(private readonly options: { appendFile?: typeof appendFile } = {}) {}

  get size(): number {
    return this.journals.size
  }

  get(pasteId: string): PasteDebugJournal {
    let j = this.journals.get(pasteId)
    if (!j) {
      j = new PasteDebugJournal(pasteDebugLogPath(pasteId), { ...this.options, after: this.disposingById.get(pasteId) })
      this.journals.set(pasteId, j)
      // Insertion order is age: evict the oldest paste (flushing it first),
      // never the one just asked for.
      while (this.journals.size > MAX_OPEN_JOURNALS) {
        const oldest = this.journals.keys().next().value
        if (oldest === undefined || oldest === pasteId) break
        this.dispose(oldest)
      }
    }
    return j
  }

  async flushAll(): Promise<void> {
    const drains = [...this.journals.values()].map(j =>
      j.flush().catch(err => {
        console.warn('[pasteDebugJournal] flush error:', err)
      }),
    )
    // An evicted writer is no longer in the map, but its final flush belongs
    // to the shutdown drain too, or its queued events are lost on quit.
    await Promise.all([...drains, ...this.disposing])
  }

  dispose(pasteId: string): void {
    const j = this.journals.get(pasteId)
    if (!j) return
    const flushing = j.flush().catch(err => {
      console.warn('[pasteDebugJournal] dispose flush error:', err)
    })
    this.disposing.add(flushing)
    this.disposingById.set(pasteId, flushing)
    void flushing.finally(() => {
      this.disposing.delete(flushing)
      if (this.disposingById.get(pasteId) === flushing) this.disposingById.delete(pasteId)
    })
    this.journals.delete(pasteId)
  }
}

export function pasteDebugLogPath(pasteId: string): string {
  return join(
    app.getPath('userData'),
    'paste-debug',
    `${pasteId}.paste.jsonl`,
  )
}

// Read the N most-recently-modified paste journals, newest first, for the
// dev-debug ClaudePasteDetection module (#90). This is the read side of the
// write-only journal: the renderer module surfaces issued→detected latency and
// stuck-submit outcomes from these files.
//
// Tolerant by construction: a journal may be mid-append while we read it (the
// 100ms drain is asynchronous), so a trailing partial line is normal — we skip
// any line that fails to parse rather than throwing. A debug panel must never
// crash on its own diagnostic data.
export async function readRecentPasteSessions(
  limit = 30,
): Promise<PasteDebugSession[]> {
  const dir = join(app.getPath('userData'), 'paste-debug')
  let names: string[]
  try {
    names = (await readdir(dir)).filter(n => n.endsWith('.paste.jsonl'))
  } catch {
    // Dir is created lazily on the first paste — absence just means
    // "no submits recorded yet", not an error.
    return []
  }

  const withMtime = await Promise.all(
    names.map(async name => {
      try {
        return { name, mtime: (await stat(join(dir, name))).mtimeMs }
      } catch {
        return { name, mtime: 0 }
      }
    }),
  )
  withMtime.sort((a, b) => b.mtime - a.mtime)

  const out: PasteDebugSession[] = []
  for (const { name, mtime } of withMtime.slice(0, limit)) {
    const pasteId = name.replace(/\.paste\.jsonl$/, '')
    let events: PasteDebugEvent[] = []
    try {
      const raw = await readFile(join(dir, name), 'utf8')
      events = raw
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean)
        .map(l => {
          try {
            return JSON.parse(l) as PasteDebugEvent
          } catch {
            return null
          }
        })
        .filter((e): e is PasteDebugEvent => e !== null)
    } catch {
      // Unreadable file (deleted between readdir and read, perms): emit an
      // empty session so the pasteId still shows rather than vanishing.
    }
    out.push({ pasteId, startedAt: events[0]?.ts ?? mtime, events })
  }
  return out
}

export async function pruneOldPasteDebugLogs(): Promise<void> {
  const dir = join(app.getPath('userData'), 'paste-debug')
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return
  }
  const cutoff = Date.now() - PRUNE_AFTER_MS
  for (const name of entries) {
    if (!name.endsWith('.paste.jsonl')) continue
    const full = join(dir, name)
    try {
      const s = await stat(full)
      if (s.mtimeMs < cutoff) await unlink(full)
    } catch {
      // ignore
    }
  }
}
