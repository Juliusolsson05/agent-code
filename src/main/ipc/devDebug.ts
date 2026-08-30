import { ipcMain } from 'electron'
import type { RenderShapeAppendResult } from '@shared/types/renderShapes.js'

import { readRecentPasteSessions } from '../pasteDebugJournal.js'
import type { SessionRecorderManager } from '@main/recording/SessionRecorderManager.js'
import type { SessionManager } from '@main/sessionManager.js'

export type DevDebugConfig = {
  enabled: boolean
  /** The recording CAPABILITY is available — true whenever dev-debug is on
   *  (AGENT_CODE_DEV_DEBUG=1). This does NOT mean anything is recording: it only
   *  tells the renderer whether to SHOW the Start/Stop/Attach-Note commands,
   *  which are command-driven per session (plan §7). AGENT_CODE_SESSION_RECORD
   *  is a separate auto-start flag, not this field. Debug-gated because a
   *  recording captures full conversation input.
   *  plan: docs/rendering/session-recording-plan-2026-07.md, issue #467. */
  sessionRecordingEnabled: boolean
}

function envFlag(name: string): boolean {
  const value = process.env[name]
  return value === '1' || value === 'true' || value === 'yes'
}

function isDevDebugEnabled(): boolean {
  return envFlag('AGENT_CODE_DEV_DEBUG')
}

/** Session recording is doubly gated: it is a diagnostic (dev-debug) AND
 *  opt-in (its own flag), because it records full session input. */
// Recording CAPABILITY: the Start/Stop/Attach-Note commands and IPC are
// available whenever dev-debug is on. This does NOT record anything by
// itself — recording is command-driven per session (plan §7). Kept named
// isSessionRecordingEnabled for the DevDebugConfig field the renderer reads
// to decide whether to SHOW the commands.
export function isSessionRecordingEnabled(): boolean {
  return isDevDebugEnabled()
}

// AUTO-START power path (plan §7, OPTIONAL, OFF by default): only with the
// explicit env flag does the manager auto-record every session from launch —
// for unattended soak. The normal path records nothing until the Start
// Recording command fires, so a day of work never silently fills disk.
export function isSessionRecordingAutoStart(): boolean {
  return isDevDebugEnabled() && envFlag('AGENT_CODE_SESSION_RECORD')
}

// Hard cap on a recording note's text at the IPC trust boundary. A note is
// enqueued verbatim into the recording's events.jsonl (SessionRecorder.note)
// and deliberately BYPASSES the recorder's byte-cap + drop-oldest backpressure
// (a note must survive even in a size-capped recording), so an unbounded note
// is a memory/disk amplification a renderer could trigger directly across IPC.
// A recording note is a human-typed bookmark; 16 KiB dwarfs any real
// annotation, so we reject rather than silently truncate — the renderer already
// surfaces the thrown error as a pane toast (App.tsx fillRecordingNote).
const MAX_RECORDING_NOTE_CHARS = 16 * 1024

// `sessionRecorders` is null in a normal build (the manager is only
// constructed when the dev-debug CAPABILITY is on, AGENT_CODE_DEV_DEBUG=1 —
// see main/index.ts; AGENT_CODE_SESSION_RECORD only controls auto-record, NOT
// construction). It is threaded in from the IPC deps rather than imported as a
// singleton so the wiring stays visible at the registerAllIpc call site,
// exactly like every other manager here.
export function registerDevDebugIpc(
  sessionRecorders: SessionRecorderManager | null,
  manager?: Pick<SessionManager, 'getSessionRunId'>,
): void {
  ipcMain.handle('dev-debug:get-config', (): DevDebugConfig => {
    return {
      // WHY this flag lives in main instead of import.meta.env:
      // dev-debug modules are allowed to be noisy, temporary, and
      // sometimes performance-hostile. Gating them from the same
      // project-root `.env` loader as performance telemetry gives us a
      // runtime switch that works in Electron dev without requiring a
      // Vite-prefixed renderer variable or rebuild-time config.
      enabled: isDevDebugEnabled(),
      sessionRecordingEnabled: isSessionRecordingEnabled(),
    }
  })

  // Read side of the paste-debug journals, consumed by the ClaudePasteDetection
  // dev module (#90). The journals are write-only at runtime (the renderer
  // records events via record-paste-debug-event); this lets the module pull
  // them back to reconstruct issued→detected latency. Renderer-only modules get
  // main-process data exactly this way — a thin invoke handler, no per-module
  // channel proliferation.
  ipcMain.handle('dev-debug:read-paste-events', (_evt, limit?: number) => {
    // The renderer already hides DevDebugPanel when the flag is off, but IPC is
    // the trust boundary. Paste-debug journals contain timing, session, and
    // payload fingerprints for private user input; leaving this handler open
    // meant any renderer code with preload access could read them even when the
    // operator explicitly did not enable dev debugging.
    if (!isDevDebugEnabled()) return []
    return readRecentPasteSessions(typeof limit === 'number' ? limit : 30)
  })

  // Attach-Recording-Note (plan §7b). The recording-era equivalent of "save
  // debug logs": drop a timestamped bookmark into the LIVE recording stream so
  // a soak operator can flag the exact tick they reacted to without stopping
  // the session. Two phases, on purpose:
  //   reserve → writes the `reserved` marker INSTANTLY (before the user types)
  //             so the timestamp pins the reaction moment, not the moment they
  //             finished typing (several ticks later). Returns the noteId.
  //   fill    → updates that noteId with the typed text on submit.
  // A crash between the two still leaves the reserved line, which alone flags
  // "something was wrong here" — the same two-phase crash-safety the ghost
  // journal uses.
  //
  // Both handlers are gated by isSessionRecordingEnabled(): the flag is the
  // trust boundary (a recording captures full session input, so a renderer
  // with preload access must not reach the recorder unless the operator opted
  // in), AND sessionRecorders is null unless recording was gated on at
  // construction — so these are double-safe no-ops in a normal build. A null
  // recorder (or a sessionId with no active recording) returns null from
  // reserve; the renderer treats that as "nothing to annotate" and shows a
  // toast rather than opening the note input.
  ipcMain.handle(
    'record-session:reserve-note',
    (_evt, sessionId: string): string | null => {
      if (!isSessionRecordingEnabled()) return null
      return sessionRecorders?.reserveNote(sessionId) ?? null
    },
  )
  ipcMain.handle(
    'record-session:fill-note',
    (_evt, sessionId: string, noteId: string, text: string): void => {
      if (!isSessionRecordingEnabled()) return
      // Cap the note text here, at the IPC boundary, BEFORE it reaches the
      // recorder — see MAX_RECORDING_NOTE_CHARS for WHY (notes bypass the
      // recorder's own size/backpressure guards, so this is the only place an
      // unbounded renderer-supplied note gets bounded). Reject with a clear
      // error rather than truncate so the bookmark is never silently corrupted.
      if (typeof text === 'string' && text.length > MAX_RECORDING_NOTE_CHARS) {
        throw new Error(
          `recording note too long (${text.length} chars, max ${MAX_RECORDING_NOTE_CHARS})`,
        )
      }
      sessionRecorders?.fillNote(sessionId, noteId, text)
    },
  )
  // Start/stop a single session's recording on demand (plan §7). This is the
  // PRIMARY control — recording is command-driven, not auto. Returns whether
  // the session is recording after the call so the renderer can label the
  // toggle correctly.
  ipcMain.handle(
    'record-session:start',
    (_evt, sessionId: string, provider?: string): { recording: boolean; generation: string | null } => {
      if (!isSessionRecordingEnabled() || !sessionRecorders) {
        return { recording: false, generation: null }
      }
      // The command knows the pane's provider (workspace meta.kind); pass it
      // so a mid-session start still records the right provider (the
      // session:started event that carries it has usually already fired).
      const sessionRunId = manager?.getSessionRunId(sessionId) ?? undefined
      sessionRecorders.startRecording(sessionId, {
        ...(provider ? { kind: provider } : {}),
        // Mid-session command starts never receive another session:started.
        // Seed the recorder's provenance fence from trusted main registry state;
        // accepting a renderer-supplied run id would re-open A→B contamination.
        ...(sessionRunId ? { sessionRunId } : {}),
      })
      return { recording: true, generation: sessionRecorders.recordingGeneration(sessionId) }
    },
  )
  ipcMain.handle('record-session:stop', (_evt, sessionId: string): Promise<boolean> | boolean => {
    if (!isSessionRecordingEnabled() || !sessionRecorders) return false
    return sessionRecorders.stopRecording(sessionId).then(() => false)
  })
  ipcMain.handle('record-session:is-recording', (_evt, sessionId: string): {
    recording: boolean
    generation: string | null
  } => {
    if (!isSessionRecordingEnabled() || !sessionRecorders) {
      return { recording: false, generation: null }
    }
    return {
      recording: sessionRecorders.isRecording(sessionId),
      generation: sessionRecorders.recordingGeneration(sessionId),
    }
  })
  ipcMain.handle(
    'record-session:finish-stop',
    async (_evt, sessionId: string, generation?: string): Promise<void> => {
      if (!isSessionRecordingEnabled() || !sessionRecorders) return
      // Reused sessionIds make an unqualified acknowledgement ambiguous. The
      // manager deliberately ignores a missing/stale generation and lets its
      // bounded timer close the original recorder; forwarding the opaque token
      // here is what allows generation-aware callers to complete immediately.
      await sessionRecorders.finishStopping(sessionId, generation)
    },
  )

  // Render-shape sighting sidecar (Phase 2/3, PR #555). Same trust posture
  // as the note handlers: dev-debug flag is the boundary, manager may be
  // null in a normal build, and the payload is bounded HERE because the
  // renderer is not trusted to bound it. Sightings are metadata-only by
  // construction on the sending side, but a compromised renderer could ship
  // anything — the caps make the worst case a bounded write, and the
  // recorder's own byte cap is the second belt.
  const MAX_SIGHTING_BATCH = 512
  const MAX_SIGHTING_BATCH_BYTES = 1024 * 1024
  ipcMain.handle(
    'render-shape:append',
    (_evt, sessionId: string, generation: string, sightings: unknown): RenderShapeAppendResult => {
      if (!isSessionRecordingEnabled() || !sessionRecorders) return { status: 'no-recorder' }
      if (typeof generation !== 'string' || generation.length === 0) {
        return { status: 'rejected', reason: 'invalid' }
      }
      if (!Array.isArray(sightings) || sightings.length === 0) {
        return { status: 'rejected', reason: 'empty' }
      }
      if (sightings.length > MAX_SIGHTING_BATCH) {
        return { status: 'rejected', reason: 'too-many' }
      }
      try {
        if (JSON.stringify(sightings).length > MAX_SIGHTING_BATCH_BYTES) {
          return { status: 'rejected', reason: 'too-large' }
        }
      } catch {
        return { status: 'rejected', reason: 'invalid' }
      }
      return sessionRecorders.appendRenderShapes(sessionId, generation, sightings)
        ? { status: 'accepted' }
        : { status: 'no-recorder' }
    },
  )
  // Disk sweep for the Unknown Shape Inbox — derived-state read, no writes.
  ipcMain.handle('render-shape:read-sightings', async () => {
    if (!isDevDebugEnabled()) {
      return { sightings: [], recordingsScanned: 0, truncated: false }
    }
    const { readRenderShapeSightings } = await import('../recording/renderShapeSidecar.js')
    return readRenderShapeSightings()
  })
}
