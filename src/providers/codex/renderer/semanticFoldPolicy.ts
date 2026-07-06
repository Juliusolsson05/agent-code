// Codex semantic fold policy — bit-identical to the pre-policy behavior
// where foldEvent.ts special-cased `sessionKind === 'codex'` and routed
// mismatches through codexCanReplaceTurn. See SemanticFoldPolicy in
// @shared/types/providerConfig for field semantics.

import type { SemanticFoldPolicy } from '@shared/types/providerConfig'

export const CODEX_SEMANTIC_FOLD_POLICY: SemanticFoldPolicy = {
  // STRICT while live: Codex has two racing producers for the same
  // user-visible moment (proxy flow + screen/rollout fallback, or two
  // concurrent proxy flows). Replacing currentTurn on a stray mismatched
  // turn event wipes the block map the live renderer is already showing —
  // the 0/1/0/1 flicker documented in
  // docs/superpowers/plans/2026-04-17-codex-semantic-flicker-fix.md.
  autoReplaceOnTurnMismatch: false,
  // Proxy blocks are the render-critical source; the 2026-05-16 failure
  // class proved the stricter headless lifecycle can lose a ceremonial
  // turn opener/closer while still delivering block_started/text/tool
  // events. Soft-open recovery stays proxy-only.
  softOpenTurnFromBlockSources: ['proxy'],
  canReplaceTurnFromBlock: true,
  // Only the proxy stream may claim a mismatched LIVE turn, and even
  // then only through foldEvent's yield hatches (completed-proxy-turn /
  // empty-non-proxy-shell) — allowReplaceOfLiveTurn:false keeps the
  // flicker defense for turns with live content.
  trustedReplaceSources: ['proxy'],
  allowReplaceOfLiveTurn: false,
}
