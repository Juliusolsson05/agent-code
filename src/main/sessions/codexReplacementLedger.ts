import type {
  SessionOwnershipOptions,
  SessionRecoverResult,
} from '@shared/types/session.js'
import type { SessionKind, SessionSpawnOptions } from '@preload/api/types.js'

export type CodexReplacementTeardownIntent =
  | 'explicit-close'
  | 'shutdown'
  | null

export type CodexReplacementReservation = {
  transactionId: string
  predecessorSessionId: string
  successorSessionId: string
  predecessorOwnership: SessionOwnershipOptions | null
  restoreOptions: SessionSpawnOptions | null
  cancelled: boolean
  teardownIntent: CodexReplacementTeardownIntent
  reclaimRequested: boolean
  spawnOutcome: 'pending' | 'successor-live' | 'failed'
  spawnSettled: Promise<void>
  settleSpawn: () => void
  reclaimPromise: Promise<SessionRecoverResult> | null
}

export type CodexReplacementRedirect = {
  predecessorSessionId: string
  successorSessionId: string
  predecessorOwnership: SessionOwnershipOptions
  restoreOptions: SessionSpawnOptions
  cancelled: boolean
  reclaimPromise: Promise<SessionRecoverResult> | null
}

export type CodexReplacementReclaim<TRecoveryClaim> = {
  predecessorSessionId: string
  successorSessionId: string
  kind: SessionKind
  cwd: string
  recoveryToken: string
  cancelled: boolean
  compensationClaim: TRecoveryClaim | null
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
    CodexReplacementReservation
  >()
  private readonly reservationsBySuccessor = new Map<
    string,
    CodexReplacementReservation
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

  registerReservation(reservation: CodexReplacementReservation): void {
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

  findReservation(sessionId: string): CodexReplacementReservation | null {
    // A chained replacement can make S both the predecessor of S→T and the
    // successor of P→S. Prefer the newer transaction where S is the durable
    // predecessor, matching SessionManager's historical admission rule.
    return this.reservationsByPredecessor.get(sessionId) ??
      this.reservationsBySuccessor.get(sessionId) ??
      null
  }

  getReservationByPredecessor(
    predecessorSessionId: string,
  ): CodexReplacementReservation | null {
    return this.reservationsByPredecessor.get(predecessorSessionId) ?? null
  }

  deleteReservation(reservation: CodexReplacementReservation): boolean {
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
    reservation: CodexReplacementReservation,
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
        reservation.successorSessionId,
        reservation.restoreOptions,
      )
    }
    this.setRedirect({
      predecessorSessionId: reservation.predecessorSessionId,
      successorSessionId: reservation.successorSessionId,
      predecessorOwnership: reservation.predecessorOwnership,
      restoreOptions: reservation.restoreOptions,
      cancelled: true,
      reclaimPromise: null,
    })
    return this.deleteReservation(reservation)
  }

  reservations(): IterableIterator<CodexReplacementReservation> {
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
    successorSessionId: string,
    restoreOptions: SessionSpawnOptions,
  ): void {
    if (
      this.redirectsByPredecessor.get(redirect.predecessorSessionId) !== redirect
    ) {
      return
    }
    this.removeSuccessorRedirect(redirect)
    redirect.successorSessionId = successorSessionId
    redirect.restoreOptions = restoreOptions
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

  setReclaim(reclaim: CodexReplacementReclaim<TRecoveryClaim>): void {
    this.reclaimsByPredecessor.set(reclaim.predecessorSessionId, reclaim)
  }

  getReclaim(
    predecessorSessionId: string,
  ): CodexReplacementReclaim<TRecoveryClaim> | null {
    return this.reclaimsByPredecessor.get(predecessorSessionId) ?? null
  }

  deleteReclaim(reclaim: CodexReplacementReclaim<TRecoveryClaim>): boolean {
    if (
      this.reclaimsByPredecessor.get(reclaim.predecessorSessionId) !== reclaim
    ) {
      return false
    }
    this.reclaimsByPredecessor.delete(reclaim.predecessorSessionId)
    return true
  }

  reclaims(): IterableIterator<CodexReplacementReclaim<TRecoveryClaim>> {
    return this.reclaimsByPredecessor.values()
  }
}
