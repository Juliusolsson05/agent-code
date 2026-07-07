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
  ) {}

  /** The outbound observer registered on sendToMainWindow. Cheap on every
   *  non-recorded channel (a Set lookup), so it is safe to leave installed;
   *  the manager is only CONSTRUCTED when recording is gated on. */
  observe = (channel: string, args: readonly unknown[]): void => {
    if (!RECORDED_CHANNELS.has(channel)) return
    const payload = args[0]
    const sessionId = extractSessionId(payload)
    if (!sessionId) return
    const recorder = this.ensure(sessionId, payload)
    recorder.record(channel, payload)
    // session:exit is the renderer-facing end; finalize the recording so its
    // meta.json gets end stats. (SessionManager 'removed' is the authoritative
    // cleanup but is not on the outbound funnel; exit is close enough for the
    // recording boundary, and flushAll on quit backstops any session that
    // never emitted exit.)
    if (channel === 'session:exit') void this.stop(sessionId)
  }

  private ensure(sessionId: string, firstPayload: unknown): SessionRecorder {
    let recorder = this.recorders.get(sessionId)
    if (!recorder) {
      const startedAtWall = this.nowWall()
      recorder = new SessionRecorder(
        {
          v: 1,
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

  /** Drain + finalize every recording. Called on before-quit (mirrors
   *  ghostJournals.flushAll). */
  async flushAll(): Promise<void> {
    const all = [...this.recorders.values()]
    this.recorders.clear()
    await Promise.all(all.map(r => r.close()))
  }
}
