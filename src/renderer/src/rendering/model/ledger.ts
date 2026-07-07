import type { AgentProviderKind } from '@shared/types/providerKind'
import {
  decideGhostCandidate,
  type GhostPredicateContext,
  type GhostPredicateInput,
} from '@renderer/rendering/model/ghostPredicate'
import {
  buildCommittedOwnership,
  decideLiveCandidate,
  SUPPRESSION_POLICY,
} from '@renderer/rendering/model/ownership'
import { orderCandidates } from '@renderer/rendering/model/order'
import type {
  OwnershipDecision,
  RenderCandidate,
  RenderLedger,
  UnknownBehavior,
} from '@renderer/rendering/model/types'

// ---------------------------------------------------------------------------
// The ledger pass: candidates in → { rows, decisions, unknowns } out.
//
// Pipeline (plan D3 — ownership BEFORE ordering, never one-array-sort):
//   1. committed candidates are visible by construction (their visibility
//      filtering — meta/synthetic/non-conversation — happens in the
//      committed projection BEFORE they become candidates)
//   2. live candidates are decided against committed ownership
//   3. ONLY survivors are ordered (the D4 chronological merge)
//   4. every candidate — selected or rejected — has a decision record
// ---------------------------------------------------------------------------

/**
 * A ghost enters the ledger as a PAIR: the paintable candidate plus the
 * predicate facts the five-rule gate needs. WHY not fold the facts into
 * RenderCandidate: superseded/orphaned/updatedAt are ghost-plane-only
 * concepts — widening the shared candidate type for one source would make
 * every other collector carry dead fields, and the predicate's inputs are
 * exactly the audit trail we want serialized when a ghost decision is
 * questioned in a debug bundle.
 */
export type GhostLedgerCandidate = {
  candidate: RenderCandidate
  predicate: GhostPredicateInput
}

export type LedgerInput = {
  provider: AgentProviderKind
  committed: readonly RenderCandidate[]
  live: readonly RenderCandidate[]
  /** work / empty / etc. — pre-decided lifecycle candidates. */
  statics: readonly RenderCandidate[]
  unknowns: readonly UnknownBehavior[]
  /**
   * Ghost plane — OPTIONAL because most sessions never mint a ghost and the
   * claude provider is the only one whose ghost log has a supersede key
   * today (opencode mints supersede-less ghosts that the adapter gates out
   * BEFORE the ledger — plan §ghosts). Absent means "no ghost candidates",
   * identical to an empty array.
   */
  ghosts?: readonly GhostLedgerCandidate[]
  /** Required whenever `ghosts` is non-empty — rules 3/4 read it. */
  ghostContext?: GhostPredicateContext
}

/** Rule-3/4 context when the caller has no ghost plane at all. Null tail is
 *  the documented "fresh session" value — it never auto-renders (rule 5
 *  still gates), unlike a 0 sentinel which would make rule 4 always pass. */
const EMPTY_GHOST_CONTEXT: GhostPredicateContext = {
  lastJsonlEntryAtMs: null,
  semanticOwnedTurnIds: new Set<string>(),
}

function computeLedger(input: LedgerInput): RenderLedger {
  const policy = SUPPRESSION_POLICY[input.provider]
  const ownership = buildCommittedOwnership(input.committed)

  const decisions: OwnershipDecision[] = []
  const selected: RenderCandidate[] = []

  for (const c of input.committed) {
    decisions.push({ candidateId: c.id, selected: true, reason: 'selected', evidence: [] })
    selected.push(c)
  }
  const committedTailMs = input.ghostContext?.lastJsonlEntryAtMs ?? null
  for (const c of input.live) {
    const d = decideLiveCandidate(c, ownership, policy, committedTailMs)
    decisions.push(d)
    if (d.selected) selected.push(c)
  }
  for (const c of input.statics) {
    decisions.push({ candidateId: c.id, selected: true, reason: 'selected', evidence: [] })
    selected.push(c)
  }
  // Ghost plane last: ghosts are the lowest-trust source (screen-derived,
  // provenance plan D9), so they never influence committed/live decisions —
  // they only fill gaps the authoritative planes left. A selected ghost then
  // competes in ordering like anyone else (SOURCE_RANK ghost-fallback = 1).
  const ghostCtx = input.ghostContext ?? EMPTY_GHOST_CONTEXT
  for (const g of input.ghosts ?? []) {
    const d = decideGhostCandidate(g.predicate, ghostCtx)
    decisions.push(d)
    if (d.selected) selected.push(g.candidate)
  }

  return {
    rows: orderCandidates(selected),
    decisions,
    unknowns: input.unknowns,
  }
}

/**
 * Per-session ledger with the IDENTITY-STABILITY contract (plan D11).
 *
 * WHY a factory with a last-call cache instead of a bare pure function:
 * the contract is "unchanged inputs ⇒ the PREVIOUS ledger object by
 * reference", because every Feed memo downstream keys on object identity.
 * The legacy pipeline violated this twice in production (always-cloned
 * ghost maps; double RENDER per phase transition) and the fix was declared
 * load-bearing, not an optimization. Input identity is judged by the
 * ARRAYS' references — upstream stages carry the same discipline (a
 * reducer that didn't change returns its previous array), so reference
 * equality here composes end-to-end into "no semantic tick without real
 * change ever re-renders the feed".
 */
export function createSessionLedger(): (input: LedgerInput) => RenderLedger {
  let last: { input: LedgerInput; ledger: RenderLedger } | null = null
  return input => {
    if (
      last &&
      last.input.provider === input.provider &&
      last.input.committed === input.committed &&
      last.input.live === input.live &&
      last.input.statics === input.statics &&
      last.input.unknowns === input.unknowns &&
      last.input.ghosts === input.ghosts &&
      // ghostContext is compared FIELD-WISE, not by reference: the adapter
      // derives it fresh each tick from scalars + a set it already keeps
      // stable, and demanding object identity here would force every caller
      // to memo a wrapper object — the exact busywork this cache exists to
      // absorb. Two fields, both cheap: scalar + set reference.
      (last.input.ghostContext?.lastJsonlEntryAtMs ?? null) ===
        (input.ghostContext?.lastJsonlEntryAtMs ?? null) &&
      last.input.ghostContext?.semanticOwnedTurnIds === input.ghostContext?.semanticOwnedTurnIds
    ) {
      return last.ledger
    }
    const ledger = computeLedger(input)
    last = { input, ledger }
    return ledger
  }
}
