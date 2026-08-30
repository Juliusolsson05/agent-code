import { ipcMain } from 'electron'

import type { WorkspaceFileStore } from '@main/storage/workspaceFileStore.js'
import {
  createAppWindow,
  releaseSession,
  windowIdFor,
} from '@main/window/windowRegistry.js'

// Window-chrome IPC, plus the confirmation half of the workspace handoff.
//
// WHY creating a window is main's job rather than a renderer command that main
// merely obeys: a window is not workspace state. It has no tabs to consult, no
// tile tree to mutate, and nothing about it depends on the requesting
// renderer's store — which is exactly the test `appMenu.ts` already applies
// when it keeps `role: 'close'` native while dispatching `close-tab` to the
// renderer.
//
// The command exists in the palette anyway, because that is where this app's
// users look for anything and it is what makes the action rebindable. Both
// entry points land here.

type PendingBequest = {
  /** The window that was offered the closed window's workspace. */
  survivorWindowId: string
  /** Sessions whose routing was moved to the survivor when the offer was made. */
  sessionIds: string[]
}

/**
 * Offers main has made and not yet resolved, keyed by the CLOSED window id.
 *
 * WHY main tracks these instead of trusting the confirmation: `removeWindow`
 * permanently drops a workspace, and without a record of what was offered, any
 * renderer could name any window id and delete a live window's slice. It also
 * makes the refusal path expressible — main needs to know which sessions to
 * un-route when a survivor declines.
 */
const pendingBequests = new Map<string, PendingBequest>()

export function recordPendingBequest(
  closedWindowId: string,
  survivorWindowId: string,
  sessionIds: string[],
): void {
  pendingBequests.set(closedWindowId, { survivorWindowId, sessionIds })
}

/**
 * Give up on an offer without deleting anything.
 *
 * Used when the offer could not even be composed (the closed window had no
 * persisted slice). The sessions go back to being unowned, which routes their
 * events to a broadcast and leaves a diagnostic breadcrumb — visible and
 * recoverable, rather than silently pinned to a window that will never show
 * them.
 */
export function abandonPendingBequest(closedWindowId: string): void {
  const pending = pendingBequests.get(closedWindowId)
  if (!pending) return
  pendingBequests.delete(closedWindowId)
  for (const sessionId of pending.sessionIds) releaseSession(sessionId)
}

export function registerWindowIpc(store: WorkspaceFileStore): void {
  ipcMain.handle('window:new', () => {
    // A brand-new window gets a fresh id and therefore no persisted slice, so
    // its renderer takes the same `workspace:load → null` path as a fresh
    // install: one default agent in the default cwd. That is the intended
    // meaning of New Window — its own workspace, not a copy of this one.
    createAppWindow()
  })

  ipcMain.handle('window:adoption-complete', async (evt, windowId: string) => {
    const pending = pendingBequests.get(windowId)
    if (!pending || pending.survivorWindowId !== windowIdFor(evt.sender)) {
      // Not an offer this window was made. Dropping a slice on an unverified
      // claim is unrecoverable for a window that closed with no survivor, so
      // an unmatched confirmation is ignored rather than honored.
      return
    }
    pendingBequests.delete(windowId)
    // The adopting renderer has DURABLY persisted the merge — it confirms from
    // its autosave success path, not from having merged in memory — so the
    // closed slice can finally be dropped. Any earlier and there would be an
    // interval in which neither the file nor any renderer held those sessions.
    await store.removeWindow(windowId)
  })

  ipcMain.handle('window:adoption-refused', (evt, windowId: string) => {
    const pending = pendingBequests.get(windowId)
    if (!pending || pending.survivorWindowId !== windowIdFor(evt.sender)) return
    // The slice is deliberately NOT removed: the workspace comes back as its
    // own window on the next launch, with everything intact. Ownership is
    // rolled back so the sessions do not stay pinned to a window that refused
    // to display them, which would accumulate ghost runtimes there forever.
    abandonPendingBequest(windowId)
  })
}
