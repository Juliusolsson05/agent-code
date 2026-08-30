import { join, resolve } from 'node:path'

import { app } from 'electron'

import { SessionRecorder } from '@main/recording/SessionRecorder.js'
import { SESSION_RECORDING_DIR } from '@main/storage/paths.js'
import {
  isCodexTranscriptObservationEventName,
  isCodexTranscriptObservationSessionId,
  pickCodexTranscriptObservationCorrelationIds,
  pickCodexTranscriptObservationData,
  type CodexTranscriptObservation,
} from '@shared/lifecycle/events.js'

// Owns one SessionRecorder per live session and routes the outbound IPC
// stream to it. plan §2.
//
// TAP: registered as the outbound observer on sendToMainWindow (the ONE
// funnel every rendering event crosses — mainWindow.ts). We record the
// exact payloads the renderer receives, including the BULK
// session:jsonl-entries the coalescer sends (a ledger-input recorder tapped
// below the fold would miss fold-layer bugs like the #469 queue desync —
// the whole reason the tap is here and not at the ledger seam).
//
// ALLOWLIST, not a prefix: the `session:` prefix also carries
// terminal-data / agent-pty-data (raw PTY, not feed events). We record only
// the feed channels plus content-safe transcript ownership diagnostics. The
// diagnostic channel is intentionally recorded even though replay ignores it:
// it explains why committed input never began without becoming fold input.
const RECORDED_CHANNELS: ReadonlySet<string> = new Set([
  'session:started',
  'session:screen',
  'session:jsonl-entries',
  'session:jsonl-error',
  'session:transcript-diagnostic',
  'session:process-state',
  'session:conditions',
  'session:semantic-event',
  'session:sub-agents',
  'session:exit',
])

function extractSessionId(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null
  const id = (payload as { sessionId?: unknown }).sessionId
  return typeof id === 'string' && id.length > 0 ? id : null
}

/** Best-effort provider hint from a payload (only session:started reliably
 *  carries it; filled 'unknown' otherwise — the events themselves carry
 *  everything replay needs, meta is a convenience). */
function extractProvider(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null
  const p = payload as { kind?: unknown; provider?: unknown; sessionKind?: unknown }
  for (const v of [p.kind, p.provider, p.sessionKind]) {
    if (typeof v === 'string' && v.length > 0) return v
  }
  return null
}

function extractSessionRunId(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null
  const id = (payload as { sessionRunId?: unknown }).sessionRunId
  return typeof id === 'string' && id.length > 0 ? id : null
}

export class SessionRecorderManager {
  private readonly recorders = new Map<
    string,
    { recorder: SessionRecorder; generation: string; sessionRunId: string | null }
  >()
  /**
   * Recorder generations that have yielded the session's active slot but are
   * still inside the renderer's final-evidence handshake.
   *
   * WHY these cannot simply be closed when a replacement starts: the renderer
   * deliberately keeps generation A addressable while its final coalesced
   * shape batch is in flight. Reusing the session id for B must neither route
   * A's batch into B nor reject it after A was already promised a grace window.
   * Generation-addressed retirement lets B receive ordinary session events
   * immediately while A remains writable only through its metadata sidecar.
   */
  private readonly retiringRecorders = new Map<
    string,
    { sessionId: string; recorder: SessionRecorder }
  >()
  private readonly pendingStops = new Map<
    string,
    { sessionId: string; timer: ReturnType<typeof setTimeout> }
  >()
  // recordingId used to be timestamp+sessionId. Two stop/start operations in
  // the same wall-clock millisecond therefore reopened the SAME directory and
  // mixed logically separate generations. The process-local sequence is not a
  // durable identity by itself; it only disambiguates IDs that already carry
  // their wall time and session suffix. That is enough because one manager is
  // the sole recorder creator for this process.
  private recordingSeq = 0
  // Monotonic note counter. A noteId must be UNIQUE within a recording because
  // fillNote targets a previously reserved marker BY ID; a millisecond-only id
  // (`n-<mono>`) collides when two notes are reserved inside the same ~1 ms
  // tick (a double-tap, or a scripted soak), and the second fill would then
  // overwrite the first note's text. Appending an ever-incrementing seq makes
  // the id unique even when Math.round(nowMono()) returns the same value twice;
  // the timestamp is kept purely for human readability of the id.
  private noteSeq = 0

  constructor(
    // Injected so tests can drive deterministic time and the recorder stays
    // wall-clock-honest (Date.now for `wall`, a monotonic source for `t`).
    private readonly nowWall: () => number = () => Date.now(),
    private readonly nowMono: () => number = () => performance.now(),
    // AUTO-RECORD is opt-in and OFF by default. Plan §7: recording is
    // command-driven per session; a user does NOT want every session of a
    // long day silently written to disk (that is how you bury yourself in
    // tens of GB). Only when AGENT_CODE_SESSION_RECORD=1 does the manager
    // auto-start every session — the unattended-soak power path, never the
    // default. Without it, NOTHING records until `startRecording` is called
    // by the Start Recording command.
    private readonly autoRecord: boolean = false,
    // Push notification for the renderer's shape observer (Phase 2, PR
    // #555). INJECTED (index.ts passes a sendToMainWindow closure) rather
    // than imported, because this manager sits UNDER the outbound funnel —
    // importing mainWindow here would invert that relationship. WHY push
    // and not renderer polling: under auto-record the recorder starts on a
    // session's FIRST event, which for an idle restored pane can be
    // minutes after its Feed mounted — live testing proved every bounded
    // poll schedule loses that race. The notification channel is not in
    // RECORDED_CHANNELS, so the observe() tap ignores it (no recursion).
    private readonly notifyRecordingStarted: (
      sessionId: string,
      generation: string,
    ) => void = () => {},
    private readonly notifyRecordingStopping: (
      sessionId: string,
      generation: string,
    ) => void = () => {},
  ) {}

  /** The outbound observer registered on sendToMainWindow. The critical
   *  gate: an event is only written if its session has been EXPLICITLY
   *  started (or auto-record is on). A session the user never chose to
   *  record produces nothing on disk — no burial. */
  observe = (channel: string, args: readonly unknown[]): void => {
    if (!RECORDED_CHANNELS.has(channel)) return
    const payload = args[0]
    const sessionId = extractSessionId(payload)
    if (!sessionId) return

    let active = this.recorders.get(sessionId)
    if (
      channel === 'session:started' &&
      active &&
      this.pendingStops.get(active.generation)?.sessionId === sessionId
    ) {
      // A fresh provider lifecycle event outranks the old generation's grace
      // window. Detach before this event is appended anywhere. The ordinary
      // autoRecord gate below still decides whether the replacement should be
      // captured; an explicitly started replacement would already occupy the
      // map without pending-stop state and therefore bypass this branch.
      this.retireActiveGeneration(sessionId, active.generation)
      active = undefined
    }
    if (!active) {
      // Not recording this session. Auto-start it ONLY under the opt-in
      // power flag; otherwise ignore the event entirely (the default —
      // recording waits for the Start Recording command).
      if (!this.autoRecord) return
      this.startRecording(sessionId, payload)
      active = this.recorders.get(sessionId)
      if (!active) return
    }
    const recorder = active.recorder
    recorder.record(channel, payload)
    // session:started carries the header identity (kind→provider, projectDir
    // →cwd) a command-started recording didn't have yet — fill it in (plan
    // §2/§3). providerSessionId is provisional (upgraded later) so it stays
    // best-effort/null.
    if (channel === 'session:started') {
      const p = payload as { kind?: string; projectDir?: string }
      // The provider run id is the provenance fence for synthetic Stage 0
      // sidecars. A recorder may have been command-started before the backend,
      // so fill it from the first authoritative started payload rather than
      // guessing from stable pane identity.
      active.sessionRunId = extractSessionRunId(payload)
      recorder.refreshIdentity({ provider: p.kind, cwd: p.projectDir })
    }
    // session:exit starts a bounded renderer-flush handshake. Closing here
    // synchronously used to remove the recorder before the observer's final
    // two-second coalesced batch could arrive, losing rare one-off shapes.
    if (channel === 'session:exit') this.requestStop(sessionId)
  }

  /**
   * Begin recording ONE session on demand (the Start Recording command,
   * plan §7). Idempotent — starting an already-recording session returns
   * the live recorder. `firstPayload` is optional provider-hint metadata
   * when the start is triggered by an incoming event (auto-record).
   */
  startRecording(sessionId: string, firstPayload?: unknown): SessionRecorder {
    let active = this.recorders.get(sessionId)
    const pending = active ? this.pendingStops.get(active.generation) : undefined
    if (active && pending?.sessionId === sessionId) {
      // sessionIds describe a logical pane/process slot, not a unique process
      // lifetime. A provider can reuse one while the previous exit is still in
      // its renderer-flush grace period. Idempotence applies only to a RUNNING
      // generation: once stop is pending, a start is authoritative evidence of
      // replacement. Move the old generation out of the ordinary event route,
      // but keep its generation-addressed sidecar writer until the renderer's
      // promised final flush or the bounded stop timer completes.
      this.retireActiveGeneration(sessionId, active.generation)
      active = undefined
    }
    if (!active) {
      const startedAtWall = this.nowWall()
      // Sanitize the sessionId BEFORE it becomes a path segment. recordingId is
      // join()-ed under SESSION_RECORDING_DIR by SessionRecorder, and sessionId
      // crosses IPC from the renderer — an id containing '/', '\\' or '..' would
      // let a crafted value escape the recordings directory and write (or, later,
      // rm -rf via retention) somewhere else on disk. Real ids are uuid-like so
      // this collapses to a no-op in practice; it exists purely as a
      // path-traversal guard at the trust boundary. The unsanitized sessionId is
      // still stored verbatim in meta.sessionId for correlation — only the
      // on-disk PATH segment is constrained.
      const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, '_')
      // Fixed width preserves the recordingId's lexical chronology even in a
      // synthetic/test burst that creates >9 generations in one millisecond;
      // the audit and inbox intentionally use filename sort as their clock.
      const generation =
        `${new Date(startedAtWall).toISOString().replace(/[:.]/g, '-')}` +
        `-g${String(this.recordingSeq++).padStart(8, '0')}-${safe}`
      const recorder = new SessionRecorder(
        {
          v: 1,
          kind: 'session-recording',
          redaction: 'none',
          // recordingId sorts chronologically and is filesystem-safe; the
          // sanitized sessionId suffix keeps concurrent tiled sessions distinct
          // and greppable. Colons stripped for Windows/paths.
          recordingId: generation,
          sessionId,
          provider: extractProvider(firstPayload) ?? 'unknown',
          providerSessionId: null,
          cwd: null,
          appVersion: app?.getVersion?.() ?? null,
          startedAtWall,
        },
        this.nowWall,
        this.nowMono,
      )
      active = {
        recorder,
        generation,
        sessionRunId: extractSessionRunId(firstPayload),
      }
      this.recorders.set(sessionId, active)
      try {
        this.notifyRecordingStarted(sessionId, generation)
      } catch {
        /* a notify failure must never break recording itself */
      }
    }
    return active.recorder
  }

  /** Attach-Recording-Note: reserve a marker instantly (plan §7b). Returns
   *  the noteId, or null if no active recording for the session. */
  reserveNote(sessionId: string): string | null {
    const recorder = this.recorders.get(sessionId)?.recorder
    if (!recorder) return null
    const id = `n-${Math.round(this.nowMono())}-${this.noteSeq++}`
    recorder.note({ id, status: 'reserved' })
    return id
  }

  /** Attach-Recording-Note: fill a previously reserved marker with text. */
  fillNote(sessionId: string, noteId: string, text: string): void {
    this.recorders.get(sessionId)?.recorder.note({ id: noteId, status: 'filled', text })
  }

  /**
   * Route one coalesced batch of renderer shape sightings into the live
   * recording's `__render_shape` sidecar (Phase 2, PR #555). Returns false
   * when that exact generation is neither active nor retiring — the
   * documented no-op: the renderer's observer can outlive its recorder by one
   * flush tick, and that race must be a dropped batch, never an error surfaced
   * to the paint path.
   */
  appendRenderShapes(
    sessionId: string,
    generation: string,
    sightings: readonly unknown[],
  ): boolean {
    const active = this.recorders.get(sessionId)
    // A delayed renderer flush belongs to the generation that observed those
    // shapes. Session ids are reusable; routing by id alone lets recording A's
    // final batch contaminate replacement B. Rejecting stale data is safer than
    // attaching it to the wrong provenance. A retiring generation remains a
    // valid target only by its opaque generation token: it no longer receives
    // ordinary session events, but it was explicitly promised this bounded
    // window for final shape counts.
    const retiring = this.retiringRecorders.get(generation)
    const recorder = active?.generation === generation
      ? active.recorder
      : retiring?.sessionId === sessionId
        ? retiring.recorder
        : undefined
    if (!recorder) return false
    recorder.renderShapes(sightings)
    return true
  }

  /**
   * Append one already-sanitized Stage 0 observation to the active session
   * recording without routing it through the outbound SessionFeed funnel.
   *
   * WHY this deliberately does not auto-start a recorder: ordinary recording
   * remains an explicit user choice (or the existing AGENT_CODE_SESSION_RECORD
   * power mode). Lifecycle observations are always-on and comparatively
   * frequent; allowing them to create recordings would silently undo that
   * privacy/storage boundary. In power mode the normal `session:started` event
   * creates the recorder before a human can submit, so the chronology is still
   * present in the captures that opted into it.
   *
   * WHY only the active generation receives the row: a logical session id may
   * be reused while an older recorder is retiring. The lifecycle observation
   * carries no retiring generation token, so guessing would contaminate one
   * process lifetime with another. Returning false makes that honest loss
   * observable to the caller without ever attaching evidence to the wrong run.
   */
  recordCodexTranscriptObservation(
    sessionId: string,
    sessionRunId: string,
    observation: unknown,
  ): boolean {
    const active = this.recorders.get(sessionId)
    if (
      !active ||
      !isCodexTranscriptObservationSessionId(sessionId) ||
      active.sessionRunId !== sessionRunId
    ) return false
    if (!observation || typeof observation !== 'object' || Array.isArray(observation)) return false
    const input = observation as Record<string, unknown>
    if (input.schemaVersion !== 1 || !isCodexTranscriptObservationEventName(input.name)) {
      return false
    }
    const safeData = pickCodexTranscriptObservationData(input.name, input.data)
    const safeIds = pickCodexTranscriptObservationCorrelationIds(
      input.name,
      input.ids,
      safeData,
    )
    // The caller supplies the exact main-owned run fence separately. Restore
    // both authoritative scope keys after filtering the untrusted object so a
    // future internal caller cannot smuggle a different pane/run into the
    // shareable sidecar through an otherwise shape-valid ids bag.
    const safeObservation: CodexTranscriptObservation = {
      schemaVersion: 1,
      name: input.name,
      ids: {
        ...(safeIds ?? {}),
        sessionRunId,
        sessionId,
      },
      ...(safeData ? { data: safeData } : {}),
    }
    active.recorder.codexTranscriptObservation(safeObservation)
    return true
  }

  /**
   * Ask the renderer to finish its metadata sidecar before finalizing the
   * recorder. The timer is not a sleep in the hot path: it is the ownership
   * fallback for renderer crash/reload/app shutdown, where no acknowledgement
   * can ever arrive. A generation-aware renderer calls finishStopping
   * immediately; older tokenless clients safely fall back to this timer.
   */
  private requestStop(sessionId: string): void {
    const active = this.recorders.get(sessionId)
    if (!active) return
    const pending = this.pendingStops.get(active.generation)
    if (pending?.sessionId === sessionId) return

    // Install the generation-addressed pending state BEFORE notifying. Test
    // callbacks can acknowledge synchronously, and a future transport may do
    // the same; publishing first avoids an acknowledgement racing an absent
    // pending record. More importantly, the timer closes the recorder it was
    // created for, never whatever happens to reuse this sessionId later.
    const generation = active.generation
    const timer = setTimeout(() => {
      void this.stopGeneration(sessionId, generation)
    }, 3_000)
    this.pendingStops.set(generation, { sessionId, timer })
    try {
      this.notifyRecordingStopping(sessionId, generation)
    } catch {
      /* notification failure falls through to the bounded timer */
    }
  }

  finishStopping(sessionId: string, generation?: string): Promise<void> {
    // A sessionId is deliberately reusable, so it can never authenticate a
    // stop acknowledgement by itself. Tokenless acknowledgements came from
    // the old preload contract and are ignored: waiting for the bounded timer
    // costs at most three seconds, while guessing could close a fresh recorder
    // and append its final sidecar data to the wrong generation.
    if (!generation) return Promise.resolve()
    const pending = this.pendingStops.get(generation)
    if (!pending || pending.sessionId !== sessionId) return Promise.resolve()
    return this.stopGeneration(sessionId, generation)
  }

  isRecording(sessionId: string): boolean {
    return this.recorders.has(sessionId)
  }

  recordingGeneration(sessionId: string): string | null {
    return this.recorders.get(sessionId)?.generation ?? null
  }

  /** The set of resolved on-disk directories for every recording still live in
   *  memory. Consumed by debugRetention (setLiveRecordingDirsProvider) to keep
   *  an active recording from being pruned.
   *
   *  WHY this and not the folder's mtime: retention ages a recording by its
   *  folder mtime, but a quiet-but-live recording (a session gone idle) stops
   *  bumping mtime, so the ACTIVE_GRACE_MS window can lapse while the recorder
   *  is STILL open and will append again on the next event — pruning the folder
   *  out from under a live writer. Liveness is authoritatively "the recorder is
   *  in this map", not "the folder was touched recently". The path is
   *  reconstructed exactly the way SessionRecorder builds it
   *  (join(SESSION_RECORDING_DIR, recordingId)) and resolve()d so it matches the
   *  resolve(artifact.path) key retention compares against. */
  liveRecordingDirs(): Set<string> {
    const dirs = new Set<string>()
    for (const { recorder } of this.recorders.values()) {
      dirs.add(resolve(join(SESSION_RECORDING_DIR, recorder.recordingId)))
    }
    for (const { recorder } of this.retiringRecorders.values()) {
      dirs.add(resolve(join(SESSION_RECORDING_DIR, recorder.recordingId)))
    }
    return dirs
  }

  async stop(sessionId: string): Promise<void> {
    const active = this.recorders.get(sessionId)
    if (!active) return
    await this.stopGeneration(sessionId, active.generation)
  }

  private async stopGeneration(sessionId: string, generation: string): Promise<void> {
    const pending = this.pendingStops.get(generation)
    if (pending?.sessionId === sessionId) {
      clearTimeout(pending.timer)
      this.pendingStops.delete(generation)
    }
    const active = this.recorders.get(sessionId)
    if (active?.generation === generation) {
      this.recorders.delete(sessionId)
      await active.recorder.close()
      return
    }
    const retiring = this.retiringRecorders.get(generation)
    if (!retiring || retiring.sessionId !== sessionId) return
    this.retiringRecorders.delete(generation)
    await retiring.recorder.close()
  }

  private retireActiveGeneration(sessionId: string, generation: string): void {
    const active = this.recorders.get(sessionId)
    if (!active || active.generation !== generation) return
    this.recorders.delete(sessionId)
    this.retiringRecorders.set(generation, { sessionId, recorder: active.recorder })
  }

  /** Public stop for the Stop Recording command (plan §7). Alias of stop;
   *  named to pair with startRecording at the call sites. */
  stopRecording(sessionId: string): Promise<void> {
    return this.stop(sessionId)
  }

  /** Drain + finalize every recording. Called on before-quit (mirrors
   *  ghostJournals.flushAll). */
  async flushAll(): Promise<void> {
    for (const { timer } of this.pendingStops.values()) clearTimeout(timer)
    this.pendingStops.clear()
    const all = [
      ...[...this.recorders.values()].map(active => active.recorder),
      ...[...this.retiringRecorders.values()].map(retiring => retiring.recorder),
    ]
    this.recorders.clear()
    this.retiringRecorders.clear()
    await Promise.all(all.map(r => r.close()))
  }
}
