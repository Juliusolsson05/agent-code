// Antigravity semantic fold policy (OpenCode's is the template: one
// structured stream per session).
//
// Live events come from ACP session/update notifications under the single
// source 'antigravity-acp' (antigravity-acp-headless transcript/assembler.ts).
// agy runs one prompt at a time per session and does not interleave
// concurrent assistant messages, but strict ownership costs nothing here and
// matches every other structured provider: trust 'antigravity-acp', soft-open
// a turn from a block (a tool block can be the first thing a reattached
// renderer sees), never replace a LIVE turn.

import type { SemanticFoldPolicy } from '@shared/types/providerConfig'

export const ANTIGRAVITY_SEMANTIC_FOLD_POLICY: SemanticFoldPolicy = {
  autoReplaceOnTurnMismatch: false,
  softOpenTurnFromBlockSources: ['antigravity-acp'],
  canReplaceTurnFromBlock: true,
  trustedReplaceSources: ['antigravity-acp'],
  allowReplaceOfLiveTurn: false,
}
