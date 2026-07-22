# Command-palette search relevance — plan

Date: 2026-07-22
Branch: `fix/palette-search-quality`

## The report

Typing `read this p` into the prompt-template picker (on the way to
"read this project") puts the builtin **Read This Project** template in
**7th place**, behind six custom templates that have nothing to do with
the query — an ADHD output-style skill, two review templates, an
orchestrator template, and a workflow template.

That is a total ranking inversion: the one entry whose title the user is
literally typing, character for character, from the start, loses to six
entries that match nothing a human would call a match.

## Root cause — two bugs that compound

### Bug 1: template results are not ranked at all

`CommandPalette.tsx` filters templates with a plain boolean `.filter()`:

```ts
const filteredPromptTemplates = useMemo(
  () => queryText
    ? promptTemplates.filter(t =>
        fuzzyMatch(t.title, queryText) ||
        fuzzyMatch(t.description, queryText) ||
        fuzzyMatch(t.body, queryText))
    : promptTemplates,
  [promptTemplates, queryText],
)
```

There is no scoring step. The rendered order is therefore whatever order
`allPromptTemplates()` hands back, which is:

```ts
return [...customTemplates, ...builtinPromptTemplates]
```

So **every** custom template that matches at all outranks **every**
builtin template, regardless of match quality. "Read This Project" is a
builtin. It is structurally incapable of beating a custom template that
matched by accident. Match strength never enters the ordering.

This is a gap, not a regression: when the command list got a real ranker
(`lib/rankCommands.ts` — tier-first ordering, history as a same-tier
tiebreak only), the other four palette lists were left on the old
boolean filter. Commands rank; templates, sessions, buried tabs, and AI
workspaces do not.

### Bug 2: fuzzy-matching long body text matches everything

`fuzzyMatch` is a **subsequence** test — every query char must appear in
order, with unlimited gaps. That is a reasonable net for a short title
("spr" → "Split Pane Right"). Run it against a multi-paragraph prompt
body and it degenerates into "does this text contain these letters
somewhere, in any order-ish arrangement", which for a thousand-character
body is *true for almost any query*.

`read this p` needs an `r`, then an `e`, then an `a`… scattered anywhere
across the whole body. Every prose template in the list satisfies that.
Spaces make it worse: a space in the query is satisfied by any whitespace
in the body, of which prose has hundreds.

So the filter admitted six irrelevant custom templates (bug 2), and the
absence of ranking guaranteed they all sorted above the correct answer
(bug 1). Either bug alone would be survivable. Together they produce the
screenshot.

The same subsequence-over-prose mistake is present in the session filter
(`fuzzyMatch(s.firstPrompt, …)`). Note first prompts are *not* unbounded —
`extractFirstUserPrompt` caps them at 200 chars — but 200 chars of prose
is still far past the point where a subsequence test means anything.

### A stale comment that documents the drift

`templates.ts` still says:

> The palette filters on title + description only (see
> `filteredPromptTemplates`), and nobody searching for this types
> "bootstrap" — they type "read" or "project".

That was true once. `body` was added to the match set later and the
comment was not updated, so the file now asserts an invariant the code
violates — and it is exactly the invariant whose violation caused this
bug. It gets corrected as part of the fix.

## The fix

One shared relevance ranker for every palette list, replacing four
hand-rolled boolean filters.

### 1. New `lib/rankEntries.ts`

A generic, pure, React-free ranker in the same spirit as
`rankCommands`. Callers describe each item as a set of weighted fields:

- `primary` — the name the user is typing (title, summary, label, name).
- `secondary` — short supporting text and aliases (description,
  keywords, branch, workspace id).
- `body` — long prose (template body, first prompt).

Tiers, strongest first:

| Tier | Condition |
| --- | --- |
| 5 | query is a **prefix** of a primary field |
| 4 | query is a **substring** of a primary field |
| 3 | query is a **substring** of a secondary field |
| 2 | query is a **substring** of a body field |
| 1 | **subsequence** match on a primary or secondary field |
| 0 | no match — dropped |

**The load-bearing rule: `body` fields are matched by literal substring
only, never by subsequence.** A literal `read this p` occurring inside a
prompt body is real signal and worth surfacing at tier 2; a subsequence
hit inside the same body is noise, and admitting it is precisely bug 2.
The tier table can be re-tuned later; that one rule is the fix and must
not be relaxed without re-reading this document.

Ties break on the caller's original array index, so equal-relevance
results keep their deliberate authored order and sorting stays
deterministic (never `Array.sort`'s implementation-defined behavior).

### 2. Re-point `rankCommands` at the shared core

`rankCommands` keeps its public signature and its history-as-tiebreaker
behavior, but stops carrying a private copy of the tier logic: title
becomes the primary field, keywords become secondary. Commands have no
body field, so their relative ordering is unchanged by construction —
the old 4/3/2/1 tiers map onto the new 5/4/3/1 with the same ordering
between any two commands. This is a refactor, not a behavior change, and
it exists so there is exactly one definition of "relevance" in the
palette rather than two that can drift apart the way these did.

`fuzzyMatch` stays exported from `rankCommands` (other call sites import
it from there) but is re-exported from the shared module.

### 3. Rank the four remaining lists

| List | primary | secondary | body |
| --- | --- | --- | --- |
| Prompt templates | `title` | `description` | `body` |
| Sessions | `summary` | `gitBranch` | `firstPrompt` |
| Buried tabs | `label` | `description`, `note` | — |
| AI workspaces | `name` | `description`, `workspaceId` | — |

Empty query returns the input list untouched in every case, matching the
existing "browse the menu" behavior — a resting palette must not shuffle.

## Blast radius

Everything downstream of these four `useMemo`s is index-based and
order-agnostic: `filteredLength`, the arrow-key `selectedIndex`, the
Enter handlers, and the preview panel all index into the same arrays
they always did. Order changing under them is exactly what already
happened when `rankCommands` landed for commands. `selectedIndex` is
already reset on query change, so a reorder cannot strand the cursor.

No new test files (see repo convention); the change is verified by `tsc`
on both projects, the existing suite, and driving the real palette.

## Round 2 — what the review changed

Two orchestrated reviewers went over the first implementation. The
correctness reviewer confirmed the `rankCommands` refactor equivalent by
differential fuzzing (20k cases, 0 mismatches) and found no defects. The
search-quality reviewer found six, all confirmed against real repo data,
and five of them were regressions the first cut introduced. The fix as
merged therefore also includes:

**Whitespace normalization on both sides of every comparison.** All
whitespace runs — including newlines — collapse to single spaces. This
was the highest-value single line in the whole change: it fixed a stray
double space ("read this  project") returning ZERO results, and it fixed
template bodies being assembled with `lines.join('\n')`, which made any
phrase spanning a line break permanently unmatchable even though the
preview panel renders it as one continuous wrapped paragraph.

**An out-of-order token pass** (`tokenTier`, capped at tier 4). The query
was matched as one literal string at every tier, so "project read" — right
words, wrong order — scored 0 where the old too-permissive filter had
found the row. Every whitespace-separated token must now match the name or
supporting text in any order; the row scores as its weakest token. Tokens
deliberately do not match body fields: per-token body matching would let a
one-character token hit every prose body in the list and re-admit exactly
the noise this change exists to remove.

Typo tolerance is NOT restored ("read this projekt" still returns
nothing). The old filter only found it by subsequence-matching a body,
which is the bug. Accepted as the price of precision.

**Initialism promotion to tier 4.** "atat" for "Active Tab Agent
Transcripts" landed in the flat tier-1 bucket and came 6th of 6, because
tier 1 falls through to array index and every custom index beats every
builtin one — the reported pathology, surviving inside the widest tier.
Promoting word-initial matches removed the concrete cases without opening
a general match-density scoring project. The residual within-tier-1
custom-first bias is documented as a known limit at the tier table.

**Three field-weight corrections.** Buried tabs: `note` (the only
human-authored, row-distinguishing field) is now primary and the generated
`${kind} · ${cwdBase}` label is secondary — previously the label's mass
ties at tier 4 meant the note never decided anything, and the description
(an absolute path) tier-3-matched every pane for "users" or "development".
AI workspaces: `workspaceId` moved to `body`, because UUIDs at secondary
gave every hex fragment ("de", "bea") the same weight as a deliberate
description match on a field the row never renders.

**Four comment-vs-code mismatches**, including one this PR introduced
while advertising the fix of another. Most notably `templates.ts` claimed
a title prefix match "wins outright" — it does not; it wins its tier and
then loses to any custom template on index.

Deliberately NOT changed, after review argued both ways: tier 3 above
tier 2 (a description is authored to describe the row; a body mention is
incidental — every real example supports it), and the empty-query resting
order. The right fix for resting order is a usage-frequency signal via the
existing `extraTiebreak` hook, not relevance ranking of an empty query.

## Verification

1. `npx tsc --noEmit -p tsconfig.node.json` and `-p tsconfig.web.json`.
2. Existing `vitest` suite passes.
3. Manual: type `read this p` in the template picker → **Read This
   Project** is row 1. Type a word that only appears in one body → that
   template still appears, at the bottom.
