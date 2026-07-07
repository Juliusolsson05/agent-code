import type { OwnershipDecision } from '@renderer/rendering/model/types'

// ---------------------------------------------------------------------------
// The ghost five-rule render predicate, ported as ledger decisions.
//
// Provenance: docs/design/ghost-system.md + the 2026-05-07 findings/predicate
// docs. Every rule is the scar of a shipped regression (four documented
// failed fixes: 10e4fc5 hid all → lost fallback; 686b94e rendered orphans →
// sidecar pileup; 2a83978 shape filter alone → longer sidecars leak;
// hide-all v2 → lost stuck-mid-turn recovery). Do not "simplify" any rule
// without reading research-2026-07/historical-plans-extraction.md first.
//
// Ghost fallback exists for exactly one condition: committed truth stalled
// PAST the live stream (JSONL stuck mid-turn, or crash+resume with ghost
// log newer than the transcript tail). Everything else must reject.
//
// Rule 3 (`semanticOwnedTurnIds`) carries a death sentence: it exists only
// because SemanticStreamingTurn owns the live turn in the legacy renderer.
// At Stage 3 cutover it is deleted TOGETHER with SemanticStreamingTurn
// (plan D6) — the ledger then owns live turns itself and the double-render
// hazard rule 3 guards against disappears structurally.
// ---------------------------------------------------------------------------

export type GhostPredicateInput = {
  id: string
  turnId: string
  /** _atp.supersededBy — authoritative row landed. */
  superseded: boolean
  /** _atp.orphanedAt — TTL (30s) elapsed without a committed match. TTL
   *  semantics: "how long before we conclude committed had its chance",
   *  NOT "how fast we paint" — a 5000-line Read produces a quiet window
   *  that a short TTL mis-orphaned (that is why 3s failed in production). */
  orphaned: boolean
  /**
   * Renderer-LOCAL clock of the ghost's last update — ghosts.ts stamps
   * Date.now() at mint/update because the ghost plane has no producer
   * timestamp to borrow (C7). Rule 4 below compares THIS against the
   * producer JSONL tail, so the two sides are the same clock only when the
   * renderer is co-located with the producer; under remote/SSH the
   * local↔producer skew makes the gate approximate (accepted degradation,
   * not a bug — see rule 4).
   */
  updatedAtMs: number
  /** Assistant role + exactly one text block → sidecar-shaped candidate. */
  assistantSingleTextLength: number | null
  toolUse: boolean
}

export type GhostPredicateContext = {
  /** Newest committed entry timestamp observed — producer clock, null on a
   *  fresh session. NULL IS NOT ZERO: a 0 sentinel makes rule 4 always pass
   *  and renders ghosts on brand-new sessions (documented invariant). */
  lastJsonlEntryAtMs: number | null
  /** Turn ids owned by semantic current/history (legacy rule 3). */
  semanticOwnedTurnIds: ReadonlySet<string>
}

/**
 * Empirical anchor from bundle 2026-05-07T08-26-35-212: max observed sidecar
 * turn 41 chars, min real assistant turn 76 chars → 200 leaves margin both
 * ways. The documented accepted trade-off rides with it: a real crashed
 * turn that was a single short text block ("Done.") is invisibly lost —
 * rare loss accepted over daily sidecar pileup. tool_use ghosts are exempt:
 * structurally never sidecar-shaped, render even when short.
 */
export const SIDECAR_GHOST_TEXT_MAX = 200

export function decideGhostCandidate(
  ghost: GhostPredicateInput,
  ctx: GhostPredicateContext,
): OwnershipDecision {
  const base = { candidateId: ghost.id }

  // Rule 1 — superseded: authoritative row exists; never resurrect a
  // provisional copy after the real one landed.
  if (ghost.superseded) {
    return { ...base, selected: false, reason: 'ghost-superseded', evidence: ['supersededBy set'] }
  }
  // Rule 2 — not yet orphaned: committed still has its chance. This is also
  // the ONLY guard in the ~100ms turn_completed→JSONL race window — rules
  // 1/3/4 all pass in that window; TTL is what prevents flicker there.
  if (!ghost.orphaned) {
    return { ...base, selected: false, reason: 'ghost-not-orphaned', evidence: ['TTL not elapsed'] }
  }
  // Rule 3 — semantic owns the turn (legacy dual-owner guard; dies at cutover).
  if (ctx.semanticOwnedTurnIds.has(ghost.turnId)) {
    return { ...base, selected: false, reason: 'ghost-semantic-owned', evidence: [`turn ${ghost.turnId} live`] }
  }
  // Rule 4 — timestamp gate: render only when the ghost is NEWER than the
  // committed tail (committed stalled past live). MIXED clocks (C7): the
  // ghost's updatedAtMs is renderer-LOCAL (Date.now() at mint, ghosts.ts)
  // while lastJsonlEntryAtMs is a PRODUCER JSONL timestamp — the strictly-
  // greater comparison is exact only when renderer and producer are co-
  // located and degrades under remote/SSH skew. Null tail (fresh session)
  // does not gate — falls through to rule 5, never auto-renders.
  if (ctx.lastJsonlEntryAtMs !== null && ghost.updatedAtMs <= ctx.lastJsonlEntryAtMs) {
    return {
      ...base,
      selected: false,
      reason: 'ghost-older-than-jsonl',
      evidence: [`ghost ${ghost.updatedAtMs} <= tail ${ctx.lastJsonlEntryAtMs}`],
    }
  }
  // Rule 5 — sidecar shape backstop. Rule 4 alone CANNOT distinguish the
  // tail-sidecar case: real commit at t=100, predict-next-prompt sidecar at
  // t=105, user walks away — updatedAt > tail, yet it is garbage. This was
  // the dominant production failure mode and the reason the single-rule
  // (timestamp-only) design from the findings doc was overturned. Both
  // rules stay, forever, together.
  if (
    !ghost.toolUse &&
    ghost.assistantSingleTextLength !== null &&
    ghost.assistantSingleTextLength <= SIDECAR_GHOST_TEXT_MAX
  ) {
    return {
      ...base,
      selected: false,
      reason: 'ghost-sidecar-shape',
      evidence: [`single text block ${ghost.assistantSingleTextLength} <= ${SIDECAR_GHOST_TEXT_MAX}`],
    }
  }

  return {
    ...base,
    selected: true,
    reason: 'selected',
    evidence: [
      'orphaned, unsuperseded, not semantic-owned',
      ctx.lastJsonlEntryAtMs === null
        ? 'fresh session (null tail)'
        : `newer than committed tail by ${ghost.updatedAtMs - ctx.lastJsonlEntryAtMs}ms`,
    ],
  }
}
