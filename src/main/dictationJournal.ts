// Per-dictation-session debug-event writer.
//
// Modelled on the former GhostJournal (removed 2026-09-25 with the on-disk
// ghost log; see storage/legacyGhostLogs.ts): same 100 ms drain
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

import { statSync } from 'node:fs'
import { appendFile, mkdir, readdir, stat, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { app } from 'electron'

import type { DictationDebugEvent, DictationDebugEventInput } from '@preload/api/types.js'

/**
 * Flush interval matches the former GhostJournal cadence (which itself mirrored
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
 * Per-file byte budget (#1276).
 *
 * WHY: the 14-day prune bounds how LONG files live, not how big one gets.
 * One press whose recorder ran 32.8 h (#1299) wrote a 1.196 GB file, and
 * 96 % of it was per-chunk and per-sample events: recorder:dataavailable,
 * the CHUNK layer, deepgram:chunk:*, deepgram:message and AUDIO_LEVEL
 * `sample`, each several times a second. Only 17 events in the whole file
 * were lifecycle. 16 MiB holds tens of minutes of full-detail capture,
 * far more than a normal press, and past it the lifecycle, error and stop
 * events still land, because those are what an investigation reads.
 */
const MAX_JOURNAL_BYTES = 16 * 1024 * 1024

/**
 * How many journals the registry keeps (#1276). A press id is a fresh UUID
 * that is never reused, and nothing disposed of them, so a long-running app
 * kept one writer per press forever. The oldest is flushed and evicted.
 */
const MAX_OPEN_JOURNALS = 64

/** The events that repeat per audio chunk or level sample; see
 *  MAX_JOURNAL_BYTES for the measured share. */
function isHighFrequency(input: DictationDebugEventInput): boolean {
  return input.layer === 'CHUNK'
    || input.event === 'sample'
    || input.event === 'recorder:dataavailable'
    || input.event.startsWith('deepgram:chunk:')
    || input.event === 'deepgram:message'
    // One per non-final transcript while Deepgram streams (#1301 review A);
    // `preview:final` and `committed` stay, they are what a reader needs.
    || (input.layer === 'TRANSCRIPT' && input.event === 'preview:interim')
}

/**
 * How often a post-budget summary line is written, in journal time (#1301
 * review C, steering q29). Dropping the high-frequency events outright hid
 * the very thing #1299 needs: in the recorded 1.2 GB press, chunks and
 * non-zero audio levels continued for ~26 h AFTER deepgram:close, and a
 * single "suppressed" marker at 25 min erased all of it. One summary line per
 * minute (~300 bytes) keeps that visible — counts per event, the time span,
 * the highest chunk index and the audio peaks — at ~430 KiB per day.
 */
const SUMMARY_INTERVAL_MS = 60_000

type SuppressedSummary = {
  sinceTMs: number
  counts: Record<string, number>
  maxPeak: number
  nonZeroPeaks: number
  /** Highest chunk index seen per `layer/event`: the renderer and main count
   *  from 0 while Deepgram counts from 1, so one merged maximum invented a
   *  chunk that never existed (#1301 review round 2). */
  lastChunkIndex: Record<string, number>
}

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
  /** Bytes this writer has accounted for (file + queue); the registry reads it
   *  when evicting, so a re-created writer keeps the budget even while this
   *  one's last write is still in flight (#1301 review round 2). */
  get accountedBytes(): number {
    return this.bytesQueued
  }
  /**
   * Wall-clock anchor for `tMs`. Latched on first append rather than
   * in the constructor — a session that never emits an event also
   * never creates a file, so the "started at" is the time of the
   * first real event, not the time the writer was registered.
   */
  private sessionStartedAtMs: number | null = null

  /** Bytes in the file plus bytes handed to the writer; see
   *  MAX_JOURNAL_BYTES. Starts at the file's size when the registry
   *  re-creates a writer for a press it had evicted, so the cap does not
   *  restart (#1301 review A/C). */
  private bytesQueued: number
  private suppressedHighFrequency = false
  private summary: SuppressedSummary | null = null

  constructor(
    private readonly filePath: string,
    private readonly options: {
      maxBytes?: number
      initialBytes?: number
      /** Test seam for a slow or blocked disk; production uses appendFile. */
      appendFile?: typeof appendFile
    } = {},
  ) {
    this.bytesQueued = options.initialBytes ?? 0
  }

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
    if (this.bytesQueued >= (this.options.maxBytes ?? MAX_JOURNAL_BYTES) && isHighFrequency(input)) {
      if (!this.suppressedHighFrequency) {
        // Say so once, in the file itself, so a reader knows the per-chunk
        // trail becomes per-minute summaries here by design.
        this.suppressedHighFrequency = true
        this.push({ ts: now, tMs: event.tMs, layer: 'META', event: 'journal:high-frequency-suppressed', data: { afterBytes: this.bytesQueued, summaryIntervalMs: SUMMARY_INTERVAL_MS } })
      }
      this.accumulate(input, event.tMs)
      if (event.tMs - this.summary!.sinceTMs >= SUMMARY_INTERVAL_MS) this.emitSummary(now, event.tMs)
      return
    }
    // A kept event (a close, an error, an outcome) lands AFTER the summary of
    // what came before it, so the file stays in time order.
    if (this.summary) this.emitSummary(now, event.tMs)
    this.push(event)
  }

  private accumulate(input: DictationDebugEventInput, tMs: number): void {
    const summary = this.summary ??= { sinceTMs: tMs, counts: {}, maxPeak: 0, nonZeroPeaks: 0, lastChunkIndex: {} }
    const key = `${input.layer}/${input.event}`
    summary.counts[key] = (summary.counts[key] ?? 0) + 1
    const data = input.data ?? {}
    if (typeof data.peak === 'number' && data.peak > 0) {
      summary.nonZeroPeaks += 1
      if (data.peak > summary.maxPeak) summary.maxPeak = data.peak
    }
    const index = typeof data.chunkIndex === 'number' ? data.chunkIndex : typeof data.pendingChunkIndex === 'number' ? data.pendingChunkIndex : null
    if (index !== null && (summary.lastChunkIndex[key] === undefined || index > summary.lastChunkIndex[key]!)) summary.lastChunkIndex[key] = index
  }

  private emitSummary(now: number, untilTMs: number): void {
    const summary = this.summary
    if (!summary) return
    this.summary = null
    this.push({ ts: now, tMs: untilTMs, layer: 'META', event: 'journal:high-frequency-summary', data: { ...summary, untilTMs } })
  }

  private push(event: DictationDebugEvent): void {
    const line = JSON.stringify(event) + '\n'
    this.bytesQueued += Buffer.byteLength(line)
    this.queue.push(line)
    this.scheduleDrain()
  }

  /**
   * Force a drain and wait for it. Used on shutdown to guarantee every
   * queued event reaches disk before `app.exit`.
   */
  async flush(): Promise<void> {
    // The tail since the last summary is exactly what a quit would lose.
    if (this.summary && this.sessionStartedAtMs !== null) this.emitSummary(Date.now(), Date.now() - this.sessionStartedAtMs)
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

  /**
   * Drains are CHAINED, not skipped (#1301 review round 2). The old guard
   * returned at once while a timed drain was writing, so a flush() during a
   * slow append resolved before that append landed: an eviction or a clean
   * quit could exit with the batch (and the summary in it) unwritten. Each
   * drain now waits for the one before it, and flush() awaits the chain.
   */
  private drainChain: Promise<void> = Promise.resolve()

  private drain(): Promise<void> {
    const next = this.drainChain.then(() => this.drainOnce())
    this.drainChain = next.catch(() => undefined)
    return next
  }

  private async drainOnce(): Promise<void> {
    if (this.queue.length === 0) return
    const batch = this.queue.splice(0).join('')
    await this.appendRaw(batch)
    // A write that arrived during the drain may have armed the timer;
    // if not, arm it now so late arrivals get picked up.
    if (this.queue.length > 0 && !this.timer) this.scheduleDrain()
  }

  private async appendRaw(content: string): Promise<void> {
    try {
      await (this.options.appendFile ?? appendFile)(this.filePath, content, { mode: 0o600 })
    } catch {
      // Directory-creation only needed on first-ever write for this
      // session. Once it succeeds, every subsequent append hits the
      // file directly. Same duplicated-try shape as the former GhostJournal —
      // pre-checking with `stat` would cost a syscall on every drain.
      if (!this.ensuredDir) {
        await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 })
        this.ensuredDir = true
        await (this.options.appendFile ?? appendFile)(this.filePath, content, { mode: 0o600 })
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
      const path = dictationDebugLogPath(debugSessionId)
      // An evicted writer's last write may still be in flight, so the file
      // can be smaller than what that writer accounted for; take the larger.
      const evicted = this.evictedBytes.get(debugSessionId) ?? 0
      j = new DictationDebugJournal(path, { initialBytes: Math.max(existingSize(path), evicted), appendFile: this.options.appendFile })
      this.journals.set(debugSessionId, j)
      // Insertion order is age: evict the oldest press (flushing it first),
      // never the one just asked for. See MAX_OPEN_JOURNALS.
      while (this.journals.size > MAX_OPEN_JOURNALS) {
        const oldest = this.journals.keys().next().value
        if (oldest === undefined || oldest === debugSessionId) break
        this.dispose(oldest)
      }
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
    // Writes started by eviction (dispose) belong to the shutdown drain too
    // (#1301 review A/B): the evicted writer is no longer in the map.
    await Promise.all([...drains, ...this.disposing])
  }

  /** Flushes started by dispose(), until they settle; see flushAll. */
  private readonly disposing = new Set<Promise<void>>()
  /** Accounted bytes of evicted writers whose final flush has not landed;
   *  see get(). Entries leave when that flush settles, so this stays small. */
  private readonly evictedBytes = new Map<string, number>()

  constructor(private readonly options: { appendFile?: typeof appendFile } = {}) {}

  get size(): number {
    return this.journals.size
  }

  dispose(debugSessionId: string): void {
    const j = this.journals.get(debugSessionId)
    if (!j) return
    this.evictedBytes.set(debugSessionId, j.accountedBytes)
    const flushing = j.flush().catch(err => {
      console.warn('[dictationJournal] dispose flush error:', err)
    })
    this.disposing.add(flushing)
    void flushing.finally(() => {
      this.disposing.delete(flushing)
      this.evictedBytes.delete(debugSessionId)
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

/** The journal's current size, so a writer re-created for an evicted press
 *  keeps its budget. Synchronous: it runs once per writer creation, and the
 *  registry's `get` is synchronous by contract. */
function existingSize(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

