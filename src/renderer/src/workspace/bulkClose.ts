import type { SessionRuntime } from '@renderer/session-runtime/state'
import type {
  CloseTargetSnapshot,
  PartialCloseOutcome,
} from '@renderer/workspace/closeConfirmation'
import type { CloseRefusalReason, CloseSessionOptions } from '@renderer/workspace/hook/actions/pane'
import type { SessionId, WorkspaceState } from '@renderer/workspace/types'

// ---------------------------------------------------------------------------
// Executing a bulk close the user has already approved.
//
// Two surfaces end a whole list of sessions in one approval: Close Old Agents
// (its modal is the preview) and Close Idle Orchestration Agents (the close
// confirmation dialog is). Both need the guarantees #886 paid for:
//
//   - the grant is the list the user SAW, with the activity they saw. Nothing
//     outside it dies, and nothing that changed since it was shown dies;
//   - every kill re-judges its own target against LIVE state at the kill
//     boundary, because agents wake up, finish, and move between the click and
//     the tenth kill;
//   - owned sessions close before the session that owns them;
//   - one failed kill does not abandon the rest, and the report says why each
//     survivor survived.
//
// This module is that loop, once. It used to live inside CloseOldAgentsModal;
// a second bulk surface would otherwise have been a second copy of destructive
// safety code whose drift no test compares.
// ---------------------------------------------------------------------------

export type BulkCloseSession = (
  sessionId: SessionId,
  options: CloseSessionOptions,
) => Promise<boolean>

/**
 * Re-derive ONE granted target from the given state, or null when it no longer
 * qualifies for this bulk operation (gone, out of scope, or no longer matching
 * the surface's own filter such as "old" or "idle").
 *
 * MUST be synchronous and read only its arguments. It runs as closeSession's
 * `onlyIf`, inside the kill boundary where no await may separate the verdict
 * from the kill request, and the arguments are the action's live refs rather
 * than a React-committed snapshot.
 */
export type CurrentBulkCloseTarget = (
  state: WorkspaceState,
  runtimes: Record<SessionId, SessionRuntime>,
  sessionId: SessionId,
) => CloseTargetSnapshot | null

/**
 * How many owning sessions sit above this one, cycle-safe.
 *
 * WHY both ownership edges: a linked agent is lifecycle-bound to its
 * `linkedParentId` (closeSession keeps a parent while a linked child is still
 * open), and an orchestration worker to its `orchestrationParentId` (Close Idle
 * Orchestration Agents keeps a coordinator while one of its workers is still
 * open). Closing deeper sessions first lets both rules find the children
 * already gone instead of refusing the owner. Ordering never widens what dies:
 * every member is still judged on its own at its kill boundary.
 */
function ownershipDepth(sessions: WorkspaceState['sessions'], sessionId: SessionId): number {
  const seen = new Set<SessionId>()
  let current: SessionId = sessionId
  while (!seen.has(current)) {
    const meta = sessions[current]
    const owner = meta?.linkedParentId ?? meta?.orchestrationParentId
    if (owner === undefined) break
    seen.add(current)
    current = owner
  }
  return seen.size
}

/**
 * Close every granted session, deepest owner chain first, and report what
 * happened to each.
 *
 * WHY there is no pre-call revalidation here: CloseOldAgentsModal used to
 * re-enumerate each target before calling closeSession, from the modal's
 * React-committed workspace. That check was strictly weaker than the `onlyIf`
 * below, which runs synchronously at the kill boundary against the action's
 * live refs, and a target it dropped landed in the same `skipped` bucket that an
 * `onlyIf` refusal does (onRefused 'changed'; an already-closed session returns
 * false before any refusal and is skipped too). Two checks that can only agree
 * or have the weaker one lose is one check too many.
 */
export async function closeGrantedSessions(params: {
  /** Exactly what the user approved, with the liveness they were shown. */
  granted: readonly CloseTargetSnapshot[]
  /** Session metadata at approval. Used only to order the kills. */
  sessions: WorkspaceState['sessions']
  closeSession: BulkCloseSession
  currentTarget: CurrentBulkCloseTarget
}): Promise<PartialCloseOutcome> {
  const outcome: PartialCloseOutcome = { closed: [], failed: [], kept: [], skipped: [] }
  // Array.prototype.sort is stable, so sessions at the same depth keep the
  // order the user was shown.
  const ordered = [...params.granted].sort(
    (a, b) => ownershipDepth(params.sessions, b.sessionId) - ownershipDepth(params.sessions, a.sessionId),
  )

  // Sequential on purpose. closeSession mutates the tile tree, the Dispatch
  // map, the runtime maps and linked children; concurrent closes would each read
  // a stale snapshot and could drop layout bookkeeping. Bulk cleanup is rare
  // enough that predictable mutation beats raw speed.
  for (const target of ordered) {
    try {
      // Holder object rather than a `let`: TypeScript keeps a `let` narrowed to
      // its initial value across the callback assignment.
      const refusal: { reason?: CloseRefusalReason } = {}
      const closed = await params.closeSession(target.sessionId, {
        // preConfirmed: the calling surface IS the confirmation. It showed the
        // exact list and required an explicit click, which is a stronger grant
        // than the generic per-close dialog, and that dialog would otherwise
        // fire once per session. closeSession narrows a preConfirmed grant to
        // the one session named, so a linked child the user never saw keeps its
        // parent open instead of dying with it.
        preConfirmed: true,
        // A purge of N sessions would push N Undo Close entries and evict the
        // user's own close history from the 10-entry stack, so ⌘⇧T would
        // resurrect something they had just cleared on purpose.
        captureUndo: false,
        // The grant stays honest at the kill boundary: the target must still
        // qualify, and a session approved while idle must not be killed once
        // it has started working.
        onlyIf: (state, runtimes) => {
          const current = params.currentTarget(state, runtimes, target.sessionId)
          return current !== null && (!current.live || target.live)
        },
        // closeSession's boolean cannot say WHY it refused, and a parent kept
        // for a still-open linked child is not a "changed" skip (#886 review m7).
        onRefused: reason => { refusal.reason = reason },
      })
      if (closed) outcome.closed.push(target.sessionId)
      else if (refusal.reason === 'linked-session-open') outcome.kept.push(target.sessionId)
      else outcome.skipped.push(target.sessionId)
    } catch (error) {
      // The user asked for the whole list closed; nine of twelve closing is a
      // better outcome than stopping at the first backend refusal with no report.
      outcome.failed.push({ sessionId: target.sessionId, error })
    }
  }
  return outcome
}
