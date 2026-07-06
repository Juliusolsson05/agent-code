import type { AgentProviderKind } from '@shared/types/providerKind'
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

export type LedgerInput = {
  provider: AgentProviderKind
  committed: readonly RenderCandidate[]
  live: readonly RenderCandidate[]
  /** work / empty / etc. — pre-decided lifecycle candidates. */
  statics: readonly RenderCandidate[]
  unknowns: readonly UnknownBehavior[]
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
  for (const c of input.live) {
    const d = decideLiveCandidate(c, ownership, policy)
    decisions.push(d)
    if (d.selected) selected.push(c)
  }
  for (const c of input.statics) {
    decisions.push({ candidateId: c.id, selected: true, reason: 'selected', evidence: [] })
    selected.push(c)
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
      last.input.unknowns === input.unknowns
    ) {
      return last.ledger
    }
    const ledger = computeLedger(input)
    last = { input, ledger }
    return ledger
  }
}
