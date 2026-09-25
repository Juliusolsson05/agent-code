// Codex's rendering asymmetries for the ownership ledger (#1177); see
// LedgerProviderPolicy in rendering/model/ownership.ts for the bits.

import type { LedgerProviderPolicy } from '@renderer/rendering/model/ownership'

export const CODEX_LEDGER_POLICY: LedgerProviderPolicy = {
  suppression: {
    // Codex commits one response item at a time and SHARES broad turn ids
    // across items, so whole-turn suppression hides still-live output — the
    // exact #165/#191 regression class.
    wholeTurnByMessageId: false,
    // Codex's MCP lifecycle delivers function_call_output in a LATER
    // semantic turn: block-local evidence is legitimately absent and
    // committed reconstruction may lag. The corpus proved the hide rule
    // over-fires here (15 fixtures went missing-in-next).
    hideUnresolvedHistoryTools: false,
    collapsibleChurnToolNames: new Set(),
  },
  rendersGhostFallback: true,
  // Codex does not write angle-bracket scaffolding as user rows; a user
  // message starting with '<' (pasted HTML) is real.
  angleBracketUserRowsAreScaffolding: false,
}
