// Per-paste debug-event IPC handler.
//
// Mirrors the dictation:debug-event channel handler in PR #68. Uses
// `ipcMain.on` (not `handle`) because the renderer side is
// fire-and-forget; we don't want every keydown to pay the
// promise round-trip cost. Bad payloads are dropped silently — the
// journal should never be a way to crash the main process.

import { ipcMain } from 'electron'

import type { PasteDebugJournalRegistry } from '@main/pasteDebugJournal.js'
import type { PasteDebugEventInput } from '@preload/api/types.js'

export function registerPasteDebugIpc(deps: {
  pasteDebugJournals: PasteDebugJournalRegistry
}): void {
  ipcMain.on(
    'paste:debug-event',
    (_evt, pasteId: unknown, input: unknown) => {
      if (typeof pasteId !== 'string' || !pasteId) return
      if (!input || typeof input !== 'object') return
      const payload = input as PasteDebugEventInput
      if (typeof payload.layer !== 'string' || typeof payload.event !== 'string') return
      deps.pasteDebugJournals.get(pasteId).append(payload)
    },
  )
}
