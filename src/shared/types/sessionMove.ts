// Wire types for moving agents between two LIVE windows (#1481).
//
// WHY these live in shared/ rather than beside either end: main, preload and
// the renderer all name them, and the protocol only stays correct while all
// three agree on every message. A copy in each process is exactly the drift
// the control SDK's "one declaration, consumers import it" rule exists to stop.
//
// WHY the moved rows travel as an opaque `packet` string: main deliberately
// treats a window's workspace as bytes it does not model (storage/workspaceFile.ts,
// adoptWorkspace.ts). Ownership, projects, pins and drafts are renderer
// concepts. Main's job in a move is only routing authority, so it validates
// the session ids it moves routing for and passes the rest through untouched.

/** Main refuses up front for these; nothing has moved when one is returned. */
export type SessionMoveRefusal =
  | 'invalid-request'
  | 'same-window'
  | 'target-unavailable'
  | 'foreign-owner'
  | 'already-moving'

export type SessionMoveStartRequest = {
  targetWindowId: string
  /** Every session the packet carries: the agent and its descendants. */
  sessionIds: string[]
  /** JSON of `SessionMovePacket` (renderer workspace/sessionMove.ts). */
  packet: string
}

export type SessionMoveStartResult =
  | { ok: true; moveId: string; targetWindowNumber: number }
  | { ok: false; reason: SessionMoveRefusal; message: string }

/** main → target: merge these rows, then confirm after a durable save. */
export type SessionMoveOffer = {
  moveId: string
  sourceWindowId: string
  sessionIds: string[]
  packet: string
}

/** main → source: the target has durably saved the rows; drop yours. */
export type SessionMoveCommitted = {
  moveId: string
  sessionIds: string[]
  targetWindowNumber: number
}

/** main → source: the move did not happen; you still own everything. */
export type SessionMoveFailed = {
  moveId: string
  message: string
}

/** main → target: give back what you merged for this move (rows only). */
export type SessionMoveCancelled = {
  moveId: string
  sessionIds: string[]
}

/** One other window, labelled so a person can tell windows apart. */
export type SessionMoveTarget = {
  windowId: string
  /** Same numbering as `app.windows`, so the picker and operators agree. */
  number: number
  /** Project titles from the window's last saved workspace, in tab order. */
  projectTitles: string[]
  sessionCount: number
  /** The other window the user was in most recently. The picker starts on it,
   *  because that is usually where they want to send the work. */
  lastFocused: boolean
}
