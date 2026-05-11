// Per-dictation-session debug-event writer.
//
// Mirrors src/main/ghostJournal.ts deliberately: same 100 ms drain
// cadence, same mkdir-on-first-write trick, same "process owns the
// writer until quit, flushAll on before-quit" lifecycle. The two files
// are intentionally near-duplicates — refactoring them into a shared
// `BatchedJsonlWriter` is YAGNI until a third caller shows up, and the
// minor differences (the `tMs` anchor here, no read-back API) would
// leak into the abstraction anyway.
//
// One file per dictation press:
//   <userData>/dictation-debug/<debugSessionId>.dictation.jsonl
//
// The id is a renderer-minted UUID (`crypto.randomUUID()` in
// useComposerDictation), NOT the Deepgram stream id. The Deepgram id
// is null for the first ~180 ms of every press while we queue chunks
// locally to discard accidental taps — keying the file on it would
// drop every startup event, which is exactly the window where the
// failure modes we are debugging originate.
//
// -----------------------------------------------------------------------------
// Privacy contract
// -----------------------------------------------------------------------------
//
//   * file mode 0o600, dir mode 0o700 — files are user-private
//   * we never see raw audio bytes here — callers send `bytes` + `sha8`
//   * transcript text crosses through; it is user draft, file is local
//   * API keys never appear in payloads (callers send `hasApiKey: boolean`)
//
// If a future caller wants to log a Buffer/ArrayBuffer payload, push back:
// that's a privacy regression. Add a hash and a length instead.
//
// -----------------------------------------------------------------------------
// Disk-pressure contract
// -----------------------------------------------------------------------------
//
// `pruneOldDictationDebugLogs()` runs at app startup; default retention is
// 14 days. A FAT file per press × dozens of presses per day adds up;
// without pruning we'd grow forever. The prune is best-effort — failure
// must NOT block boot. Lowering this hides failure histories from future
// investigations, so 14 days is the explicit floor unless we add an
// in-app viewer that lets users grow the budget consciously.

import { appendFile, mkdir, readdir, stat, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { app } from 'electron'

import type { DictationDebugEvent, DictationDebugEventInput } from '@preload/api/types.js'

/**
 * Flush interval matches the ghostJournal cadence (which itself mirrors
 * upstream Claude's transcript batcher). Anything shorter just burns
 * syscalls on hot streaming paths; anything longer risks tail events
 * never reaching disk if the app exits unexpectedly.
 */
const FLUSH_INTERVAL_MS = 100

/**
 * 14 days. Tuned so a normal user keeps yesterday's failed session
 * recoverable but doesn't accumulate a year of mic-recording metadata.
 * Tune with care — lowering this hides failure histories from future
 * investigations; raising it grows disk usage without a viewer.
 */
const PRUNE_AFTER_MS = 14 * 24 * 60 * 60 * 1000

/**
 * Append-only writer for a single dictation session's debug log. The
 * companion registry below keeps one per debugSessionId.
 *
 * Construct with a full path; the writer creates parent directories
 * on first write. No lifecycle teardown: the process owns its writer
 * until app quit, when `flushAll()` drains every queue before
 * `app.exit`.
 */
export class DictationDebugJournal {
  private queue: string[] = []
  private timer: NodeJS.Timeout | null = null
  private ensuredDir = false
  /**
   * Same overlap guard as GhostJournal: `scheduleDrain` arms a timer
   * and nulls it inside the callback before awaiting `drain()`, so a
   * new `append` arriving during the drain could in principle schedule
   * a second drain. This boolean short-circuits that. macOS APFS
   * serialises `appendFile` at the FS level, but relying on that is
   * implementation-defined.
   */
  private draining = false
  /**
   * Wall-clock anchor for `tMs`. Latched on first append rather than
   * in the constructor — a session that never emits an event also
   * never creates a file, so the "started at" is the time of the
   * first real event, not the time the writer was registered.
   */
  private sessionStartedAtMs: number | null = null

  constructor(private readonly filePath: string) {}

  /**
   * Enqueue one event for the next drain. Returns immediately; the
   * actual disk write is up to 100 ms later. The wall-clock `ts` is
   * stamped here so events in the file are in the order they were
   * produced, even if multiple drains queue while one is in flight.
   */
  append(input: DictationDebugEventInput): void {
    const now = Date.now()
    if (this.sessionStartedAtMs === null) this.sessionStartedAtMs = now
    const event: DictationDebugEvent = {
      ts: now,
      tMs: now - this.sessionStartedAtMs,
      ...input,
    }
    this.queue.push(JSON.stringify(event) + '\n')
    this.scheduleDrain()
  }

  /**
   * Force a drain and wait for it. Used on shutdown to guarantee every
   * queued event reaches disk before `app.exit`.
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
      // Directory-creation only needed on first-ever write for this
      // session. Once it succeeds, every subsequent append hits the
      // file directly. Same duplicated-try shape as GhostJournal —
      // pre-checking with `stat` would cost a syscall on every drain.
      if (!this.ensuredDir) {
        await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 })
        this.ensuredDir = true
        await appendFile(this.filePath, content, { mode: 0o600 })
      } else {
        // Already ensured the dir — re-throw so the caller's logs see
        // the real fs error. Swallowing would silently lose events.
        throw new Error(`dictation-debug append failed for ${this.filePath}`)
      }
    }
  }
}

/**
 * Keeps one `DictationDebugJournal` per debugSessionId. Built lazily —
 * a session that never produces an event never creates a writer or
 * file. The registry is the only place that knows file paths; callers
 * just `get(id).append(...)`.
 */
export class DictationDebugJournalRegistry {
  private journals = new Map<string, DictationDebugJournal>()

  get(debugSessionId: string): DictationDebugJournal {
    let j = this.journals.get(debugSessionId)
    if (!j) {
      j = new DictationDebugJournal(dictationDebugLogPath(debugSessionId))
      this.journals.set(debugSessionId, j)
    }
    return j
  }

  /**
   * Drain every active session's queue. Called during `before-quit`
   * so no event is lost to a clean shutdown. Errors on one session
   * do not abort the others.
   */
  async flushAll(): Promise<void> {
    const drains = [...this.journals.values()].map(j =>
      j.flush().catch(err => {
        console.warn('[dictationJournal] flush error:', err)
      }),
    )
    await Promise.all(drains)
  }

  dispose(debugSessionId: string): void {
    const j = this.journals.get(debugSessionId)
    if (!j) return
    void j.flush().catch(err => {
      console.warn('[dictationJournal] dispose flush error:', err)
    })
    this.journals.delete(debugSessionId)
  }
}

/**
 * Deterministic path resolver. Exported so callers and the prune
 * routine agree on the same location.
 */
export function dictationDebugLogPath(debugSessionId: string): string {
  return join(
    app.getPath('userData'),
    'dictation-debug',
    `${debugSessionId}.dictation.jsonl`,
  )
}

/**
 * Best-effort prune of files older than `PRUNE_AFTER_MS`. Runs on app
 * startup, NEVER throws — a broken prune must not block boot. Failure
 * here only costs disk; the journal itself still works.
 */
export async function pruneOldDictationDebugLogs(): Promise<void> {
  const dir = join(app.getPath('userData'), 'dictation-debug')
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return // dir doesn't exist yet — nothing to prune
  }
  const cutoff = Date.now() - PRUNE_AFTER_MS
  for (const name of entries) {
    if (!name.endsWith('.dictation.jsonl')) continue
    const full = join(dir, name)
    try {
      const s = await stat(full)
      if (s.mtimeMs < cutoff) await unlink(full)
    } catch {
      // Ignore — file might have been removed concurrently, or the
      // filesystem is misbehaving. We tried.
    }
  }
}
