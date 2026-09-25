// OpenCode's rendering asymmetries for the ownership ledger (#1177); see
// LedgerProviderPolicy in rendering/model/ownership.ts for the bits.

import type { LedgerProviderPolicy } from '@renderer/rendering/model/ownership'

export const OPENCODE_LEDGER_POLICY: LedgerProviderPolicy = {
  suppression: {
    // Unit-level like Codex: concurrency lands via committed assembly. Note
    // the drift report: OpenCode committed rows DO carry message ids, which
    // is why this is an explicit policy bit and not an id-presence heuristic.
    wholeTurnByMessageId: false,
    // The committed channel is assembled server truth; no dangling-chip
    // bundle exists for OpenCode — revisit if one appears.
    hideUnresolvedHistoryTools: false,
    collapsibleChurnToolNames: new Set(),
  },
  // OpenCode's mapper mints ghosts with no supersede key, so reconcileUpstream
  // can never match them: every one eventually orphans and, being real turn
  // content, passes the shape backstop too. Rendering them would double every
  // OpenCode turn. Until it grows a supersede identity, its ghost plane is
  // bookkeeping only (crash-recovery journal), never a render source.
  rendersGhostFallback: false,
  angleBracketUserRowsAreScaffolding: false,
}
