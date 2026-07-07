import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { SESSION_RECORDING_DIR } from '@main/storage/paths.js'

// One SessionRecorder = ONE self-contained recording folder.
//
// docs/rendering/session-recording-plan-2026-07.md §2-§4. Each recording
// gets its own directory `session-recordings/<recordingId>/` holding:
//   meta.json     — provider/session identity + start/end/counters
//   events.jsonl  — the append-only event stream (one line per event)
// The per-folder shape is a deliberate cleanup affordance: `rm -rf` one
// folder removes exactly one recording, nothing else (the user's ask).
//
// The writer is cloned from GhostJournal (src/main/ghostJournal.ts) — one
// file, JSON+'\n', 100 ms batched drain, overlapping-drain guard, dir
// created lazily on first write — because that writer already absorbed the
// #388 OOM lessons. Added here on top of the ghost pattern, because a
// CONTINUOUS recorder re-opens the exact #388 crash vector that a
// per-turn ghost log did not:
//   - BACKPRESSURE: a hard queue cap with drop-oldest + a counter, so a
//     runaway stream can never unbounded-buffer in memory (the thing that
//     took the heap 39MB→2554MB in incident #388).
//   - SIZE CAP + TOMBSTONE: once the events file passes a byte cap the
//     recorder stops appending events and writes a single tombstone line,
//     matching feedDebugLog's cap-not-rotate policy.
// Both are non-negotiable per the plan; retention (a budgeted
// debugRetention bucket) is the sibling slice.

// 100 ms mirrors GhostJournal / upstream Claude FLUSH_INTERVAL_MS — one
// append per 100 ms per recording, not per event.
const FLUSH_INTERVAL_MS = 100
// Drop-oldest threshold. 2000 pending lines is the journal-plan rulebook's
// cap; a healthy recorder drains every 100 ms so the queue is near-empty,
// and hitting 2000 means the disk can't keep up — shed the oldest rather
// than grow the heap.
const MAX_QUEUE = 2000
// Per-recording events-file byte cap. 128 MiB mirrors feedDebugLog's cap;
// past it we stop appending and tombstone (cap, never rotate).
const MAX_BYTES = 128 * 1024 * 1024

export type RecordingMeta = {
  v: 1
  recordingId: string
  sessionId: string
  provider: string
  providerSessionId: string | null
  cwd: string | null
  appVersion: string | null
  startedAtWall: number
  endedAtWall?: number
  eventCount?: number
  droppedCount?: number
  capped?: boolean
}

export class SessionRecorder {
  private readonly dir: string
  private readonly eventsPath: string
  private readonly startMono: number

  private queue: string[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private draining = false
  private ensuredDir = false

  private bytesWritten = 0
  private eventCount = 0
  private dropped = 0
  private capped = false
  private closed = false
  private tombstoned = false

  constructor(
    private meta: RecordingMeta,
    private readonly nowWall: () => number,
    private readonly nowMono: () => number,
  ) {
    this.dir = join(SESSION_RECORDING_DIR, meta.recordingId)
    this.eventsPath = join(this.dir, 'events.jsonl')
    this.startMono = this.nowMono()
    // Write meta.json eagerly so the recording FOLDER appears the instant
    // recording starts (the user sees it exists), and so a crash before any
    // event still leaves an identifiable recording. Fire-and-forget; the
    // events path lazily re-ensures the dir anyway.
    void this.writeMeta()
  }

  /**
   * Enqueue one event line. `t` is monotonic ms since recording start
   * (drives replay ordering); `wall` is Date.now() (injected as the fold
   * clock during replay so wall-clock-dependent fold behavior is
   * deterministic — plan §3). Returns immediately; the disk write is up to
   * 100 ms later.
   */
  record(channel: string, payload: unknown): void {
    if (this.closed || this.capped) return
    const line =
      JSON.stringify({
        t: Math.round(this.nowMono() - this.startMono),
        wall: this.nowWall(),
        ch: channel,
        payload,
      }) + '\n'
    this.enqueue(line)
    this.eventCount += 1
  }

  /**
   * Attach-Recording-Note marker (plan §7b). `__note` is a synthetic
   * channel outside the 9 real SessionFeed channels, so replay ignores it
   * for pipeline input while the triage/extraction tooling reads it. Two
   * phases: `reserved` (written instantly on invoke to pin the reaction
   * tick) then `filled` (the typed text). The reserved line alone survives
   * a crash and still flags the moment.
   */
  note(note: { id: string; status: 'reserved' | 'filled'; text?: string }): void {
    if (this.closed) return
    const line =
      JSON.stringify({
        t: Math.round(this.nowMono() - this.startMono),
        wall: this.nowWall(),
        ch: '__note',
        note,
      }) + '\n'
    // Notes bypass the size cap — they are tiny and are the whole point of a
    // long recording (you must be able to mark the bug even in a capped
    // file). They still respect the queue backpressure.
    this.enqueue(line)
  }

  private enqueue(line: string): void {
    this.queue.push(line)
    if (this.queue.length > MAX_QUEUE) {
      // Drop-oldest: shed the front so the heap can't grow unbounded when
      // the disk can't keep up. Count it; the count lands in meta.json and
      // as a tombstone so a replay knows the recording has a gap.
      const shed = this.queue.length - MAX_QUEUE
      this.queue.splice(0, shed)
      this.dropped += shed
    }
    this.scheduleDrain()
  }

  private scheduleDrain(): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.drain()
    }, FLUSH_INTERVAL_MS)
    this.timer.unref?.()
  }

  private async drain(): Promise<void> {
    if (this.draining || this.queue.length === 0) return
    this.draining = true
    try {
      const batch = this.queue.splice(0).join('')
      if (this.bytesWritten + batch.length > MAX_BYTES && !this.tombstoned) {
        // Cross the cap: write a final tombstone once and stop appending
        // events. Cap, never rotate (feedDebugLog policy).
        this.tombstoned = true
        this.capped = true
        const mark =
          JSON.stringify({
            t: Math.round(this.nowMono() - this.startMono),
            wall: this.nowWall(),
            ch: '__truncated',
            reason: 'size-cap',
            bytes: this.bytesWritten,
          }) + '\n'
        await this.appendRaw(mark)
      } else if (!this.capped) {
        await this.appendRaw(batch)
        this.bytesWritten += batch.length
      }
    } finally {
      this.draining = false
    }
    if (this.queue.length > 0 && !this.timer && !this.capped) this.scheduleDrain()
  }

  private async appendRaw(content: string): Promise<void> {
    try {
      await appendFile(this.eventsPath, content, { mode: 0o600 })
    } catch {
      if (!this.ensuredDir) {
        await mkdir(this.dir, { recursive: true, mode: 0o700 })
        this.ensuredDir = true
        await appendFile(this.eventsPath, content, { mode: 0o600 })
      } else {
        throw new Error(`session recording append failed for ${this.eventsPath}`)
      }
    }
  }

  private async writeMeta(): Promise<void> {
    try {
      await mkdir(this.dir, { recursive: true, mode: 0o700 })
      this.ensuredDir = true
    } catch {
      /* re-ensured lazily on first event append */
    }
    try {
      await writeFile(join(this.dir, 'meta.json'), JSON.stringify(this.meta, null, 1), {
        mode: 0o600,
      })
    } catch {
      /* non-fatal: the events stream is the source of truth; meta is a convenience */
    }
  }

  /** Force a drain and wait — used on shutdown and by tests. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    await this.drain()
  }

  /** Finalize: flush, then rewrite meta.json with end stats. Idempotent. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.flush()
    this.meta = {
      ...this.meta,
      endedAtWall: this.nowWall(),
      eventCount: this.eventCount,
      droppedCount: this.dropped,
      capped: this.capped,
    }
    await this.writeMeta()
  }
}
