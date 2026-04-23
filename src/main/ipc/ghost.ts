import { ipcMain } from 'electron'
import type { GhostEntry } from 'agent-transcript-parser'

import type { GhostJournalRegistry } from '../ghostJournal.js'
import { readGhostLog } from '../ghostJournal.js'

// Ghost journal IPC.
//
// Renderer calls `ghost:append` with each freshly-produced GhostEntry;
// we enqueue it for the 100 ms batched drain. `ghost:read` is used on
// session mount to replay previously-persisted ghosts so the merged
// view comes back immediately after a reload.
//
// The entry is already a plain JSON object by the time it arrives
// here — atp primitives ran in the renderer. Main is a mail clerk.

export function registerGhostIpc(ghostJournals: GhostJournalRegistry): void {
  ipcMain.handle(
    'ghost:append',
    (_evt, sessionId: string, ghost: GhostEntry) => {
      ghostJournals.get(sessionId).append(ghost)
    },
  )

  ipcMain.handle(
    'ghost:read',
    (_evt, sessionId: string): Promise<GhostEntry[]> =>
      readGhostLog(sessionId),
  )
}
