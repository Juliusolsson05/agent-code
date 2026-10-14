import type { SemanticFoldPolicy } from '@shared/types/providerConfig'

/**
 * Hermes' live turns come from ONE producer, hermes-headless's reconciler,
 * tagged `hermes-ws` (HERMES_SEMANTIC_SOURCE). Like OpenCode's single trusted
 * SSE stream, a turnId from it that differs from the live one is a genuine
 * new turn: the reconciler already closed the previous one (turn_stopped
 * 'superseded') before opening it, so replacement is safe and archiving
 * keeps the old turn visible.
 *
 * `allowReplaceOfLiveTurn: false`: the reconciler never opens a turn over a
 * live one without closing it first, so a mismatch arriving while one is
 * still live can only be a stale replayed frame; dropping it is correct.
 */
export const HERMES_SEMANTIC_FOLD_POLICY: SemanticFoldPolicy = {
  autoReplaceOnTurnMismatch: false,
  softOpenTurnFromBlockSources: ['hermes-ws'],
  canReplaceTurnFromBlock: true,
  trustedReplaceSources: ['hermes-ws'],
  allowReplaceOfLiveTurn: false,
}
