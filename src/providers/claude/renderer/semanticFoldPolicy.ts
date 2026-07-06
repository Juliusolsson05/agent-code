// Claude semantic fold policy — bit-identical to the pre-policy
// behavior where foldEvent.ts special-cased `sessionKind === 'claude'`.
// See SemanticFoldPolicy in @shared/types/providerConfig for the field
// semantics and the WHY on replacing provider literals with policies.

import type { SemanticFoldPolicy } from '@shared/types/providerConfig'

export const CLAUDE_SEMANTIC_FOLD_POLICY: SemanticFoldPolicy = {
  // Auto-replace on turn-level mismatch: Claude keeps currentTurn alive
  // across turn boundaries while a cross-turn tool_result is pending
  // (foldEvent's turn_completed retains the turn). The NEXT assistant
  // turn's message_start carries a fresh msg_id that mismatches the
  // pinned turnId; dropping it would silently hide every subsequent
  // Claude turn. See
  // docs/superpowers/plans/2026-04-17-claude-semantic-provider-gating.md.
  autoReplaceOnTurnMismatch: true,
  // No block-level soft-open/replace: Claude has older late-event
  // failure modes where opening from a stray block after currentTurn
  // was already archived resurrected stale semantic rows. The old code
  // hard-dropped mismatched blocks for Claude even when the current
  // turn had ended — preserved exactly by canReplaceTurnFromBlock:false.
  softOpenTurnFromBlockSources: [],
  canReplaceTurnFromBlock: false,
  // Irrelevant while autoReplaceOnTurnMismatch is true and block
  // replacement is off, but keep them explicitly empty/false so the
  // policy reads as "turn events always win, block events never do".
  trustedReplaceSources: [],
  allowReplaceOfLiveTurn: false,
}
