/**
 * The optimistic user-row uuid marker, shared by every layer that has to
 * recognize a locally minted prompt row in `runtime.entries`: the submit
 * actions that mint it, the ledger adapter that partitions it out of the
 * committed plane, the live-entry trimmer that must never cut it, and Feed,
 * which dims the one that is still sending.
 *
 * WHY it lives in session-runtime: it is a fact about the SHAPE of
 * `runtime.entries`, and session-runtime is the lowest layer all of those
 * importers may reach (it must not import providers/ or workspace/). It is
 * Codex-named because Codex shipped it first. Every optimistic-echo provider
 * and, since #1181, Claude's pending-only row share it. Renaming it would
 * orphan rows in recorded fixtures and debug bundles that carry the old
 * prefix, so the name stays.
 */
export const OPTIMISTIC_PROMPT_UUID_PREFIX = 'optimistic-codex-user:'

/**
 * The uuid of the optimistic row minted for one submit.
 *
 * WHY the submission id instead of `Date.now()` (the pre-#1181 suffix): Feed has
 * to name the row that is still sending, and `promptDelivery.sending` knows
 * only the submission id. Text cannot identify it, because a repeated prompt
 * has an identical twin, and "newest optimistic row" is wrong when the submit
 * was queued or collapsed into an adjacent duplicate. The suffix was never
 * parsed, so changing it is invisible to every other reader, which only test
 * the prefix.
 */
export function optimisticPromptUuid(submissionId: string): string {
  return `${OPTIMISTIC_PROMPT_UUID_PREFIX}${submissionId}`
}
