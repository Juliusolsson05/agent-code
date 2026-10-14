import type { LedgerProviderPolicy } from '@renderer/rendering/model/ownership'

/**
 * Hermes needs none of the suppression rules Claude/Codex carry:
 * - committed rows are keyed by Hermes' own row ids and tool call ids, and the
 *   live blocks carry the SAME tool call ids, so ordinary id ownership claims
 *   a live tool chip once its committed row lands;
 * - there is no ghost plane (no screen to scrape);
 * - user rows are typed text (no `<…>` scaffolding Agent Code inserts).
 */
export const HERMES_LEDGER_POLICY: LedgerProviderPolicy = {
  suppression: {
    wholeTurnByMessageId: false,
    hideUnresolvedHistoryTools: false,
    collapsibleChurnToolNames: new Set(),
  },
  rendersGhostFallback: false,
  angleBracketUserRowsAreScaffolding: false,
}
