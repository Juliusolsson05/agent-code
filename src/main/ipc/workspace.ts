import { homedir } from 'node:os'

import { ipcMain } from 'electron'

import type { SessionManager } from '@main/sessionManager.js'
import type { WorkspaceFileStore } from '@main/storage/workspaceFileStore.js'
import { captureWindowGeometry } from '@main/window/windowGeometry.js'
import { captureSessionWindowLease, releaseSession, windowIdFor } from '@main/window/windowRegistry.js'

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

/**
 * Tell the manager which local ids are now durably owned, and end the window
 * lease of every Codex handoff predecessor that commit retires.
 *
 * WHY a shared helper: the durable ownership set changes in TWO places, a
 * window's save and the removal of a closed window's slice once a survivor
 * confirmed adopting it (window:adoption-complete). Acknowledging only after
 * saves missed the second (#1338 review a): while a closed window's slice
 * still listed a predecessor, the survivor's save correctly committed
 * nothing, and when the slice was then removed nobody asked again, so the
 * handoff and its lease stayed pending until some unrelated later save.
 * Callers run this only after the change is on disk.
 */
export function commitDurableOwnership(
  manager: Pick<SessionManager, 'acknowledgePersistedSessionOwnership'>,
  store: Pick<WorkspaceFileStore, 'sessionIds'>,
): void {
  const retired = manager.acknowledgePersistedSessionOwnership(store.sessionIds())
  // A committed Codex same-rollout handoff retired these predecessors
  // (#1283 item 2). The renderer never calls killOwnedSession for them,
  // because main already stopped their process, so this is the only place
  // their window lease can be released. Before this commit the lease had to
  // stay (a failed successor start restores the predecessor); after it,
  // nothing displays the old id. Left alone, it kept an entry in the
  // router's owner map for the whole app run: revisited (and a gap recorded
  // for it) on every renderer reload, bequeathed to the surviving window on
  // a window close, refusing another window's claim, and, until the owning
  // window's first reload, still routing late events and P-scoped requests
  // to it (#1338 review c). The release is process-wide, whichever window's
  // save committed the handoff. A stale renderer that later recovers the id
  // claims a fresh lease through session:recover like any recovery.
  for (const sessionId of retired) releaseSession(captureSessionWindowLease(sessionId))
}

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
      // renderer's autosave retries a failed save with backoff and, after
      // repeated failures, shows the error in RestoreBanner (#1244).
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
    commitDurableOwnership(manager, store)
  })

  // Renderer calls this on first launch when there's no saved state
  // and no user-picked cwd yet. AGENT_CODE_CWD overrides — useful in
  // dev for launching the app pointed at a specific test project.
  ipcMain.handle('workspace:default-cwd', () => defaultWorkspaceCwd())
}

/**
 * The first project's directory.
 *
 * WHY home instead of `/` (#995): an app launched from Finder or the Dock is
 * started by launchd with cwd `/`, so every fresh install's first project was
 * the filesystem root. There an agent's first `ls` lists system folders, the
 * project title reads "/", and anything the agent writes is refused or lands
 * somewhere nobody meant. `process.cwd()` is kept when it is anything else:
 * `npm run dev` from a checkout, or a terminal `open -a` that passes a real
 * directory, still starts where the developer was.
 */
export function defaultWorkspaceCwd(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  home: string = homedir(),
): string {
  if (env.AGENT_CODE_CWD) return env.AGENT_CODE_CWD
  return cwd === '/' ? home : cwd
}
