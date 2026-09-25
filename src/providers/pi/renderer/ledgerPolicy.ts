// Pi's rendering asymmetries for the ownership ledger (#1177); see
// LedgerProviderPolicy in rendering/model/ownership.ts for the bits.

import type { LedgerProviderPolicy } from '@renderer/rendering/model/ownership'

export const PI_LEDGER_POLICY: LedgerProviderPolicy = {
  suppression: {
    // Pi rows are per-message (uuid = the entry id) with no whole-turn
    // message id.
    wholeTurnByMessageId: false,
    // A tool result is its own row threaded by toolCallId — the Codex / Grok
    // shape — so the aggressive Claude hide rule must not fire.
    hideUnresolvedHistoryTools: false,
    collapsibleChurnToolNames: new Set(),
  },
  rendersGhostFallback: true,
  angleBracketUserRowsAreScaffolding: false,
}
