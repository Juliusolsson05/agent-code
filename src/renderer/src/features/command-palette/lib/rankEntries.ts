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
// Case-insensitive only — deliberately NOT whitespace-normalized, unlike
// the internal `fuzzyMatchNormalized` used by the tier ladder. This is the
// public entry point and `QuickOpenOverlay` matches file paths with it,
// where collapsing whitespace would change meaning.
export function fuzzyMatch(text: string, query: string): boolean {
  return fuzzyMatchNormalized(text.toLowerCase(), query.toLowerCase())
}

// How much a field is allowed to claim about the user's intent.
//
//   primary   — the name the user is actually typing (title, summary,
//               label, workspace name). Matching here is the strongest
//               possible evidence.
//   secondary — short supporting text and aliases (description,
//               keywords, git branch). Real signal, but a user typing a
//               description word is less sure of what they want than one
//               typing the name.
//   body      — free-form text of unbounded length that the user did not
//               write as a label: a prompt template's body, a session's
//               first prompt, an absolute path, an opaque id. Length is
//               not the defining property (some template bodies are two
//               lines) — the defining property is that the text was not
//               authored to identify the row, so a match in it is weak
//               evidence and a SCATTERED match in it is no evidence at
//               all. Hence tier 2 and the never-subsequence rule.
//
// Choosing a weight is the entire design decision at each call site. Ask
// "would a user type this to find this row?" — the answer picks the
// weight. Note the cost of demoting to `body`: it also becomes immune to
// subsequence matching, so a short, accurate, human-written sentence
// (e.g. a template body that reads like a description) loses initialism
// and typo tolerance. When in doubt between `secondary` and `body`, the
// question is whether the field is short AND authored to identify.
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
// Whitespace is normalized on both sides before any of this runs.
//
//   5 — query is a PREFIX of a primary field. The user is typing the
//       name from the start; nothing should ever outrank this.
//   4 — query is a substring of a primary field (matched mid-name), OR
//       spells the initials of consecutive words in one ("atat" →
//       "Active Tab Agent Transcripts").
//   3 — query is a substring of a secondary field.
//   2 — query is a LITERAL substring of a body field.
//   1 — subsequence match on a primary or secondary field.
//
// Plus an out-of-order fallback (`tokenTier`, capped at 4) so word order
// does not have to be remembered exactly.
//
// The load-bearing rule is the asymmetry at tiers 2 and 1: body fields
// are matched by literal substring ONLY, never by subsequence. A literal
// "read this p" sitting inside a prompt body is genuine signal worth
// surfacing near the bottom; a subsequence hit in that same body is pure
// noise and admitting it is exactly what broke template search. The
// numbers in this table can be re-tuned; that asymmetry cannot be
// relaxed without re-reading the plan doc first.
//
// KNOWN LIMIT, accepted deliberately: within a tier, ordering falls to
// the caller's array index. For templates that index runs over
// `[...custom, ...builtin]`, so two rows that match EQUALLY well still
// resolve custom-first. Tier 1 is the widest bucket, so this is most
// visible there. It is not the reported bug (which was a builtin losing
// to rows that matched far worse) and the remedies — match density,
// earliest-offset, contiguous-run scoring — are a ranking-quality
// project of their own. The acronym promotion above exists because it
// removed the worst concrete cases without opening that project.
//
// An entry is assigned exactly one tier — the best one it can claim —
// so the sort has a single comparable number per row.
export function relevanceTier(fields: MatchField[], query: string): number {
  const q = normalize(query)
  if (q.length === 0) return 0

  // Normalize once per field rather than once per comparison below — this
  // runs over every row on every keystroke. Everything downstream of here
  // (including `fuzzyMatchNormalized`) assumes already-normalized input,
  // which is why the internal helper exists separately from the exported
  // `fuzzyMatch`: the exported one has to normalize defensively, and
  // calling it here would redo this work on every tier-1 comparison.
  const primaries: string[] = []
  const secondaries: string[] = []
  // Bodies are collected raw and normalized LAZILY. They are the longest
  // text we touch and most rows never reach the body check — a row whose
  // name prefix-matches is decided by the very first test. Normalizing
  // them eagerly would mean regex-scanning every session's first prompt on
  // every keystroke to answer a question we already answered.
  const rawBodies: string[] = []
  for (const field of fields) {
    if (field.text.length === 0) continue
    if (field.weight === 'body') rawBodies.push(field.text)
    else if (field.weight === 'primary') primaries.push(normalize(field.text))
    else secondaries.push(normalize(field.text))
  }

  const whole = wholeQueryTier(primaries, secondaries, rawBodies, q)
  // A perfect whole-query hit is the ceiling; skip the token pass, which
  // can never beat it (it is capped at 4).
  if (whole === 5) return 5
  return Math.max(whole, tokenTier(primaries, secondaries, q))
}

// The primary path: the query treated as ONE contiguous string, which is
// what a user typing a name from the start is doing.
function wholeQueryTier(
  primaries: string[],
  secondaries: string[],
  rawBodies: string[],
  q: string,
): number {
  if (primaries.some(text => text.startsWith(q))) return 5
  if (primaries.some(text => text.includes(q))) return 4
  // Initialisms are promoted to the same strength as a substring of the
  // name, because "atat" for "Active Tab Agent Transcripts" is a
  // deliberate, high-confidence act — the user knows exactly which row
  // they want. Left at tier 1 it lost to every unrelated row that
  // happened to contain those letters scattered anywhere, which is the
  // same class of inversion this whole module exists to fix.
  if (q.length >= 2 && !q.includes(' ') && primaries.some(text => acronymMatch(text, q))) return 4
  if (secondaries.some(text => text.includes(q))) return 3
  if (rawBodies.some(text => normalize(text).includes(q))) return 2
  if (
    primaries.some(text => fuzzyMatchNormalized(text, q)) ||
    secondaries.some(text => fuzzyMatchNormalized(text, q))
  ) {
    return 1
  }
  return 0
}

// The out-of-order fallback: every whitespace-separated token must match
// somewhere in the name or the supporting text, in ANY order.
//
// Without this the query is one literal string at every tier, so "project
// read" — right words, wrong order — scored 0 and the user saw "no
// matches" for a template whose title contains both words. The old
// too-permissive filter at least found it. Precision is worth having;
// brittleness is not, and word order is the single most common way a
// half-remembered name comes out wrong.
//
// Scored by the WEAKEST token (a chain is as strong as its weakest link:
// if one word only matched as a scattered subsequence, the whole query
// only matched that well) and capped at 4 — an out-of-order match must
// never claim tier 5, which means "you typed this name from the start".
//
// Tokens deliberately do NOT match body fields. A body is admitted only
// by the full contiguous query. Per-token body matching would let short
// tokens like "p" hit every prose body in the list and drag the noise
// this module was written to eliminate straight back in.
function tokenTier(primaries: string[], secondaries: string[], q: string): number {
  const tokens = q.split(' ')
  if (tokens.length < 2) return 0

  let weakest = 4
  for (const token of tokens) {
    const tier = primaries.some(text => text.includes(token))
      ? 4
      : secondaries.some(text => text.includes(token))
        ? 3
        : primaries.some(text => fuzzyMatchNormalized(text, token)) ||
            secondaries.some(text => fuzzyMatchNormalized(text, token))
          ? 1
          : 0
    // One unmatched word disqualifies the row outright. Matching "any
    // token" instead would make every extra word the user types widen the
    // result set rather than narrow it.
    if (tier === 0) return 0
    if (tier < weakest) weakest = tier
  }
  return weakest
}

// Word-initial match: do the query's characters spell out the first
// letters of consecutive words? Cheap because the initials string is at
// most one char per word.
function acronymMatch(text: string, q: string): boolean {
  let initials = ''
  for (const word of text.split(' ')) {
    if (word.length > 0) initials += word[0]
  }
  return initials.includes(q)
}

// Collapse ALL whitespace runs — including newlines — to single spaces,
// then trim. Two bugs made this load-bearing rather than cosmetic:
//
//   1. A stray double space ("read this  project") made the literal
//      substring checks fail and the user saw zero results, with nothing
//      on screen to explain why.
//   2. Template bodies are assembled with `lines.join('\n')`. Body fields
//      match by literal substring, and a user cannot type a newline into
//      the search box — so any phrase spanning a line break was
//      permanently unreachable, including phrases the preview panel
//      renders as one continuous wrapped paragraph (soft wraps and hard
//      newlines look identical there).
function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim()
}

// Subsequence test over inputs that are ALREADY normalized. Split out
// from the exported `fuzzyMatch` so the hot path does not re-lowercase
// both arguments on every comparison — tier 1 is the largest bucket, so
// that redundant work was happening on most rows on most keystrokes.
function fuzzyMatchNormalized(text: string, query: string): boolean {
  let j = 0
  for (let i = 0; i < text.length && j < query.length; i++) {
    if (text[i] === query[j]) j++
  }
  return j === query.length
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
