import type { ResolvedCommand } from '@renderer/features/command-palette/types'

// rankCommands — the single ordering function for the command-palette
// command list. Pure on purpose: no React, no storage, no Date.now().
// It takes the registry-ordered commands, the trimmed query, and a
// precomputed history score map, and returns the list to render. Keeping
// it pure means it's trivially testable in isolation and the palette
// component stays a thin caller.
//
// The cardinal design rule, encoded by sort-term ORDER below: a text
// match always beats history. `textTier` is the FIRST sort key, so
// history can ONLY reorder commands that already share the same tier —
// it is a tiebreaker, never an override. A command the user typed a
// clean prefix for can never be pushed down by some other command they
// happen to run a lot. This is what keeps search feeling like search
// and not "show me my favorites regardless of what I typed".

// Subsequence fuzzy match — ported verbatim from the palette's original
// inline helper so behavior is identical to before this change. Returns
// true when every char of `query` appears in `text` in order (not
// necessarily contiguous), case-insensitively. This is the weakest
// (tier 1) match: it's what lets "spr" find "Split Pane Right".
export function fuzzyMatch(text: string, query: string): boolean {
  const lower = text.toLowerCase()
  const q = query.toLowerCase()
  let j = 0
  for (let i = 0; i < lower.length && j < q.length; i++) {
    if (lower[i] === q[j]) j++
  }
  return j === q.length
}

// Compute the strongest text-match tier for a command against the query.
// Higher = better. Tiers are ranked by how confident we are the match is
// what the user meant:
//   4 — query is a case-insensitive PREFIX of the title (strongest: the
//       user is clearly typing the command's name from the start).
//   3 — query is a substring of the title (somewhere, just not the start).
//   2 — query is a substring of ANY keyword (the alias surface).
//   1 — subsequence fuzzy match on title or any keyword (the loosest
//       net; matches scattered characters).
//   0 — no match at all; these are dropped before sorting.
// We early-return at the first (highest) tier that applies so each
// command gets exactly one tier.
function textTier(command: ResolvedCommand, query: string): number {
  const title = command.title.toLowerCase()
  const q = query.toLowerCase()

  if (title.startsWith(q)) return 4
  if (title.includes(q)) return 3
  if (command.keywords.some(keyword => keyword.toLowerCase().includes(q))) return 2
  if (
    fuzzyMatch(command.title, query) ||
    command.keywords.some(keyword => fuzzyMatch(keyword, query))
  ) {
    return 1
  }
  return 0
}

export function rankCommands(
  commands: ResolvedCommand[],
  query: string,
  historyScore: Map<string, number>,
): ResolvedCommand[] {
  // Empty query is the "browse the menu" case. We return the registry
  // order UNCHANGED — history must NOT reorder the full list. Reordering
  // here would make the palette's resting state shuffle around based on
  // past usage, which is disorienting (the command you expect at the top
  // moves) and undoes the registry's deliberate grouping. History only
  // earns the right to reorder once the user has typed and we're already
  // filtering.
  if (query.length === 0) return commands

  // Carry the original registry index so it can serve as the final,
  // fully-deterministic tiebreak: equal text tier AND equal history
  // score falls back to registry order, never to Array.sort's
  // implementation-defined behavior.
  const scored = commands
    .map((command, registryIndex) => ({
      command,
      registryIndex,
      tier: textTier(command, query),
      history: historyScore.get(command.id) ?? 0,
    }))
    .filter(entry => entry.tier > 0)

  scored.sort((a, b) => {
    // 1) Text tier, DESC — strongest match wins. This being first is the
    //    invariant that makes history a tiebreaker only.
    if (a.tier !== b.tier) return b.tier - a.tier
    // 2) History score, DESC — within an equal tier, nudge the
    //    recently/frequently used command up.
    if (a.history !== b.history) return b.history - a.history
    // 3) Registry index, ASC — stable, deterministic final fallback.
    return a.registryIndex - b.registryIndex
  })

  return scored.map(entry => entry.command)
}
