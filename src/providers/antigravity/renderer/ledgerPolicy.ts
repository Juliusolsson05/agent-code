// Antigravity's rendering asymmetries for the ownership ledger (#1177); see
// LedgerProviderPolicy in rendering/model/ownership.ts for the bits.

import type { LedgerProviderPolicy } from '@renderer/rendering/model/ownership'

export const ANTIGRAVITY_LEDGER_POLICY: LedgerProviderPolicy = {
  suppression: {
    // Rows are per conversation segment (key = `ag:<session>:<ordinal>`),
    // with no whole-turn message id.
    wholeTurnByMessageId: false,
    // A tool result is its own entry threaded by the call id — the Codex /
    // Grok / Pi shape — so the aggressive Claude hide rule must not fire.
    hideUnresolvedHistoryTools: false,
    collapsibleChurnToolNames: new Set(),
  },
  rendersGhostFallback: true,
  angleBracketUserRowsAreScaffolding: false,
}
