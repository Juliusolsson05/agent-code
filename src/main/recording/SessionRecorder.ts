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
// Serialization is CPU work, not IO. A recording with cumulative semantic
// snapshots can spend many milliseconds JSON-stringifying one 100 ms batch,
// so yielding by wall-clock budget matters more than an arbitrary item count:
// ten tiny screen events and one multi-MB tool-input event are not comparable.
const SERIALIZE_SLICE_BUDGET_MS = 8

type PendingRecordingLine = {
  kind: 'event' | 'note' | 'truncated'
  value: Record<string, unknown>
}

function yieldToMainLoop(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

export type RecordingMeta = {
  v: 1
  /** Discriminator so a bare meta.json is self-identifying (plan §3). */
  kind: 'session-recording'
  /** Redaction state of THIS on-disk recording. Live local recordings are
   *  unredacted ('none'); the extraction script writes 'full-text-capped' /
   *  'structure-only' into the derived fixture's meta (plan §3/§5). */
  redaction: 'none'
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

  // WHY queue structured values rather than ready-made JSON strings:
  // `record()` is called by the passive outbound observer immediately after
  // BrowserWindow.send. JSON.stringify used to run synchronously there, so an
  // opt-in diagnostic could delay the next main-loop turn for every growing
  // semantic payload. The writer already owns a 100 ms async drain; keeping the
  // immutable outbound payload until that drain moves serialization off the IPC
  // delivery stack and lets us time-slice it below. Callers must continue to
  // treat sent payloads as immutable—the same invariant Electron's send path
  // already relies on while it structured-clones the arguments.
  private queue: PendingRecordingLine[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private draining = false
  // Handle to the CURRENTLY-RUNNING drain, or null when idle. This exists so
  // that a caller who arrives while a drain is in flight can await THAT drain
  // rather than either no-opping or racing a second one. Before this existed,
  // drain() early-returned an already-resolved promise when this.draining was
  // true, so a flush() overlapping an in-flight drain saw "nothing to do" and
  // returned before the tail (session:exit, trailing notes) reached disk — the
  // #442 lost-tail bug. Invariant: non-null iff this.draining is true.
  private drainPromise: Promise<void> | null = null
  private ensuredDir = false

  private bytesWritten = 0
  private eventCount = 0
  private dropped = 0
  private capped = false
  private closed = false
  private tombstoned = false
  // FIFO serialization for meta.json writes. Every writeMeta() snapshots
  // this.meta synchronously and chains its actual disk write onto this promise,
  // so writes can never reorder or overlap. Without it the constructor's and
  // refreshIdentity's fire-and-forget writes could land AFTER close()'s final
  // write and clobber endedAtWall/eventCount/capped — the #442 meta race.
  // Invariant: the LAST writeMeta() call before we stop is close()'s, so its
  // snapshot (enqueued last, FIFO) is guaranteed to be the final bytes on disk.
  private metaChain: Promise<void> = Promise.resolve()

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

  /** The recording's folder id (== the last path segment of its dir). Exposed
   *  so SessionRecorderManager can report live recording dirs to retention
   *  (liveRecordingDirs) without duplicating the id→path derivation. Read-only;
   *  meta itself stays private. */
  get recordingId(): string {
    return this.meta.recordingId
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
    this.enqueue({
      kind: 'event',
      value: {
        t: Math.round(this.nowMono() - this.startMono),
        wall: this.nowWall(),
        ch: channel,
        payload,
      },
    })
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
    this.enqueue({
      kind: 'note',
      value: {
        t: Math.round(this.nowMono() - this.startMono),
        wall: this.nowWall(),
        ch: '__note',
        note,
      },
    })
    // Notes bypass the size cap — they are tiny and are the whole point of a
    // long recording (you must be able to mark the bug even in a capped
    // file). They still respect the queue backpressure.
  }

  private enqueue(line: PendingRecordingLine): void {
    this.queue.push(line)
    if (this.queue.length > MAX_QUEUE) {
      // Drop-oldest: shed the front so the heap can't grow unbounded when
      // the disk can't keep up. Count it (→ meta.json droppedCount) AND drop
      // a __truncated marker at the gap position so a replay sees exactly
      // where the stream has a hole (plan §4 — the counter must be visible in
      // the file, not only in meta).
      const shed = this.queue.length - MAX_QUEUE
      this.queue.splice(0, shed)
      this.dropped += shed
      this.queue.unshift(
        {
          kind: 'truncated',
          value: {
            t: Math.round(this.nowMono() - this.startMono),
            wall: this.nowWall(),
            ch: '__truncated',
            reason: 'queue-drop',
            dropped: shed,
          },
        },
      )
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

  // Thin re-entrancy gate around doDrain(). Kept separate from the async body
  // so that a caller arriving mid-drain gets the IN-FLIGHT promise back (to
  // await) instead of a fresh already-resolved one. The old code was a single
  // `async drain()` whose `if (this.draining) return` handed back a resolved
  // promise — awaiting it was a no-op, which is exactly how flush() used to
  // skip the tail (#442). Returning this.drainPromise makes the await real.
  private drain(): Promise<void> {
    if (this.draining) return this.drainPromise ?? Promise.resolve()
    if (this.queue.length === 0) return Promise.resolve()
    this.draining = true
    // Store the handle BEFORE returning so overlapping callers and flush() can
    // observe/await it. Cleared in the .finally so this.drainPromise is null
    // exactly when this.draining flips back to false (the field invariant).
    this.drainPromise = this.doDrain().finally(() => {
      this.draining = false
      this.drainPromise = null
    })
    return this.drainPromise
  }

  private async doDrain(): Promise<void> {
    // Take the pending lines as an ARRAY (not a pre-joined string). We need to
    // (a) partition notes from events and (b) know how many real event lines a
    // capping batch drops — both impossible once the batch is one blob.
    const pending = this.queue.splice(0)

    // Always cross an event-loop boundary before serialization. `flush()` is
    // also called from the session:exit observer, and without this first yield
    // a final large batch would still run synchronously inside
    // sendToMainWindow despite the normal 100 ms timer path being deferred.
    await yieldToMainLoop()

    // Partition. `__note` lines bypass the size cap entirely: a note is the
    // whole point of a long recording (you must still be able to mark the bug
    // in a file that has already capped), and its bytes must NOT count toward
    // bytesWritten or they'd push a near-cap file over and suppress themselves.
    // Real event lines remain subject to the cap. Before this split we join()'d
    // everything and made the cap decision on the whole batch, which silently
    // dropped any notes queued in the capping batch and mis-counted note bytes
    // (findings 5 / C8). The structured queue gives us an exact discriminator;
    // the old implementation had to sniff JSON text here because enqueue() had
    // already serialized every value on the IPC call stack.
    const notes: string[] = []
    const events: string[] = []
    let sliceStartedAt = performance.now()
    for (const pendingLine of pending) {
      let line: string
      try {
        line = `${JSON.stringify(pendingLine.value)}\n`
      } catch {
        // Electron's SessionFeed payloads are JSON-shaped, but the recorder is
        // diagnostic code at a generic outbound seam. If a future channel
        // accidentally introduces a cycle or BigInt, one bad payload must not
        // reject the background drain forever. Preserve an explicit replay gap
        // (and the original event timestamp) instead of the old synchronous
        // observer behavior, which merely threw and was silently swallowed.
        this.dropped += 1
        line = `${JSON.stringify({
          t: pendingLine.value.t,
          wall: pendingLine.value.wall,
          ch: '__truncated',
          reason: 'serialize-error',
          dropped: 1,
        })}\n`
      }
      if (pendingLine.kind === 'note') notes.push(line)
      else events.push(line)

      // WHY yield by elapsed time: payload sizes grow cumulatively during tool
      // input, so "N records per turn" provides no responsiveness guarantee.
      // Eight milliseconds regularly returns control to Electron lifecycle/IPC
      // work while retaining large sequential append batches. One individual
      // JSON.stringify cannot be preempted, but later records never compound an
      // already-expensive payload in the same event-loop slice.
      if (performance.now() - sliceStartedAt >= SERIALIZE_SLICE_BUDGET_MS) {
        await yieldToMainLoop()
        sliceStartedAt = performance.now()
      }
    }

    // Notes ALWAYS flush — cap or no cap, tombstoned or not — and never touch
    // bytesWritten.
    if (notes.length > 0) await this.appendRaw(notes.join(''))

    const eventBatch = events.join('')
    if (this.bytesWritten + eventBatch.length > MAX_BYTES && !this.tombstoned) {
      // Cross the cap: write a final tombstone once and stop appending events.
      // Cap, never rotate (feedDebugLog policy). The batch that crossed the cap
      // still holds `events.length` real event lines we are NOT writing — record
      // that as `dropped` in the tombstone (mirroring the queue-drop marker) and
      // fold it into this.dropped so meta.json's droppedCount reflects the true
      // loss. Notes in this same batch were already written above, so they are
      // NOT counted as dropped (finding C8: only the lost EVENTS are the hole).
      this.tombstoned = true
      this.capped = true
      const mark =
        JSON.stringify({
          t: Math.round(this.nowMono() - this.startMono),
          wall: this.nowWall(),
          ch: '__truncated',
          reason: 'size-cap',
          bytes: this.bytesWritten,
          dropped: events.length,
        }) + '\n'
      await this.appendRaw(mark)
      this.dropped += events.length
    } else if (!this.capped) {
      if (eventBatch.length > 0) {
        await this.appendRaw(eventBatch)
        this.bytesWritten += eventBatch.length
      }
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

  // Snapshot this.meta SYNCHRONOUSLY, then enqueue the actual write behind any
  // in-flight ones. The snapshot is load-bearing: it freezes the state as of
  // THIS call even though the disk write is deferred, so a later mutation (or a
  // later call's snapshot) can't retroactively change what this call writes.
  // Serializing through metaChain guarantees FIFO ordering — close()'s snapshot
  // is enqueued last and therefore wins the file. Returns the chain so callers
  // (close()) can await their write actually landing. Both disk ops in
  // doWriteMeta swallow their errors, so the chain NEVER rejects — a rejected
  // chain would poison every subsequent meta write.
  private writeMeta(): Promise<void> {
    const snapshot = this.meta
    this.metaChain = this.metaChain.then(() => this.doWriteMeta(snapshot))
    return this.metaChain
  }

  private async doWriteMeta(snapshot: RecordingMeta): Promise<void> {
    try {
      await mkdir(this.dir, { recursive: true, mode: 0o700 })
      this.ensuredDir = true
    } catch {
      /* re-ensured lazily on first event append */
    }
    try {
      await writeFile(join(this.dir, 'meta.json'), JSON.stringify(snapshot, null, 1), {
        mode: 0o600,
      })
    } catch {
      /* non-fatal: the events stream is the source of truth; meta is a convenience */
    }
  }

  /**
   * Fill identity fields from a later event (plan §3/§2: providerSessionId /
   * cwd / provider belong in the header, but a command-started recording
   * begins before session:started is seen). Only fills EMPTY/unknown fields —
   * never overwrites a known value — and rewrites meta.json when something
   * changed. Cheap and idempotent.
   */
  refreshIdentity(id: { provider?: string; providerSessionId?: string; cwd?: string }): void {
    let changed = false
    if (id.provider && (this.meta.provider === 'unknown' || !this.meta.provider)) {
      this.meta = { ...this.meta, provider: id.provider }
      changed = true
    }
    if (id.providerSessionId && !this.meta.providerSessionId) {
      this.meta = { ...this.meta, providerSessionId: id.providerSessionId }
      changed = true
    }
    if (id.cwd && !this.meta.cwd) {
      this.meta = { ...this.meta, cwd: id.cwd }
      changed = true
    }
    if (changed) void this.writeMeta()
  }

  /**
   * Force the writer fully quiescent and wait — used on shutdown and by tests.
   *
   * A single drain() is NOT enough. Two things can leave work behind after one
   * call: (a) a drain may already be in flight, in which case a fresh drain()
   * no-ops on the re-entrancy gate and returns before the running one finishes;
   * and (b) doDrain() reschedules itself via a timer when the queue is refilled
   * mid-drain. Either way the tail (session:exit, trailing notes) could land on
   * a timer that fires AFTER close() has already written the final meta — the
   * #442 lost-tail bug. So we loop until the queue is empty AND no drain is
   * running, re-clearing the timer each pass so nothing we just quiesced gets
   * re-armed behind us. `!this.capped` terminates the loop once we've stopped
   * appending events (the queue may still hold post-cap lines we intentionally
   * no longer write).
   */
  async flush(): Promise<void> {
    while ((this.queue.length > 0 || this.draining) && !this.capped) {
      if (this.timer) {
        clearTimeout(this.timer)
        this.timer = null
      }
      // Await the IN-FLIGHT drain if one is running (racing a second drain()
      // would just no-op on the gate); otherwise kick off and await a new one.
      if (this.draining && this.drainPromise) await this.drainPromise
      else await this.drain()
    }
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
