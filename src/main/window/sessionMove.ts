import type {
  SessionMoveCancelled,
  SessionMoveCommitted,
  SessionMoveFailed,
  SessionMoveOffer,
  SessionMoveStartRequest,
  SessionMoveStartResult,
} from '@shared/types/sessionMove.js'
import type { SessionWindowLease } from '@main/window/sessionWindowRouter.js'

// Moving agents between two LIVE windows (#1481).
//
// The only cross-window handover before this was a window CLOSE (the bequest
// in main/index.ts and ipc/window.ts). A move reuses its ordering, which is
// what keeps a session from ever being owned by nobody:
//
//   1. routing moves to the target FIRST, before the target hears about the
//      session, so events emitted mid-handoff reach the window about to show
//      them (the router holds them in its bounded queue until it can);
//   2. the target merges, saves DURABLY, and only then confirms;
//   3. only then is the source told to drop its rows. The source never kills
//      anything, and main never kills a session because a slice stopped
//      listing it (commitDurableOwnership retires only Codex predecessors).
//
// Between 2 and 3 both windows' slices list the session. A crash in that gap
// restores a duplicate row whose claim the router refuses in one window,
// which is recoverable. The other order (source drops first) has a gap where
// NO slice lists a live agent, which is a lost agent. Duplicate over loss.
//
// WHY a coordinator object with injected routing instead of free functions
// over windowRegistry like the bequest: a move can fail in three different
// ways (refused, deadline, a window gone) and each must roll back exactly the
// claims it made and nothing newer. Those rules are the part worth testing,
// and they can only be tested without Electron if the router operations are
// passed in.

/** How long the target has to merge, save and confirm. A real save is a
 *  ~400 ms debounce plus one atomic write. The deadline exists for the target
 *  that will never answer (crashed or reloaded renderer, read-only store), so
 *  it is generous rather than tight. */
export const SESSION_MOVE_DEADLINE_MS = 20_000

/** Upper bounds on a request. A move carries one agent and its descendants;
 *  these are far past any real tree and exist only so a malformed request
 *  cannot make main walk or hold an unbounded payload. */
const MAX_SESSIONS_PER_MOVE = 256
const MAX_PACKET_BYTES = 8 * 1024 * 1024

export type SessionMoveDependencies = {
  /** The current claim for a session, or null when nobody owns it. */
  ownerOf: (sessionId: string) => SessionWindowLease | null
  claim: (sessionId: string, windowId: string) => SessionWindowLease | null
  transfer: (sessionId: string, windowId: string) => SessionWindowLease | null
  release: (lease: SessionWindowLease) => boolean
  /** Tell the session's current owner it missed observations (router gap),
   *  so it resynchronizes. Used after routing goes back to the source. */
  markGap: (sessionId: string) => void
  isWindowReady: (windowId: string) => boolean
  /** Null when the window is not registered (closed). */
  rendererGeneration: (windowId: string) => number | null
  /** 1-based display order, matching `app.windows`. Null when not registered. */
  windowNumber: (windowId: string) => number | null
  send: (windowId: string, channel: string, payload: unknown) => boolean
  setTimer: (callback: () => void, ms: number) => unknown
  clearTimer: (handle: unknown) => void
  newId: () => string
}

type MovedClaim = {
  sessionId: string
  /** What main did to route it to the target. A session nobody owned (a
   *  parked agent) is CLAIMED for the target so the source cannot wake and
   *  claim it mid-move; one the source owned is TRANSFERRED. A rollback undoes
   *  each differently: a transfer goes back to the source, a claim is released
   *  so the session is unowned again, exactly as it was. */
  kind: 'transferred' | 'claimed'
  /** The lease main created. A rollback acts only while this is still the
   *  router's claim (identity), so it can never undo a newer claim. */
  made: SessionWindowLease | null
}

type PendingMove = {
  moveId: string
  sourceWindowId: string
  targetWindowId: string
  /** The target renderer this offer was sent to. A confirmation from a reloaded
   *  renderer is not evidence that the rows were saved; it never saw them. */
  targetGeneration: number | null
  targetWindowNumber: number
  sessionIds: string[]
  claims: MovedClaim[]
  timer: unknown
}

export class SessionMoveCoordinator {
  private readonly pending = new Map<string, PendingMove>()
  /** sessionId → moveId, so one session is never in two moves at once. Two
   *  concurrent moves of one agent would race their rollbacks and confirms,
   *  and each could legitimately "win" on a different window. */
  private readonly moving = new Map<string, string>()

  constructor(private readonly deps: SessionMoveDependencies) {}

  start(sourceWindowId: string, request: SessionMoveStartRequest): SessionMoveStartResult {
    const invalid = validateRequest(request)
    if (invalid) return { ok: false, reason: 'invalid-request', message: invalid }
    const { targetWindowId } = request
    const sessionIds = [...new Set(request.sessionIds)]
    if (targetWindowId === sourceWindowId) {
      return { ok: false, reason: 'same-window', message: 'The agent is already in that window.' }
    }
    const targetWindowNumber = this.deps.windowNumber(targetWindowId)
    if (targetWindowNumber === null || !this.deps.isWindowReady(targetWindowId)) {
      return { ok: false, reason: 'target-unavailable', message: 'That window is not ready. Try again in a moment.' }
    }
    if (sessionIds.some(id => this.moving.has(id))) {
      return { ok: false, reason: 'already-moving', message: 'That agent is already being moved.' }
    }
    // WHY a session owned by a THIRD window is refused rather than taken: the
    // requesting renderer says it holds these rows, but the router says
    // another live window displays one of them. Moving it would strand that
    // window's pane on a session it no longer receives events for, and the
    // request has no authority over that window.
    const owners = sessionIds.map(id => this.deps.ownerOf(id))
    if (owners.some(owner => owner !== null && owner.windowId !== sourceWindowId)) {
      return { ok: false, reason: 'foreign-owner', message: 'Another window shows that agent.' }
    }

    const claims: MovedClaim[] = sessionIds.map((sessionId, index) => owners[index]
      ? { sessionId, kind: 'transferred', made: this.deps.transfer(sessionId, targetWindowId) }
      : { sessionId, kind: 'claimed', made: this.deps.claim(sessionId, targetWindowId) })
    const moveId = this.deps.newId()
    const move: PendingMove = {
      moveId,
      sourceWindowId,
      targetWindowId,
      targetGeneration: this.deps.rendererGeneration(targetWindowId),
      targetWindowNumber,
      sessionIds,
      claims,
      timer: null,
    }
    this.pending.set(moveId, move)
    for (const id of sessionIds) this.moving.set(id, moveId)
    move.timer = this.deps.setTimer(() => this.expire(moveId), SESSION_MOVE_DEADLINE_MS)

    const offer: SessionMoveOffer = { moveId, sourceWindowId, sessionIds, packet: request.packet }
    if (!this.deps.send(targetWindowId, 'workspace:receive-sessions', offer)) {
      // The window disappeared between the readiness check and the send.
      // Nothing was merged anywhere, so only routing needs undoing; the source
      // learns from the refusal result, not from a failure event.
      this.finish(move)
      this.rollback(move)
      return { ok: false, reason: 'target-unavailable', message: 'That window closed.' }
    }
    return { ok: true, moveId, targetWindowNumber }
  }

  /** The target saved the merged rows durably. Only now may the source drop them. */
  complete(senderWindowId: string, moveId: string): void {
    const move = this.authorized(senderWindowId, moveId)
    if (!move) return
    this.finish(move)
    const committed: SessionMoveCommitted = {
      moveId,
      sessionIds: move.sessionIds,
      targetWindowNumber: move.targetWindowNumber,
    }
    // A false send means the source window closed mid-move. Its slice still
    // lists the sessions and will be offered to a survivor as a bequest; that
    // adoption refuses the id collision and leaves the slice for next launch.
    // A duplicate row, never a lost agent (see the header).
    this.deps.send(move.sourceWindowId, 'workspace:sessions-moved-out', committed)
  }

  /** The target could not merge (collision, unreadable packet). Nothing of it
   *  became durable there, so routing goes home and the source keeps the rows. */
  refuse(senderWindowId: string, moveId: string, message: string): void {
    const move = this.authorized(senderWindowId, moveId)
    if (!move) return
    this.finish(move)
    this.rollback(move)
    const failed: SessionMoveFailed = { moveId, message: message.slice(0, 500) || 'The other window refused the move.' }
    this.deps.send(move.sourceWindowId, 'workspace:session-move-failed', failed)
  }

  /** Test seam and diagnostics: how many moves are awaiting confirmation. */
  pendingCount(): number {
    return this.pending.size
  }

  private expire(moveId: string): void {
    const move = this.pending.get(moveId)
    if (!move) return
    this.finish(move)
    this.rollback(move)
    // WHY the target is told as well as the source: a target that merged but
    // never managed to save (a read-only store refuses every save, so the
    // confirmation never comes) is DISPLAYING the rows. Routing has just gone
    // back to the source, so those panes would sit dead in the target forever.
    // It removes what it merged, rows only, never a kill.
    const cancelled: SessionMoveCancelled = { moveId, sessionIds: move.sessionIds }
    this.deps.send(move.targetWindowId, 'workspace:session-move-cancelled', cancelled)
    const failed: SessionMoveFailed = {
      moveId,
      message: `Window ${move.targetWindowNumber} did not confirm the move in time. The agent stays here.`,
    }
    this.deps.send(move.sourceWindowId, 'workspace:session-move-failed', failed)
  }

  private authorized(senderWindowId: string, moveId: string): PendingMove | null {
    const move = typeof moveId === 'string' ? this.pending.get(moveId) : undefined
    // Same authority rule as `window:adoption-complete`: only the window the
    // offer went to, and only the renderer generation that received it, may
    // settle it. Anything else is ignored rather than honored, because a
    // confirmation makes the SOURCE drop rows and that cannot be undone.
    if (!move || move.targetWindowId !== senderWindowId) return null
    if (move.targetGeneration !== this.deps.rendererGeneration(move.targetWindowId)) return null
    return move
  }

  private finish(move: PendingMove): void {
    this.pending.delete(move.moveId)
    for (const id of move.sessionIds) {
      if (this.moving.get(id) === move.moveId) this.moving.delete(id)
    }
    if (move.timer !== null) this.deps.clearTimer(move.timer)
  }

  private rollback(move: PendingMove): void {
    const sourceAlive = this.deps.rendererGeneration(move.sourceWindowId) !== null
    for (const claim of move.claims) {
      const owner = this.deps.ownerOf(claim.sessionId)
      // The claim is this move's to undo while it is the lease main made, OR
      // a newer claim by the TARGET window itself (#1481 review): the target
      // shows the moved agent in its focused lane, and waking a parked agent
      // there re-claims it through `session:recover`, rotating the lease. The
      // target is about to drop those rows (cancel), so leaving routing with
      // it would strand the agent where no window displays it. A claim by any
      // OTHER window (the agent moved on again, a third window recovered it)
      // is newer and not ours, which is what the identity check protects.
      if (!owner || !(owner === claim.made || owner.windowId === move.targetWindowId)) continue
      if (claim.kind === 'transferred' && sourceAlive) {
        this.deps.transfer(claim.sessionId, move.sourceWindowId)
        // Whatever the target received meanwhile never reached the source, and
        // `transfer` only replays what was still queued. Mark a gap so the
        // source's routing-gap repair re-reads readiness, conditions and
        // history instead of keeping its pre-move view (#1481 review).
        this.deps.markGap(claim.sessionId)
      } else {
        this.deps.release(owner)
      }
    }
  }
}

function validateRequest(request: SessionMoveStartRequest): string | null {
  if (!request || typeof request !== 'object') return 'Malformed move request.'
  if (typeof request.targetWindowId !== 'string' || request.targetWindowId.length === 0) return 'No target window.'
  if (!Array.isArray(request.sessionIds) || request.sessionIds.length === 0) return 'No agents to move.'
  if (request.sessionIds.length > MAX_SESSIONS_PER_MOVE) return 'Too many agents in one move.'
  if (request.sessionIds.some(id => typeof id !== 'string' || id.length === 0 || id.length > 512)) return 'Malformed agent id.'
  if (typeof request.packet !== 'string' || request.packet.length > MAX_PACKET_BYTES) return 'Malformed move payload.'
  return null
}
