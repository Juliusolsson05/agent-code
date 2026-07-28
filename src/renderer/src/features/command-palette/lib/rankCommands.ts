import type { ResolvedCommand } from '@renderer/features/command-palette/types'
import { primary, rankEntries, secondary } from '@renderer/features/command-palette/lib/rankEntries'

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
// Field mapping: title is primary, keywords are secondary, commands have
// no body field. Under `rankEntries`' tier table that reproduces the old
// 4/3/2/1 tiers as 5/4/3/1 — the numbers shift, the ordering between any
// two commands does not.
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
// state must not shuffle. Starred commands are the ONE documented exception —
// see the WHY on the partition below before assuming that is a bug.

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
): ResolvedCommand[] {
  const ranked = rankEntries(
    commands,
    query,
    command => [primary(command.title), ...command.keywords.map(keyword => secondary(keyword))],
    command => (starred[command.id] ? STAR_WEIGHT : 0) + (historyScore.get(command.id) ?? 0),
  )

  if (query.length > 0) return ranked

  // Empty query needs its own handling, because `rankEntries` short-circuits
  // and returns the input verbatim WITHOUT sorting — so the extraTiebreak
  // above is dead here.
  //
  // WHY the partition lives in this adapter and not in `rankEntries`: five
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
  // Two filter passes rather than a sort: this is a STABLE partition, so
  // catalog registration order is preserved within each half — and that order
  // is a declared user-visible invariant (catalog.ts).
  const starredRows = ranked.filter(command => starred[command.id])
  if (starredRows.length === 0) return ranked
  return [...starredRows, ...ranked.filter(command => !starred[command.id])]
}
