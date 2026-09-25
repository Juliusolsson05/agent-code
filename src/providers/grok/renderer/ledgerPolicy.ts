// Grok's rendering asymmetries for the ownership ledger (#1177); see
// LedgerProviderPolicy in rendering/model/ownership.ts for the bits.

import type { LedgerProviderPolicy } from '@renderer/rendering/model/ownership'

export const GROK_LEDGER_POLICY: LedgerProviderPolicy = {
  suppression: {
    // Grok durable rows are per-item with no whole-turn message id (the
    // mapper derives uuids from generation+offset).
    wholeTurnByMessageId: false,
    // Its MCP tool errors pair like Codex's: block-local evidence is
    // legitimately absent, so the aggressive hide rule must not fire.
    hideUnresolvedHistoryTools: false,
    collapsibleChurnToolNames: new Set(),
  },
  rendersGhostFallback: true,
  angleBracketUserRowsAreScaffolding: false,
}
