import { randomUUID } from 'node:crypto'
import { ipcMain } from 'electron'

import { commitDurableOwnership } from '@main/ipc/workspace.js'
import type { SessionManager } from '@main/sessionManager.js'
import type { WorkspaceFileStore } from '@main/storage/workspaceFileStore.js'
import {
  claimSessionForWindow,
  createAppWindow,
  captureSessionWindowLease,
  isWindowRendererReady,
  listWindowIds,
  markSessionRoutingGap,
  releaseSession,
  sendToWindow,
  transferSession,
  windowIdsByRecentFocus,
  windowIdFor,
  windowRendererGeneration,
} from '@main/window/windowRegistry.js'
import { SessionMoveCoordinator } from '@main/window/sessionMove.js'
import type { SessionWindowLease } from '@main/window/sessionWindowRouter.js'
import type { SessionMoveStartRequest, SessionMoveStartResult, SessionMoveTarget } from '@shared/types/sessionMove.js'

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
  /** Exact routing claims moved to the survivor when the offer was made. */
  leases: Array<SessionWindowLease | null>
  survivorGeneration: number | null
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
  pendingBequests.set(closedWindowId, {
    survivorWindowId,
    leases: sessionIds.map(captureSessionWindowLease),
    survivorGeneration: windowRendererGeneration(survivorWindowId),
  })
}

/**
 * Give up on an offer without deleting anything.
 *
 * Used when the offer could not even be composed (the closed window had no
 * persisted slice). The sessions go back to being unowned, which routes their
 * events to bounded ownership-repair metadata. A refusal never broadens
 * content recipients, and cannot release a newer claim admitted meanwhile.
 */
export function abandonPendingBequest(closedWindowId: string): void {
  const pending = pendingBequests.get(closedWindowId)
  if (!pending) return
  pendingBequests.delete(closedWindowId)
  for (const lease of pending.leases) releaseSession(lease)
}

/**
 * The live-window move coordinator (#1481), bound to the real window registry.
 *
 * WHY module scope rather than built inside registerWindowIpc: there is one
 * router and one set of windows per process, so there must be one set of
 * pending moves. A second coordinator (a test re-registering IPC, or a future
 * second caller) would let two moves of one agent race each other's rollback.
 */
const sessionMoves = new SessionMoveCoordinator({
  ownerOf: captureSessionWindowLease,
  claim: (sessionId, windowId) => claimSessionForWindow(sessionId, windowId),
  transfer: transferSession,
  release: lease => releaseSession(lease),
  markGap: markSessionRoutingGap,
  isWindowReady: isWindowRendererReady,
  rendererGeneration: windowRendererGeneration,
  windowNumber: windowId => {
    const index = listWindowIds().indexOf(windowId)
    return index >= 0 ? index + 1 : null
  },
  send: (windowId, channel, payload) => sendToWindow(windowId, channel, payload),
  setTimer: (callback, ms) => setTimeout(callback, ms),
  clearTimer: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
  newId: randomUUID,
})

export function registerWindowIpc(
  store: WorkspaceFileStore,
  manager: Pick<SessionManager, 'acknowledgePersistedSessionOwnership'>,
): void {
  ipcMain.handle('window:new', () => {
    // A brand-new window gets a fresh id and therefore no persisted slice, so
    // its renderer takes the same `workspace:load → null` path as a fresh
    // install: one default agent in the default cwd. That is the intended
    // meaning of New Window — its own workspace, not a copy of this one.
    createAppWindow()
  })

  ipcMain.handle('window:adoption-complete', async (evt, windowId: string) => {
    const pending = pendingBequests.get(windowId)
    if (
      !pending || pending.survivorWindowId !== windowIdFor(evt.sender) ||
      pending.survivorGeneration !== windowRendererGeneration(pending.survivorWindowId)
    ) {
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
    // Dropping the slice changes the durable ownership set just as a save
    // does: a Codex handoff whose predecessor only this slice still listed
    // can commit now (#1338 review a). See commitDurableOwnership.
    commitDurableOwnership(manager, store)
  })

  ipcMain.handle('window:adoption-refused', (evt, windowId: string) => {
    const pending = pendingBequests.get(windowId)
    if (
      !pending || pending.survivorWindowId !== windowIdFor(evt.sender) ||
      pending.survivorGeneration !== windowRendererGeneration(pending.survivorWindowId)
    ) return
    // The slice is deliberately NOT removed: the workspace comes back as its
    // own window on the next launch, with everything intact. Ownership is
    // rolled back so the sessions do not stay pinned to a window that refused
    // to display them, which would accumulate ghost runtimes there forever.
    abandonPendingBequest(windowId)
  })

  // ── Live-window moves (#1481) ──────────────────────────────────────────
  //
  // The other open windows, labelled for a person. `number` is the same
  // display order `app.windows` publishes, so a root-management agent and the
  // picker name windows identically.
  ipcMain.handle('window:move-targets', (evt): SessionMoveTarget[] => {
    const sourceWindowId = windowIdFor(evt.sender)
    const lastFocused = windowIdsByRecentFocus().find(windowId => windowId !== sourceWindowId)
    // Not-ready windows (closing, or a renderer still loading) are left out
    // rather than offered and then refused with a failure toast. `number`
    // still comes from the unfiltered order so it matches app.windows.
    return listWindowIds().flatMap((windowId, index) => windowId === sourceWindowId || !isWindowRendererReady(windowId) ? [] : [{
      windowId,
      number: index + 1,
      ...store.describeWindow(windowId),
      lastFocused: windowId === lastFocused,
    }])
  })

  ipcMain.handle('window:send-sessions', (evt, request: SessionMoveStartRequest): SessionMoveStartResult => {
    const sourceWindowId = windowIdFor(evt.sender)
    if (!sourceWindowId) return { ok: false, reason: 'invalid-request', message: 'This window is not registered.' }
    return sessionMoves.start(sourceWindowId, request)
  })

  ipcMain.handle('window:session-move-complete', (evt, moveId: string) => {
    const windowId = windowIdFor(evt.sender)
    if (windowId) sessionMoves.complete(windowId, moveId)
  })

  ipcMain.handle('window:session-move-refused', (evt, moveId: string, message: string) => {
    const windowId = windowIdFor(evt.sender)
    if (windowId) sessionMoves.refuse(windowId, moveId, typeof message === 'string' ? message : '')
  })
}
