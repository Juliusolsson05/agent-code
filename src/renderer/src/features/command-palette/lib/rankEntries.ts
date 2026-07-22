// rankEntries — the ONE definition of "how relevant is this row to what
// the user typed" for every list the command palette renders: commands,
// prompt templates, resumable sessions, buried tabs, AI workspaces.
//
// It exists because there used to be two answers to that question and
// they drifted. `rankCommands` had a real tiered ranker; the other four
// lists had a hand-rolled boolean `.filter()` with no scoring at all, so
// their displayed order was just their source-array order. For prompt
// templates that source order is `[...custom, ...builtin]`, which meant
// a builtin template could never outrank a custom one no matter how much
// better it matched — typing "read this p" put the builtin "Read This
// Project" in 7th place behind six unrelated custom templates. See
// docs/plans_and_ideas/2026-07-22-palette-search-relevance-plan.md.
//
// Pure on purpose: no React, no storage, no Date.now(). Callers describe
// their items as weighted fields and get back a filtered, ordered list.

// Subsequence fuzzy match — every char of `query` appears in `text` in
// order, gaps allowed, case-insensitive. This is the weakest net and the
// reason "spr" finds "Split Pane Right".
//
// It is ONLY safe on short text. Run it against a paragraph and it
// degenerates: an 11-char query only needs its letters sprinkled
// anywhere across a thousand characters, which essentially every piece
// of prose satisfies. That is why `body` fields below are never fuzzy
// matched — see the tier table.
export function fuzzyMatch(text: string, query: string): boolean {
  const lower = text.toLowerCase()
  const q = query.toLowerCase()
  let j = 0
  for (let i = 0; i < lower.length && j < q.length; i++) {
    if (lower[i] === q[j]) j++
  }
  return j === q.length
}

// How much a field is allowed to claim about the user's intent.
//
//   primary   — the name the user is actually typing (title, summary,
//               label, workspace name). Short. Matching here is the
//               strongest possible evidence.
//   secondary — short supporting text and aliases (description,
//               keywords, git branch, workspace id). Real signal, but a
//               user typing a description word is less sure of what they
//               want than one typing the name.
//   body      — long prose (a prompt template's body, a session's first
//               prompt). Weak by nature and dangerous to fuzzy-match.
export type MatchWeight = 'primary' | 'secondary' | 'body'

export interface MatchField {
  text: string
  weight: MatchWeight
}

// Convenience constructors so call sites read as data, not plumbing.
export const primary = (text: string | null | undefined): MatchField => ({
  text: text ?? '',
  weight: 'primary',
})
export const secondary = (text: string | null | undefined): MatchField => ({
  text: text ?? '',
  weight: 'secondary',
})
export const body = (text: string | null | undefined): MatchField => ({
  text: text ?? '',
  weight: 'body',
})

// Tiers, strongest first. Higher wins; 0 is dropped before sorting.
//
//   5 — query is a PREFIX of a primary field. The user is typing the
//       name from the start; nothing should ever outrank this.
//   4 — query is a substring of a primary field (matched mid-name).
//   3 — query is a substring of a secondary field.
//   2 — query is a LITERAL substring of a body field.
//   1 — subsequence match on a primary or secondary field.
//
// The load-bearing rule is the asymmetry at tiers 2 and 1: body fields
// are matched by literal substring ONLY, never by subsequence. A literal
// "read this p" sitting inside a prompt body is genuine signal worth
// surfacing near the bottom; a subsequence hit in that same body is pure
// noise and admitting it is exactly what broke template search. The
// numbers in this table can be re-tuned; that asymmetry cannot be
// relaxed without re-reading the plan doc first.
//
// We early-return at the first tier that applies, so each entry is
// assigned exactly one tier and the sort has a single comparable number.
export function relevanceTier(fields: MatchField[], query: string): number {
  const q = query.toLowerCase()
  if (q.length === 0) return 0

  // Lowercase once per field rather than once per comparison below —
  // this runs over every row on every keystroke.
  const scan = fields
    .filter(field => field.text.length > 0)
    .map(field => ({ weight: field.weight, text: field.text.toLowerCase() }))

  const primaries = scan.filter(f => f.weight === 'primary')
  const secondaries = scan.filter(f => f.weight === 'secondary')
  const bodies = scan.filter(f => f.weight === 'body')

  if (primaries.some(f => f.text.startsWith(q))) return 5
  if (primaries.some(f => f.text.includes(q))) return 4
  if (secondaries.some(f => f.text.includes(q))) return 3
  if (bodies.some(f => f.text.includes(q))) return 2
  if ([...primaries, ...secondaries].some(f => fuzzyMatch(f.text, q))) return 1
  return 0
}

// Ranked, filtered list. `extraTiebreak` lets a caller inject one signal
// that applies WITHIN a tier and only within a tier — `rankCommands`
// uses it for recent-usage history. It deliberately cannot cross tiers:
// a command the user runs constantly must never displace one whose name
// they just typed in full. Higher values sort first.
export function rankEntries<T>(
  items: readonly T[],
  query: string,
  getFields: (item: T) => MatchField[],
  extraTiebreak?: (item: T) => number,
): T[] {
  // Empty query is the "browse the menu" case: return the caller's order
  // verbatim. A resting palette that reshuffles itself based on anything
  // is disorienting — the row you expect at the top moves before you've
  // typed a character.
  if (query.length === 0) return [...items]

  // Carry the original index so equal-relevance rows keep the caller's
  // deliberate authored order (registry grouping, session recency) and
  // the sort never falls through to Array.sort's implementation-defined
  // behavior for equal elements.
  const scored = items
    .map((item, index) => ({
      item,
      index,
      tier: relevanceTier(getFields(item), query),
      extra: extraTiebreak ? extraTiebreak(item) : 0,
    }))
    .filter(entry => entry.tier > 0)

  scored.sort((a, b) => {
    // 1) Relevance tier, DESC. First key by design — this is what makes
    //    every other signal a tiebreaker rather than an override.
    if (a.tier !== b.tier) return b.tier - a.tier
    // 2) Caller-supplied same-tier nudge, DESC.
    if (a.extra !== b.extra) return b.extra - a.extra
    // 3) Original order, ASC. Stable, deterministic final fallback.
    return a.index - b.index
  })

  return scored.map(entry => entry.item)
}
