// Render-time selector: merge upstream entries with current ghost
// state into the single Entry list Feed consumes.
//
// WHY this lives in its own file:
//   The merge is called from TileLeaf's render path, and memoization
//   needs stable references. Putting the selector alongside the
//   ghost reducer keeps the integration surface tiny — TileLeaf
//   imports one function from one place; workspaceStore imports
//   reducer helpers from `./ghosts`; Feed imports nothing about
//   ghosts at all. That separation is load-bearing: when Phase 3
//   deletes the old "two owners" branch in Feed.tsx, Feed will
//   simply consume the merged list with no awareness of ghosts.
//
// The merge is a thin wrapper around atp's `mergeWithUpstream` so
// the provenance and semantics stay documented in one place (the
// atp doc). This file adds nothing to the merge rules; it only
// chooses atp's default options and threads the runtime's state.

import type { Entry } from '@shared/types/transcript'
import type { SessionRuntime } from './workspaceState'

/**
 * Merged entry list for rendering. Superseded ghosts are dropped;
 * orphaned ghosts stay visible (they're the only record of the
 * block).
 *
 * Reference stability:
 *   - if `runtime.ghosts` is empty OR every ghost in the map has
 *     been superseded, returns `runtime.entries` as-is. That short-
 *     circuit is what keeps Feed's useMemo([entries]) chain from
 *     thrashing once the live turn is done and all ghosts have
 *     handed off to the committed JSONL entries.
 *   - otherwise returns a fresh array from mergeWithUpstream. Feed's
 *     memos recompute, which is correct: there is at least one
 *     provisional ghost visible and the list is genuinely different
 *     from `runtime.entries`.
 *
 * WHY not always call mergeWithUpstream: the previous implementation
 * did, and even when `trailing` ended up empty, the return was still
 * `[...upstream, ...[]]` — a fresh array reference. Downstream memos
 * keyed on entries identity recomputed on every tick, so the
 * "memoization path is unchanged" promise in the old docstring was
 * only theoretical.
 */
export function selectMergedEntries(
  runtime: SessionRuntime,
  currentTurnId: string | null,
): Entry[] {
  const { ghosts, entries } = runtime
  if (ghosts.size === 0) return entries

  // 2026-04-20 immediate feed-order sanity fix:
  //
  // The old merge path still let NON-current ghosts render through
  // `mergeWithUpstream`, which appends unsuperseded ghosts after the
  // upstream tail. In practice that meant an older assistant answer
  // still represented by a ghost could appear BELOW newer committed
  // tool rows and even below the user's latest message. The session
  // log for 69e61aa3-38af-... showed exactly that:
  //
  //   entry:g-019dab01-...   (older ghost answer)
  //   semantic:019dab02-...  (current live turn)
  //
  // That ordering is irreparably wrong for the main feed. Until we
  // implement ordered ghost insertion (place ghosts near their logical
  // transcript position instead of blindly tail-appending), the feed
  // takes the conservative route:
  //
  //   - current turn: rendered ONLY by SemanticStreamingTurn
  //   - non-current ghosts: hidden from the main feed
  //
  // Ghosts still exist in runtime state, persist to disk, and remain
  // visible in debug tooling; we are only suppressing them from the
  // user-facing transcript surface to preserve chronological order.
  //
  // This means `selectMergedEntries` currently returns the committed
  // transcript only. Keeping the ghost scan + commentary here makes the
  // intended next step explicit instead of pretending ghosts are gone.
  let hasCurrentGhost = false
  let hasNonCurrentGhost = false
  for (const ghost of ghosts.values()) {
    if (ghost._atp.supersededBy !== undefined) continue
    if (currentTurnId !== null && ghost._atp.turnId === currentTurnId) {
      hasCurrentGhost = true
      continue
    }
    hasNonCurrentGhost = true
  }
  if (!hasCurrentGhost && !hasNonCurrentGhost) return entries
  return entries
}

/**
 * Whether Feed should render the live `SemanticStreamingTurn`
 * component. True iff there is a current turn — the merged feed
 * selector (`selectMergedEntries`) suppresses ghosts from the main
 * feed, so SemanticStreamingTurn has exclusive ownership of the
 * live view and there is no duplicate-render risk.
 *
 * WHY the old predicate was wrong:
 *   It returned false the moment any un-superseded ghost for the
 *   current turn existed — which happens on every block transition,
 *   because tool_use ghosts are minted BEFORE their upstream entry
 *   commits. The live view flicker/null-flip at id:131 in the
 *   2026-04-20 rendering-fixes evidence log was that gate tripping.
 *
 *   Phase 3 of the original headless redesign will delete
 *   SemanticStreamingTurn entirely and render everything through
 *   ghosts + the merged feed. Until then, single-ownership in the
 *   main feed is the surgical fix.
 */
export function shouldShowSemanticStreaming(runtime: SessionRuntime): boolean {
  return runtime.semantic.currentTurn !== null
}
