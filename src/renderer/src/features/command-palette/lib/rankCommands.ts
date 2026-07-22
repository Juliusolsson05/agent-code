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
// Empty-query behavior (registry order, unchanged, no history reordering)
// also lives in `rankEntries` now, for the same reason it did here: the
// palette's resting state must not shuffle.

// Re-exported because the palette's other call sites import `fuzzyMatch`
// from here. Its real definition — and the warning about never running it
// over long prose — lives in `rankEntries`.
export { fuzzyMatch } from '@renderer/features/command-palette/lib/rankEntries'

export function rankCommands(
  commands: ResolvedCommand[],
  query: string,
  historyScore: Map<string, number>,
): ResolvedCommand[] {
  return rankEntries(
    commands,
    query,
    command => [primary(command.title), ...command.keywords.map(keyword => secondary(keyword))],
    command => historyScore.get(command.id) ?? 0,
  )
}
