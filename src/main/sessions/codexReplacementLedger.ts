import type {
  SessionOwnershipOptions,
  SessionRecoverResult,
} from '@shared/types/session.js'
import type { SessionKind, SessionSpawnOptions } from '@preload/api/types.js'

export type CodexReplacementTeardownIntent =
  | 'explicit-close'
  | 'shutdown'
  | null

export type CodexReplacementReservation<TRecoveryClaim = unknown> = {
  transactionId: string
  predecessorSessionId: string
  successorSessionId: string
  predecessorOwnership: SessionOwnershipOptions | null
  successorOwnership: SessionOwnershipOptions
  restoreOptions: SessionSpawnOptions | null
  cancelled: boolean
  teardownIntent: CodexReplacementTeardownIntent
  reclaimRequested: boolean
  spawnOutcome: 'pending' | 'successor-live' | 'failed'
  spawnSettled: Promise<void>
  settleSpawn: () => void
  reclaimPromise: Promise<SessionRecoverResult> | null
  restorationClaim: TRecoveryClaim | null
}

export type CodexReplacementRedirect = {
  predecessorSessionId: string
  successorSessionId: string
  predecessorOwnership: SessionOwnershipOptions
  successorOwnership: SessionOwnershipOptions
  restoreOptions: SessionSpawnOptions
  cancelled: boolean
  reclaimPromise: Promise<SessionRecoverResult> | null
}

export type CodexReplacementReclaim<TRecoveryClaim> = {
  predecessorSessionId: string
  successorSessionId: string
  kind: SessionKind
  cwd: string
  recoveryTokens: Set<string>
  cancelled: boolean
  restorationClaim: TRecoveryClaim | null
  promise: Promise<SessionRecoverResult>
}

/**
 * Identity ledger for one-process Codex replacement lineages.
 *
 * WHY this is a separate substrate instead of three maps in SessionManager:
 * replacement policy has two valid routing IDs throughout its lifetime. Five
 * exact-head reviews found callers that remembered the predecessor key while
 * close/recovery arrived through the successor, or deleted one map without
 * preserving the cancellation evidence another caller needed. This ledger is
 * deliberately boring: it owns only bidirectional identity and identity-safe
 * mutation. SessionManager remains the sole executor of provider lifecycle.
 */
export class CodexReplacementLedger<TRecoveryClaim> {
  private readonly reservationsByPredecessor = new Map<
    string,
    CodexReplacementReservation<TRecoveryClaim>
  >()
  private readonly reservationsBySuccessor = new Map<
    string,
    CodexReplacementReservation<TRecoveryClaim>
  >()
  private readonly redirectsByPredecessor = new Map<
    string,
    CodexReplacementRedirect
  >()
  // Flattened replacement chains can legitimately leave several stale
  // predecessor IDs pointing at one current successor. A one-value reverse
  // index silently forgot all but the newest lineage, recreating the exact
  // partial-identity bug this ledger exists to prevent.
  private readonly redirectsBySuccessor = new Map<
    string,
    Set<CodexReplacementRedirect>
  >()
  private readonly reclaimsByPredecessor = new Map<
    string,
    CodexReplacementReclaim<TRecoveryClaim>
  >()
  // A token is addressed by the stale predecessor that requested it, while
  // admission is owned by the physical successor it will stop. Flattened
  // P→T/S→T aliases therefore need both indices: predecessor lookup keeps
  // cancellation generation-scoped; successor lookup prevents two teardown
  // bodies from starting for T and cancelling each other.
  private readonly reclaimsBySuccessor = new Map<
    string,
    CodexReplacementReclaim<TRecoveryClaim>
  >()

  registerReservation(
    reservation: CodexReplacementReservation<TRecoveryClaim>,
  ): void {
    if (
      this.reservationsByPredecessor.has(reservation.predecessorSessionId) ||
      this.reservationsBySuccessor.has(reservation.successorSessionId)
    ) {
      throw new Error('Codex replacement lineage is already reserved')
    }
    this.reservationsByPredecessor.set(
      reservation.predecessorSessionId,
      reservation,
    )
    this.reservationsBySuccessor.set(reservation.successorSessionId, reservation)
  }

  findReservation(
    sessionId: string,
  ): CodexReplacementReservation<TRecoveryClaim> | null {
    // A chained replacement can make S both the predecessor of S→T and the
    // successor of P→S. Prefer the newer transaction where S is the durable
    // predecessor, matching SessionManager's historical admission rule.
    return this.reservationsByPredecessor.get(sessionId) ??
      this.reservationsBySuccessor.get(sessionId) ??
      null
  }

  getReservationByPredecessor(
    predecessorSessionId: string,
  ): CodexReplacementReservation<TRecoveryClaim> | null {
    return this.reservationsByPredecessor.get(predecessorSessionId) ?? null
  }

  deleteReservation(
    reservation: CodexReplacementReservation<TRecoveryClaim>,
  ): boolean {
    if (
      this.reservationsByPredecessor.get(reservation.predecessorSessionId) !==
        reservation
    ) {
      return false
    }
    this.reservationsByPredecessor.delete(reservation.predecessorSessionId)
    if (
      this.reservationsBySuccessor.get(reservation.successorSessionId) ===
        reservation
    ) {
      this.reservationsBySuccessor.delete(reservation.successorSessionId)
    }
    return true
  }

  tombstoneReservationLineage(
    reservation: CodexReplacementReservation<TRecoveryClaim>,
  ): boolean {
    if (
      this.reservationsByPredecessor.get(reservation.predecessorSessionId) !==
        reservation ||
      !reservation.predecessorOwnership ||
      !reservation.restoreOptions
    ) {
      return false
    }

    // WHY this is one ledger transition: an acknowledged P→S redirect and an
    // unacknowledged S→T reservation represent one physical ownership chain.
    // Closing S or T must make both stale IDs terminal before the reservation
    // disappears. Publishing only S→T first leaves a re-entrant recovery path
    // through P→S; deleting first loses the identity needed to retarget it.
    for (const redirect of this.redirectsByPredecessor.values()) {
      if (redirect.successorSessionId !== reservation.predecessorSessionId) {
        continue
      }
      redirect.cancelled = true
      this.retargetRedirect(
        redirect,
        reservation.successorOwnership,
      )
    }
    this.setRedirect({
      predecessorSessionId: reservation.predecessorSessionId,
      successorSessionId: reservation.successorSessionId,
      predecessorOwnership: reservation.predecessorOwnership,
      successorOwnership: reservation.successorOwnership,
      restoreOptions: reservation.restoreOptions,
      cancelled: true,
      reclaimPromise: null,
    })
    return this.deleteReservation(reservation)
  }

  reservations(): IterableIterator<CodexReplacementReservation<TRecoveryClaim>> {
    return this.reservationsByPredecessor.values()
  }

  setRedirect(redirect: CodexReplacementRedirect): void {
    const previous = this.redirectsByPredecessor.get(
      redirect.predecessorSessionId,
    )
    if (previous) this.removeSuccessorRedirect(previous)
    this.redirectsByPredecessor.set(redirect.predecessorSessionId, redirect)
    this.addSuccessorRedirect(redirect)
  }

  findRedirects(sessionId: string): CodexReplacementRedirect[] {
    const result: CodexReplacementRedirect[] = []
    const predecessor = this.redirectsByPredecessor.get(sessionId)
    if (predecessor) result.push(predecessor)
    for (const redirect of this.redirectsBySuccessor.get(sessionId) ?? []) {
      if (redirect !== predecessor) result.push(redirect)
    }
    return result
  }

  getRedirectByPredecessor(
    predecessorSessionId: string,
  ): CodexReplacementRedirect | null {
    return this.redirectsByPredecessor.get(predecessorSessionId) ?? null
  }

  retargetRedirect(
    redirect: CodexReplacementRedirect,
    successorOwnership: SessionOwnershipOptions,
  ): void {
    if (
      this.redirectsByPredecessor.get(redirect.predecessorSessionId) !== redirect
    ) {
      return
    }
    this.removeSuccessorRedirect(redirect)
    redirect.successorSessionId = successorOwnership.sessionId
    redirect.successorOwnership = successorOwnership
    // WHY restoreOptions are deliberately not retargeted: a flattened P→T and
    // S→T lineage shares its current physical owner, but P and S can have
    // different durable cwd/launch contexts. Those options belong to the stale
    // predecessor identity whose ownership proof will admit reclaim. Copying
    // S→T's context into P→T can restore P in the wrong project after reload.
    this.addSuccessorRedirect(redirect)
  }

  deleteRedirect(redirect: CodexReplacementRedirect): boolean {
    if (
      this.redirectsByPredecessor.get(redirect.predecessorSessionId) !== redirect
    ) {
      return false
    }
    this.redirectsByPredecessor.delete(redirect.predecessorSessionId)
    this.removeSuccessorRedirect(redirect)
    return true
  }

  redirects(): IterableIterator<CodexReplacementRedirect> {
    return this.redirectsByPredecessor.values()
  }

  private addSuccessorRedirect(redirect: CodexReplacementRedirect): void {
    const redirects = this.redirectsBySuccessor.get(redirect.successorSessionId) ??
      new Set<CodexReplacementRedirect>()
    redirects.add(redirect)
    this.redirectsBySuccessor.set(redirect.successorSessionId, redirects)
  }

  private removeSuccessorRedirect(redirect: CodexReplacementRedirect): void {
    const redirects = this.redirectsBySuccessor.get(redirect.successorSessionId)
    if (!redirects) return
    redirects.delete(redirect)
    if (redirects.size === 0) {
      this.redirectsBySuccessor.delete(redirect.successorSessionId)
    }
  }

  setReclaim(reclaim: CodexReplacementReclaim<TRecoveryClaim>): boolean {
    if (
      this.reclaimsByPredecessor.has(reclaim.predecessorSessionId) ||
      this.reclaimsBySuccessor.has(reclaim.successorSessionId)
    ) {
      return false
    }
    this.reclaimsByPredecessor.set(reclaim.predecessorSessionId, reclaim)
    this.reclaimsBySuccessor.set(reclaim.successorSessionId, reclaim)
    return true
  }

  getReclaim(
    predecessorSessionId: string,
  ): CodexReplacementReclaim<TRecoveryClaim> | null {
    return this.reclaimsByPredecessor.get(predecessorSessionId) ?? null
  }

  getReclaimBySuccessor(
    successorSessionId: string,
  ): CodexReplacementReclaim<TRecoveryClaim> | null {
    return this.reclaimsBySuccessor.get(successorSessionId) ?? null
  }

  deleteReclaim(reclaim: CodexReplacementReclaim<TRecoveryClaim>): boolean {
    if (
      this.reclaimsByPredecessor.get(reclaim.predecessorSessionId) !== reclaim
    ) {
      return false
    }
    this.reclaimsByPredecessor.delete(reclaim.predecessorSessionId)
    if (this.reclaimsBySuccessor.get(reclaim.successorSessionId) === reclaim) {
      this.reclaimsBySuccessor.delete(reclaim.successorSessionId)
    }
    return true
  }

  reclaims(): IterableIterator<CodexReplacementReclaim<TRecoveryClaim>> {
    return this.reclaimsByPredecessor.values()
  }
}
