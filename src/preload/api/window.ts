import { ipcRenderer } from 'electron'

import { subscribe } from '@preload/api/ipc.js'
import type { Unsub } from '@preload/api/types.js'
import type {
  SessionMoveCancelled,
  SessionMoveCommitted,
  SessionMoveFailed,
  SessionMoveOffer,
  SessionMoveStartRequest,
  SessionMoveStartResult,
  SessionMoveTarget,
} from '@shared/types/sessionMove.js'

// Window-chrome bridge.
//
// It stays its own domain module rather than joining `workspaceApi` because the
// two answer different questions: workspace persistence is about what is IN a
// window, this is about windows themselves.

/** A closed window handing its workspace to this one. `workspace` is the same
 *  `{ workspace: … }` JSON that `loadWorkspace` returns. */
export type WorkspaceAdoptRequest = {
  windowId: string
  workspace: string
}

export const windowApi = {
  newWindow: (): Promise<void> => ipcRenderer.invoke('window:new'),

  onWorkspaceAdopt: (cb: (request: WorkspaceAdoptRequest) => void): Unsub =>
    subscribe('workspace:adopt', cb),

  /**
   * Acknowledge that this window has DURABLY persisted a closed window's
   * workspace.
   *
   * WHY adoption is confirmed rather than assumed, and why it is confirmed from
   * the autosave success path rather than from the merge: main deletes the
   * closed window's persisted slice on this call, and until the adopting
   * renderer's next save actually commits, that slice is the ONLY durable
   * record of those sessions. Confirming on "I merged" would make any crash,
   * force-quit or reload in the following 400ms permanent data loss. A renderer
   * that refused the merge, failed to parse it, or died mid-handoff simply
   * never calls this, and the workspace comes back as its own window on the
   * next launch instead of being deleted.
   */
  confirmWorkspaceAdoption: (windowId: string): Promise<void> =>
    ipcRenderer.invoke('window:adoption-complete', windowId),

  /**
   * Decline a closed window's workspace.
   *
   * Main keeps the slice AND rolls back the session routing it moved here
   * optimistically. Staying silent instead would leave those sessions pinned to
   * a window that will never display them — alive, invisible, and accumulating
   * runtimes for panes that do not exist.
   */
  refuseWorkspaceAdoption: (windowId: string): Promise<void> =>
    ipcRenderer.invoke('window:adoption-refused', windowId),

  // ── Moving agents between live windows (#1481) ────────────────────────
  // The protocol and its ordering are documented on SessionMoveCoordinator
  // (main/window/sessionMove.ts). In short: routing moves first, the target
  // confirms only after a durable save, and only then does the source drop
  // its rows.

  /** The other open windows, labelled for the picker. */
  listSessionMoveTargets: (): Promise<SessionMoveTarget[]> =>
    ipcRenderer.invoke('window:move-targets'),

  /** Source: ask main to move routing and offer the rows to the target. */
  sendSessionsToWindow: (request: SessionMoveStartRequest): Promise<SessionMoveStartResult> =>
    ipcRenderer.invoke('window:send-sessions', request),

  /** Target: rows offered by another window. */
  onSessionMoveOffer: (cb: (offer: SessionMoveOffer) => void): Unsub =>
    subscribe('workspace:receive-sessions', cb),

  /** Target: the merged rows are DURABLE. Called from the autosave success
   *  path only, for the same reason as confirmWorkspaceAdoption: this makes
   *  the source drop its rows, and until this window's save commits, the
   *  source's slice is the only durable record of them. */
  confirmSessionMove: (moveId: string): Promise<void> =>
    ipcRenderer.invoke('window:session-move-complete', moveId),

  /** Target: could not merge. Routing goes back to the source. */
  refuseSessionMove: (moveId: string, message: string): Promise<void> =>
    ipcRenderer.invoke('window:session-move-refused', moveId, message),

  /** Source: the target committed; drop these rows WITHOUT killing them. */
  onSessionsMovedOut: (cb: (event: SessionMoveCommitted) => void): Unsub =>
    subscribe('workspace:sessions-moved-out', cb),

  /** Source: the move did not happen; nothing changed here. */
  onSessionMoveFailed: (cb: (event: SessionMoveFailed) => void): Unsub =>
    subscribe('workspace:session-move-failed', cb),

  /** Target: the move expired; remove what was merged for it (rows only). */
  onSessionMoveCancelled: (cb: (event: SessionMoveCancelled) => void): Unsub =>
    subscribe('workspace:session-move-cancelled', cb),
}
