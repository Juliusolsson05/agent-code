// Grok semantic fold policy (the OpenCode policy is the template).
//
// WHY these values mirror OpenCode Terminal's: both providers publish
// turn-scoped semantic events from a live channel the app does not own, and
// both commit the durable answer separately. The renderer's ledger must be
// able to open a turn from a soft block source (streaming text), and to
// REPLACE that soft state with the committed block once the turn's answer is
// final — but never to replace the live turn of a still-running prompt, which
// is exactly the overlap the Grok sequencer holds until the answer lands.
//
// - softOpenTurnFromBlockSources / trustedReplaceSources: 'grok-acp' is the
//   only semantic source the Grok headless emits (channels/types.ts pins it),
//   so it is the only source to trust here.
// - canReplaceTurnFromBlock: true — the committed assistant row is the owner
//   of final text (history.durable); live text is provisional by contract.
// - allowReplaceOfLiveTurn: false — while a turn is live, committed rows from
//   a rewrite snapshot may re-deliver older answers, and replacing the live
//   turn's text with one would corrupt the visible stream. The sequencer
//   already excludes snapshot rows from turn answers; this is the renderer's
//   side of the same invariant.
// - autoReplaceOnTurnMismatch: false — a mismatch means the ledger guessed the
//   turn mapping; auto-replacing would hide that guess instead of surfacing it.

import type { SemanticFoldPolicy } from '@shared/types/providerConfig'

export const GROK_SEMANTIC_FOLD_POLICY: SemanticFoldPolicy = {
  autoReplaceOnTurnMismatch: false,
  softOpenTurnFromBlockSources: ['grok-acp'],
  canReplaceTurnFromBlock: true,
  trustedReplaceSources: ['grok-acp'],
  allowReplaceOfLiveTurn: false,
}
