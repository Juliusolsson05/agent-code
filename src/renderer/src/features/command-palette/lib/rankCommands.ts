import type { ResolvedCommand } from '@renderer/features/command-palette/types'
import { body, primary, rankEntries, secondary } from '@renderer/features/command-palette/lib/rankEntries'
// EMPTY_HEADERS is shared rather than re-declared: search results are never
// sectioned either, and headers describe a browse structure a relevance-ordered
// list does not have.
import { browseOrder, EMPTY_HEADERS } from '@renderer/features/command-palette/lib/sortCommands'
import type { BrowseOrder, CommandSortMode } from '@renderer/features/command-palette/lib/sortCommands'

// rankCommands — the ordering function for the command-palette's command
// list specifically. The generic relevance machinery now lives in
// `rankEntries`, which every palette list shares; this module is the thin
// command-shaped adapter over it plus the recent-usage tiebreak.
//
// It used to own a private copy of the tier logic. That copy was the only
// ranker in the palette — templates, sessions, buried tabs and workspaces
// were left on a boolean filter with no scoring at all — and the
// divergence is what produced the template-search inversion documented in
// docs/plans_and_ideas/2026-07-22-palette-search-relevance-plan.md. One
// definition of "relevance", one place to fix it.
//
// Descriptions are literal body matches: the operator can search by purpose
// without scattered letters in a paragraph defeating precise title matches.
//
// The cardinal design rule still holds and is now enforced inside
// `rankEntries`: a text match always beats history. History is passed as
// the same-tier `extraTiebreak`, so it can only reorder commands that
// already matched equally well. A command the user typed a clean prefix
// for can never be pushed down by some other command they happen to run a
// lot. That is what keeps search feeling like search rather than "show me
// my favorites regardless of what I typed".
//
// Empty-query behavior (registry order, no history reordering) also lives in
// `rankEntries` now, for the same reason it did here: the palette's resting
// state must not shuffle by itself. Two documented exceptions, both of which
// are the user asking for it rather than the app deciding on its own:
//
//   1. STARRED commands hoist to the top — see the WHY on the partition below.
//   2. The SORT MODE (`sortCommands.ts`) reorders the browse list on request.
//
// Neither can touch a SEARCH result. Both are applied only on the empty-query
// path, below the `query.length > 0` early return, which is what keeps "a text
// match always beats every other signal" true.

// Re-exported because the palette's other call sites import `fuzzyMatch`
// from here. Its real definition — and the warning about never running it
// over long prose — lives in `rankEntries`.
export { fuzzyMatch } from '@renderer/features/command-palette/lib/rankEntries'

/**
 * How much a star is worth as a same-tier nudge.
 *
 * History scores are bounded in [0, 1) (recentCommandHistory.ts), so 1 is the
 * smallest weight that puts every starred command above every unstarred one
 * WITHIN its tier. It can never cross tiers, because `rankEntries` compares
 * tier before it ever looks at this number — which is the entire point. Typing
 * a clean prefix for some other command still wins, so search keeps feeling
 * like search rather than "show me my favorites regardless of what I typed".
 */
const STAR_WEIGHT = 1

export function rankCommands(
  commands: ResolvedCommand[],
  query: string,
  historyScore: Map<string, number>,
  starred: Record<string, boolean>,
  sortMode: CommandSortMode = 'catalog',
): BrowseOrder {
  const ranked = rankEntries(
    commands,
    query,
    commandSearchFields,
    command => (starred[command.id] ? STAR_WEIGHT : 0) + (historyScore.get(command.id) ?? 0),
  )

  // THE INVARIANT, and the reason `sortMode` is not consulted anywhere above:
  // a non-empty query is answered by relevance alone. The sort mode governs the
  // BROWSE state only.
  //
  // This is not a limitation waiting to be lifted. Applying a sort to search
  // results would let 'A – Z' place a tier-1 subsequence match above the tier-5
  // prefix match the user typed in full — the exact inversion class that
  // `rankEntries` was extracted to eliminate (see the plan doc referenced in
  // its header). The control in the header shows "Relevance" and disables
  // itself while a query is present, so this is legible to the user rather than
  // looking like the setting stopped working.
  if (query.length > 0) return { commands: ranked, headers: EMPTY_HEADERS }

  // Empty query needs its own handling, because `rankEntries` short-circuits
  // and returns the input verbatim WITHOUT sorting — so the extraTiebreak
  // above is dead here.
  //
  // WHY the star partition lives in this adapter and not in `rankEntries`: five
  // lists share that short-circuit (commands, prompt templates, sessions,
  // buried tabs, AI workspaces). Editing it would silently reshuffle four
  // resting orders nobody asked to change.
  //
  // WHY starring may perturb resting order when recency may not: `rankEntries`
  // refuses to reorder a resting palette on the grounds that "the row you
  // expect at the top moves before you've typed a character." That objection
  // is about AUTOMATIC reordering — usage data the user never asked to be
  // ranked by. A star is a deliberate act by the same person now looking at
  // the list, so the top row moving is precisely what they asked for. DO NOT
  // "fix" this back to match the sibling rule without reading this paragraph.
  //
  // The partition itself now lives in `browseOrder`, which owns every
  // browse-state ordering decision (star split, the four sort modes, and the
  // section headers that must stay in lockstep with the flat order). It still
  // preserves catalog registration order within each half when the mode is
  // 'catalog' — that order is a declared user-visible invariant (catalog.ts)
  // and remains the default.
  return browseOrder(ranked, sortMode, historyScore, starred)
}

// Shared with the control catalog. Both surfaces must agree what an intention
// matches, while the UI retains its existing stars/history/browse ordering.
export function commandSearchFields(command: { title: string; description: string; keywords: readonly string[] }) {
  return [primary(command.title), ...command.keywords.map(keyword => secondary(keyword)), body(command.description)]
}
