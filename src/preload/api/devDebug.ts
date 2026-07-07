import { ipcRenderer } from 'electron'

import type { DevDebugConfig, PasteDebugSession } from '@preload/api/types.js'

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
}
