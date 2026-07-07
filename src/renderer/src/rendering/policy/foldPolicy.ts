import type { AgentProviderKind } from '@shared/types/providerKind'

// ---------------------------------------------------------------------------
// Fold policy for the NEW pipeline — provider asymmetry as data (plan D10).
//
// The July semanticFoldPolicy capability (5 knobs, registry-resolved) proved
// the shape but left the two live-turn yield hatches hardcoded as
// proxy-string literals inside legacy foldEvent.ts
// (`isCompletedProxyTurnReadyToYield`, `isEmptyNonProxyShellTurn`). This
// module finishes that absorption for the new model: the hatches become two
// more policy fields, and the predicates below are parameterized on the
// policy — no provider-source literal appears in any logic path. The legacy
// fold stays untouched until Stage 3 cutover (plan drift item), so the
// literals die WITH it; this is the shape the future fold engine consumes.
//
// Every value in these tables is behavior-preserving w.r.t. the legacy
// fold. Do not "tidy" a knob without reading the WHY at its legacy source
// (src/providers/*/renderer/semanticFoldPolicy.ts and foldEvent.ts) — each
// one is the scar of a documented production failure.
// ---------------------------------------------------------------------------

export type RenderFoldPolicy = {
  /** Mismatched turn id on turn-scope events: archive-and-replace
   *  unconditionally. Claude true — its next assistant message mints a
   *  fresh msg_id while a cross-turn tool_result keeps the old turn
   *  pinned; dropping it would hide every subsequent turn. */
  autoReplaceOnTurnMismatch: boolean
  /** Sources allowed to soft-open a new turn from a stray block_started
   *  when NO current turn exists (codex 2026-05-16 lost-opener recovery;
   *  opencode tool-blocks-keyed-on-sessionID). Claude: [] — late-block
   *  turn resurrection is a known failure mode there. */
  softOpenTurnFromBlockSources: readonly string[]
  /** Whether a block-scope event may replace the current turn at all. */
  canReplaceTurnFromBlock: boolean
  /** Event sources trusted to displace a turn through the rules below. */
  trustedReplaceSources: readonly string[]
  /** Trusted source may replace a LIVE (unended) turn outright. False for
   *  codex/opencode: racing producers thrash the single live slot — the
   *  0/1/0/1 flicker class. When false, only the yield hatches apply. */
  allowReplaceOfLiveTurn: boolean
  /** HATCH 1 (absorbed from isCompletedProxyTurnReadyToYield): turns from
   *  these sources yield the live slot once EVERY known block is terminal
   *  (finalized or status:'completed') even without turn_completed. The
   *  2026-05-16T19:08 bundle: a proxy turn with completed message +
   *  completed function_call never got turn_completed — treating the
   *  completed function_call as "pending" squatted the slot forever and
   *  every later resp_* block was dropped. "All blocks terminal" is the
   *  decisive yield signal; pending-tool bookkeeping deliberately does
   *  NOT veto it. */
  terminalYieldSources: readonly string[]
  /** HATCH 2 (absorbed from isEmptyNonProxyShellTurn): a claimant from
   *  this list may take the live slot from an EMPTY unended shell minted
   *  by a source NOT in this list. Rollout opens a placeholder turn right
   *  after submit, before proxy emits the real Responses turn — the
   *  strict guard then dropped every proxy block and the feed showed no
   *  streaming. Content-bearing turns keep full flicker protection. */
  shellClaimants: readonly string[]
}

/** Structural facts about the current live turn — what the predicates
 *  read. Kept runtime-agnostic like every pipeline input so fold-policy
 *  behavior is hand-fixture-testable. */
export type LiveTurnFacts = {
  source: string | null
  endedAtMs: number | null
  textLength: number
  blocks: readonly { finalized?: boolean; status?: string }[]
}

export const FOLD_POLICY: Record<AgentProviderKind, RenderFoldPolicy> = {
  claude: {
    autoReplaceOnTurnMismatch: true,
    softOpenTurnFromBlockSources: [],
    canReplaceTurnFromBlock: false,
    trustedReplaceSources: ['proxy'],
    allowReplaceOfLiveTurn: false,
    // Hatches unreachable behind autoReplaceOnTurnMismatch: true, kept
    // empty so nothing implies claude ever needed them.
    terminalYieldSources: [],
    shellClaimants: [],
  },
  codex: {
    autoReplaceOnTurnMismatch: false,
    softOpenTurnFromBlockSources: ['proxy'],
    canReplaceTurnFromBlock: true,
    trustedReplaceSources: ['proxy'],
    allowReplaceOfLiveTurn: false,
    terminalYieldSources: ['proxy'],
    shellClaimants: ['proxy'],
  },
  opencode: {
    autoReplaceOnTurnMismatch: false,
    softOpenTurnFromBlockSources: ['opencode-sse'],
    canReplaceTurnFromBlock: true,
    trustedReplaceSources: ['opencode-sse'],
    allowReplaceOfLiveTurn: false,
    // Opencode's single server-authoritative stream has no proxy/rollout
    // producer race, so the codex hatches never applied (its only source
    // is 'opencode-sse'); encoded empty rather than inherited so the
    // asymmetry is visible as policy, not accident.
    terminalYieldSources: [],
    shellClaimants: [],
  },
}

/** WHY status:'completed' counts as terminal alongside finalized: the
 *  2026-05-16T18:42 hybrid — a final_answer block carried both markers
 *  while turn_completed was missing entirely. Trusting only endedAt lets
 *  that old answer squat in the live slot forever. */
function isTerminalBlock(b: { finalized?: boolean; status?: string }): boolean {
  return b.finalized === true || b.status === 'completed'
}

export function isTerminalYieldReady(policy: RenderFoldPolicy, turn: LiveTurnFacts): boolean {
  if (turn.source === null || !policy.terminalYieldSources.includes(turn.source)) return false
  if (turn.endedAtMs != null) return false
  if (turn.blocks.length === 0) return false
  return turn.blocks.every(isTerminalBlock)
}

export function isClaimableEmptyShell(policy: RenderFoldPolicy, turn: LiveTurnFacts): boolean {
  if (turn.source !== null && policy.shellClaimants.includes(turn.source)) return false
  return turn.endedAtMs === null && turn.textLength === 0 && turn.blocks.length === 0
}

/**
 * The full mismatched-turn replacement decision, policy-parameterized —
 * the shape legacy canReplaceMismatchedTurn takes at cutover.
 *
 * Ended turns are replaceable for EVERY provider: the strict gate exists
 * to stop concurrent producers thrashing a STREAMING turn; an already
 * ended pending-tool turn (MCP lifecycle — function_call completes, output
 * arrives in the NEXT Responses turn) must not block its follow-up, or the
 * feed goes blank except for the phase indicator.
 */
export function canReplaceMismatchedLiveTurn(
  policy: RenderFoldPolicy,
  turn: LiveTurnFacts,
  eventSource: string | null,
): boolean {
  if (turn.endedAtMs != null) return true
  if (eventSource === null || !policy.trustedReplaceSources.includes(eventSource)) return false
  if (policy.allowReplaceOfLiveTurn) return true
  if (isTerminalYieldReady(policy, turn)) return true
  return isClaimableEmptyShell(policy, turn)
}
