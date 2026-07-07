import { ipcMain } from 'electron'

import { readRecentPasteSessions } from '../pasteDebugJournal.js'
import type { SessionRecorderManager } from '@main/recording/SessionRecorderManager.js'

export type DevDebugConfig = {
  enabled: boolean
  /** AGENT_CODE_SESSION_RECORD=1 (AND dev-debug on) — continuously record
   *  each session's rendering-input stream to session-recordings/<id>/,
   *  replayable in tests. plan: docs/rendering/session-recording-plan-2026-07.md,
   *  issue #467. Debug-gated because a recording captures full conversation
   *  input. */
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

// `sessionRecorders` is null in a normal build (the manager is only
// constructed when AGENT_CODE_DEV_DEBUG + AGENT_CODE_SESSION_RECORD are both
// on — see main/index.ts). It is threaded in from the IPC deps rather than
// imported as a singleton so the wiring stays visible at the registerAllIpc
// call site, exactly like every other manager here.
export function registerDevDebugIpc(sessionRecorders: SessionRecorderManager | null): void {
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
      sessionRecorders?.fillNote(sessionId, noteId, text)
    },
  )
  // Start/stop a single session's recording on demand (plan §7). This is the
  // PRIMARY control — recording is command-driven, not auto. Returns whether
  // the session is recording after the call so the renderer can label the
  // toggle correctly.
  ipcMain.handle(
    'record-session:start',
    (_evt, sessionId: string, provider?: string): boolean => {
      if (!isSessionRecordingEnabled() || !sessionRecorders) return false
      // The command knows the pane's provider (workspace meta.kind); pass it
      // so a mid-session start still records the right provider (the
      // session:started event that carries it has usually already fired).
      sessionRecorders.startRecording(sessionId, provider ? { kind: provider } : undefined)
      return true
    },
  )
  ipcMain.handle('record-session:stop', (_evt, sessionId: string): Promise<boolean> | boolean => {
    if (!isSessionRecordingEnabled() || !sessionRecorders) return false
    return sessionRecorders.stopRecording(sessionId).then(() => false)
  })
  ipcMain.handle('record-session:is-recording', (_evt, sessionId: string): boolean => {
    if (!isSessionRecordingEnabled() || !sessionRecorders) return false
    return sessionRecorders.isRecording(sessionId)
  })
}
