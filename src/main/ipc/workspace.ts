import { ipcMain } from 'electron'

import type { SessionManager } from '@main/sessionManager.js'
import type { WorkspaceFileStore } from '@main/storage/workspaceFileStore.js'
import { captureWindowGeometry } from '@main/window/windowGeometry.js'
import { windowIdFor } from '@main/window/windowRegistry.js'

// Workspace state persistence.
//
// The renderer is still the source of truth for the tile tree, and the payload
// it sends is still stored verbatim. What changed with multi-window is only
// ADDRESSING: main resolves which window a payload belongs to and writes it
// into that window's slot, leaving every other window's slot untouched.
//
// WHY that addressing is a correctness requirement and not tidiness:
//
// `useAutoSave` prunes. It drops any session it cannot trace to a tile leaf, a
// detached record, or a buried pane — deliberately, so orphan metadata cannot
// make itself durable. If each window wrote the WHOLE file, each would classify
// the other's agents as orphans and delete them, every 400ms, in both
// directions, with the file's only writer being the thing doing the deleting.
// Per-window slices make that impossible by construction rather than by
// agreement.
//
// The durability machinery (unique temp + rename, one admission-ordered queue
// for reads and writes) moved to WorkspaceFileStore with its reasoning intact.

export function registerWorkspaceIpc(
  manager: SessionManager,
  store: WorkspaceFileStore,
): void {
  ipcMain.handle('workspace:load', async evt => {
    const windowId = windowIdFor(evt.sender)
    if (!windowId) return null
    return await store.loadSlice(windowId)
  })

  ipcMain.handle('workspace:save', async (evt, json: string) => {
    const windowId = windowIdFor(evt.sender)
    if (!windowId) {
      // WHY this rejects rather than guessing a slot: a save from an
      // unregistered sender has no defensible destination, and picking one
      // would overwrite a real window's workspace with a stranger's. The
      // renderer's autosave already surfaces and retries save failures.
      throw new Error('workspace:save from a sender that owns no window')
    }
    await store.saveSlice(windowId, json, captureWindowGeometry(windowId))
    // WHY replacement commit follows the write: a successful spawn response
    // is not durable renderer ownership. If reload destroys the renderer before
    // its remapped local ID reaches workspace.json, main must retain the
    // predecessor transaction so rehydrate can stop the hidden successor and
    // restore the still-owned predecessor ID.
    //
    // WHY the union across every window rather than this window's ids: the
    // manager is asking a process-wide question — "which local ids has SOME
    // renderer committed" — and answering it with one window's set would tell
    // the manager that another window's live, persisted sessions are unclaimed.
    manager.acknowledgePersistedSessionOwnership(store.sessionIds())
  })

  // Renderer calls this on first launch when there's no saved state
  // and no user-picked cwd yet. AGENT_CODE_CWD overrides — useful in
  // dev for launching the app pointed at a specific test project.
  ipcMain.handle('workspace:default-cwd', () => {
    return process.env.AGENT_CODE_CWD || process.cwd()
  })
}
