import { app } from 'electron'

import { SessionRecorder } from '@main/recording/SessionRecorder.js'

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
// the 9 channels that map 1:1 to the SessionFeed methods the renderer's
// rendering pipeline consumes.
const RECORDED_CHANNELS: ReadonlySet<string> = new Set([
  'session:started',
  'session:screen',
  'session:jsonl-entries',
  'session:jsonl-error',
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

export class SessionRecorderManager {
  private readonly recorders = new Map<string, SessionRecorder>()

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

    let recorder = this.recorders.get(sessionId)
    if (!recorder) {
      // Not recording this session. Auto-start it ONLY under the opt-in
      // power flag; otherwise ignore the event entirely (the default —
      // recording waits for the Start Recording command).
      if (!this.autoRecord) return
      recorder = this.startRecording(sessionId, payload)
    }
    recorder.record(channel, payload)
    // session:started carries the header identity (kind→provider, projectDir
    // →cwd) a command-started recording didn't have yet — fill it in (plan
    // §2/§3). providerSessionId is provisional (upgraded later) so it stays
    // best-effort/null.
    if (channel === 'session:started') {
      const p = payload as { kind?: string; projectDir?: string }
      recorder.refreshIdentity({ provider: p.kind, cwd: p.projectDir })
    }
    // session:exit finalizes the recording (end stats in meta.json).
    if (channel === 'session:exit') void this.stop(sessionId)
  }

  /**
   * Begin recording ONE session on demand (the Start Recording command,
   * plan §7). Idempotent — starting an already-recording session returns
   * the live recorder. `firstPayload` is optional provider-hint metadata
   * when the start is triggered by an incoming event (auto-record).
   */
  startRecording(sessionId: string, firstPayload?: unknown): SessionRecorder {
    let recorder = this.recorders.get(sessionId)
    if (!recorder) {
      const startedAtWall = this.nowWall()
      recorder = new SessionRecorder(
        {
          v: 1,
          kind: 'session-recording',
          redaction: 'none',
          // recordingId sorts chronologically and is filesystem-safe; the
          // sessionId suffix keeps concurrent tiled sessions distinct and
          // greppable. Colons stripped for Windows/paths.
          recordingId: `${new Date(startedAtWall).toISOString().replace(/[:.]/g, '-')}-${sessionId}`,
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
      this.recorders.set(sessionId, recorder)
    }
    return recorder
  }

  /** Attach-Recording-Note: reserve a marker instantly (plan §7b). Returns
   *  the noteId, or null if no active recording for the session. */
  reserveNote(sessionId: string): string | null {
    const recorder = this.recorders.get(sessionId)
    if (!recorder) return null
    const id = `n-${Math.round(this.nowMono())}`
    recorder.note({ id, status: 'reserved' })
    return id
  }

  /** Attach-Recording-Note: fill a previously reserved marker with text. */
  fillNote(sessionId: string, noteId: string, text: string): void {
    this.recorders.get(sessionId)?.note({ id: noteId, status: 'filled', text })
  }

  isRecording(sessionId: string): boolean {
    return this.recorders.has(sessionId)
  }

  async stop(sessionId: string): Promise<void> {
    const recorder = this.recorders.get(sessionId)
    if (!recorder) return
    this.recorders.delete(sessionId)
    await recorder.close()
  }

  /** Public stop for the Stop Recording command (plan §7). Alias of stop;
   *  named to pair with startRecording at the call sites. */
  stopRecording(sessionId: string): Promise<void> {
    return this.stop(sessionId)
  }

  /** Drain + finalize every recording. Called on before-quit (mirrors
   *  ghostJournals.flushAll). */
  async flushAll(): Promise<void> {
    const all = [...this.recorders.values()]
    this.recorders.clear()
    await Promise.all(all.map(r => r.close()))
  }
}
