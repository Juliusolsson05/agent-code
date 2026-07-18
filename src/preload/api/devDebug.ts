import { ipcRenderer } from 'electron'

import type { DevDebugConfig, PasteDebugSession } from '@preload/api/types.js'
import type { RenderShapeAppendResult } from '@shared/types/renderShapes.js'

export const devDebugApi = {
  getDevDebugConfig: (): Promise<DevDebugConfig> =>
    ipcRenderer.invoke('dev-debug:get-config'),

  // Pull the most-recent paste-debug journals for the ClaudePasteDetection
  // module (#90). Newest first; `limit` caps how many submits we hydrate.
  readPasteEvents: (limit?: number): Promise<PasteDebugSession[]> =>
    ipcRenderer.invoke('dev-debug:read-paste-events', limit),

  // Attach-Recording-Note (plan §7b). reserve is the "claim the tick" gesture:
  // call it the instant the operator invokes the command, BEFORE showing the
  // note input, so the marker's timestamp pins the reaction moment. Returns
  // the noteId, or null when there is no active recording for the session (or
  // recording isn't gated on) — the caller uses null to skip the input.
  reserveRecordingNote: (sessionId: string): Promise<string | null> =>
    ipcRenderer.invoke('record-session:reserve-note', sessionId),
  // Fill the previously reserved marker with the typed text on submit.
  fillRecordingNote: (sessionId: string, noteId: string, text: string): Promise<void> =>
    ipcRenderer.invoke('record-session:fill-note', sessionId, noteId, text),

  // Start/stop recording ONE session on demand (plan §7 — the primary
  // control; recording is command-driven, not auto). start returns true
  // (recording), stop resolves false. isSessionRecording lets the command
  // label itself Start vs Stop for the focused pane.
  startSessionRecording: (
    sessionId: string,
    provider?: string,
  ): Promise<{ recording: boolean; generation: string | null }> =>
    ipcRenderer.invoke('record-session:start', sessionId, provider),
  stopSessionRecording: (sessionId: string): Promise<boolean> =>
    ipcRenderer.invoke('record-session:stop', sessionId),
  isSessionRecording: (
    sessionId: string,
  ): Promise<{ recording: boolean; generation: string | null }> =>
    ipcRenderer.invoke('record-session:is-recording', sessionId),

  // Render-shape sighting sidecar (Phase 2/3, PR #555). append routes one
  // coalesced metadata-only batch into the live recording's __render_shape
  // line; read sweeps every on-disk recording for the Unknown Shape Inbox
  // (derived state — recordings ARE the database).
  appendRenderShapeSightings: (
    sessionId: string,
    generation: string,
    sightings: unknown[],
  ): Promise<RenderShapeAppendResult> =>
    ipcRenderer.invoke('render-shape:append', sessionId, generation, sightings),
  // Push channel: main announces a recorder STARTING for a session so the
  // shape observer can arm immediately. WHY push (PR #555, live-test
  // finding): under auto-record the recorder starts on the session's FIRST
  // event — for an idle restored pane that is whenever the user first
  // prompts it, unboundedly after Feed mount, so every renderer-side poll
  // schedule loses the race. Same subscribe shape as lsp:diagnostics.
  onSessionRecordingStarted: (
    cb: (payload: { sessionId: string; generation: string }) => void,
  ): (() => void) => {
    const listener = (
      _evt: unknown,
      payload: { sessionId: string; generation: string },
    ): void => cb(payload)
    ipcRenderer.on('record-session:started', listener)
    return () => ipcRenderer.removeListener('record-session:started', listener)
  },
  // Natural provider exit is a two-step close: main keeps the recorder open
  // for a short grace window and asks the renderer to flush its coalesced
  // shape counters. The renderer acknowledges by calling finish below; main's
  // timer remains the crash/reload fallback when no renderer can answer. The
  // generation is opaque but load-bearing for reused sessionIds: when present,
  // a generation-aware caller echoes the value it received and never looks up
  // "the current" recording. It remains optional at this compatibility seam
  // so a tokenless notification/consumer degrades to the safe timer instead of
  // closing fresh state.
  onSessionRecordingStopping: (
    cb: (payload: { sessionId: string; generation?: string }) => void,
  ): (() => void) => {
    const listener = (_evt: unknown, payload: { sessionId: string; generation?: string }): void =>
      cb(payload)
    ipcRenderer.on('record-session:stopping', listener)
    return () => ipcRenderer.removeListener('record-session:stopping', listener)
  },
  finishSessionRecordingStop: (sessionId: string, generation?: string): Promise<void> =>
    ipcRenderer.invoke('record-session:finish-stop', sessionId, generation),
  readRenderShapeSightings: (): Promise<{
    sightings: unknown[]
    recordingsScanned: number
    truncated: boolean
  }> => ipcRenderer.invoke('render-shape:read-sightings'),
}
