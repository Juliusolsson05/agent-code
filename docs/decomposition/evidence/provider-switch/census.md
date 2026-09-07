# Transcript census for the quota-independent provider switch

Stage 0 of `docs/decomposition/quota-independent-provider-switch.md`. Measured
2026-09-07 on this machine's local provider stores. Feature issue
[#821](https://github.com/Juliusolsson05/agent-code/issues/821); hazard issue
[#820](https://github.com/Juliusolsson05/agent-code/issues/820); package issue
[agent-transcript-parser#24](https://github.com/Juliusolsson05/agent-transcript-parser/issues/24).

**Why this document exists.** The shrink ladder in
`docs/superpowers/specs/2026-09-05-quota-independent-provider-switch-design.md`
decides, in order, what to strip from a conversation that does not fit the
target's budget. Every rung of that ladder is a claim about proportion — "tool
results are where the bytes are", "reasoning is not worth stripping", "dropping
turns is a last resort". Those claims are worth nothing if they were guessed in
a planning session. This is the measurement they must come from.

**Privacy.** Nothing here identifies a file. Files are referred to by size and
by an index within their predicate. No transcript content is quoted except the
Claude rate-limit message, which is a Claude Code product string, not user data.

## Method

Every `*.jsonl` under `~/.claude/projects` and `~/.codex/sessions` was streamed
line by line and each record parsed — 3,328 files, 7.15 GB, no sampling — and
the seven Task 0 relationship predicates evaluated against each file. For each
predicate the smallest matching candidate was then handed to the committed
extractor (`testing/corpus/extract-observed-sequences.mts`), which applies its
own smallest-candidate rule and the existing redaction before writing a fixture.

Two different measurements appear below and they must not be confused:

- **Real** — the fixture's exact record set decoded *before* redaction. These
  are the numbers the ladder thresholds come from.
- **Fixture** — the committed, redacted `source.jsonl` decoded the same way.
  Entry counts are identical to Real; byte totals are 0.3–2.4 % of Real,
  because redaction replaces every private scalar with `"fixture text"`.

Both were produced with the census script in the Task 0 brief (kept out of the
repository), extended only to apply each case's `keep` predicate and to report
counts, `estimateConversationCharacters`, and the tool-result share.

A per-fixture number describes one transcript. Where a conclusion is about how
often something happens, the numbers come instead from the population section
below, measured by a second streaming pass over the same stores.

## Local corpus scale, 2026-09-07

| Store | Files | Bytes |
|---|---:|---:|
| `~/.codex/sessions` | 1,937 | 5,112,541,916 |
| `~/.claude/projects` | 1,391 | 2,036,779,522 |

## Candidates per predicate

| Relationship | Predicate | Matching files |
|---|---|---:|
| `codex-sequence-compacted-once` | exactly one `compacted` record | 230 |
| `codex-sequence-compacted-history` | exactly one `compacted` record, with ≥ 50 % of the estimated semantic characters before it | 181 |
| `codex-sequence-compacted-multi` | at least three `compacted` records | 181 |
| `codex-sequence-rate-limit-snapshot` | `token_count` payload with `rate_limits.rate_limit_reached_type` set | **0** |
| `claude-sequence-rate-limit` | assistant record with `isApiErrorMessage: true` and `error: "rate_limit"` | 7 |
| `claude-sequence-oversized` | estimated semantic characters > 581,400 | 90 (91 on the later distribution pass) |
| `claude-sequence-oversized-turns` | the same, and still > 581,400 with every `tool_result` counted as zero | 13 |

Context: 523 Codex rollouts carry at least one `compacted` record (27 % of the
store). 113 Claude transcripts carry an `isApiErrorMessage` record at all; the
`error` values observed are `invalid_request` (68 files), `server_error` (25),
`authentication_failed` (14), `unknown` (11), `rate_limit` (7).

`codex-sequence-rate-limit-snapshot` has **no local candidate** and no fixture
was written. Codex persists `token_count.rate_limits` in every rollout, but
`rate_limit_reached_type` is null in all 1,937 local rollouts — this account has
never had a Codex window actually run out while recording. Stage 4 must capture
one live, as the decomposition already anticipates.

## Selected fixtures

Selection is by smallest serialized kept-record bytes. For the four round-0
cases that also happened to be the smallest file; for both round-2 cases it did
not — `codex-sequence-compacted-history` comes from a 750,349-byte rollout
rather than the qualifying 582,221-byte one, and `claude-sequence-oversized-turns`
from a 10,629,353-byte transcript rather than the qualifying 7,870,294-byte one,
because those keep fewer relationship-bearing records.

| Case | Source file bytes | Records kept | Kept bytes (raw) | Committed `source.jsonl` bytes |
|---|---:|---:|---:|---:|
| `codex-sequence-compacted-once` | 469,134 | 52 of 101 | 250,970 | 19,616 |
| `codex-sequence-compacted-multi` | 694,068 | 154 of 495 | 323,602 | 27,334 |
| `claude-sequence-rate-limit` | 439,615 | 71 of 115 | 390,749 | 61,757 |
| `claude-sequence-oversized` | 1,293,112 | 67 of 70 | 1,261,111 | 63,960 |
| `codex-sequence-compacted-history` | 750,349 | 83 of 195 | 346,308 | 27,215 |
| `claude-sequence-oversized-turns` | 10,629,353 | 1,461 of 1,939 | 6,214,351 | 1,421,213 |

All six are below the 2 MB fixture cap; the largest,
`claude-sequence-oversized-turns`, is 1,421,213 bytes — 67.7 % of it, and the
only one where the cap is a live constraint rather than a formality. They are
larger than the ~8 KB sequence fixtures already in the corpus because they keep
whole rollouts, but redaction collapses them by a further 4.4–19.7× (kept bytes
over committed bytes, per the table above: 4.4× for
`claude-sequence-oversized-turns`, 19.7× for `claude-sequence-oversized`).

## Bytes by entry kind

Sizes follow `estimateEntryCharacters`: messages and tool calls are measured as
serialized JSON, reasoning and compaction as raw text length.

### `codex-sequence-compacted-once` — 52 records, 52 entries

| Entry kind | Entries | Real bytes | Share | Fixture bytes |
|---|---:|---:|---:|---:|
| tool-result | 8 | 49,896 | 51.6 % | 360 |
| message/assistant | 6 | 40,588 | 42.0 % | 234 |
| tool-call | 8 | 2,978 | 3.1 % | 112 |
| message/developer | 2 | 2,663 | 2.8 % | 78 |
| message/user | 4 | 619 | 0.6 % | 156 |
| reasoning | 14 | 0 | 0 % | 0 |
| compaction | 1 | 0 | 0 % | 12 |
| opaque | 9 | 0 | 0 % | 0 |
| **total** | **52** | **96,744** | | **952** |

`estimateConversationCharacters`: 97,288 (Real), 1,552 (Fixture).
Tool-result share of measured bytes: **51.6 %**.

### `codex-sequence-compacted-multi` — 154 records, 154 entries

| Entry kind | Entries | Real bytes | Share | Fixture bytes |
|---|---:|---:|---:|---:|
| message/developer | 4 | 66,172 | 36.9 % | 156 |
| tool-result | 22 | 59,981 | 33.5 % | 308 |
| message/assistant | 32 | 31,966 | 17.8 % | 1,248 |
| message/user | 58 | 15,742 | 8.8 % | 2,262 |
| tool-call | 22 | 5,296 | 3.0 % | 308 |
| compaction | 4 | 0 | 0 % | 48 |
| reasoning | 9 | 0 | 0 % | 0 |
| opaque | 3 | 0 | 0 % | 0 |
| **total** | **154** | **179,157** | | **4,330** |

`estimateConversationCharacters`: 182,484 (Real), 7,636 (Fixture).
Tool-result share of measured bytes: **33.5 %**.

### `claude-sequence-rate-limit` — 71 records, 71 entries

| Entry kind | Entries | Real bytes | Share | Fixture bytes |
|---|---:|---:|---:|---:|
| tool-result | 30 | 119,032 | 89.5 % | 420 |
| tool-call | 30 | 9,272 | 7.0 % | 1,680 |
| message/user | 1 | 4,399 | 3.3 % | 39 |
| message/assistant | 2 | 276 | 0.2 % | 78 |
| reasoning | 7 | 0 | 0 % | 84 |
| opaque | 1 | 0 | 0 % | 0 |
| **total** | **71** | **132,979** | | **2,301** |

`estimateConversationCharacters`: 133,788 (Real), 3,319 (Fixture).
Tool-result share of measured bytes: **89.5 %**.

The single `opaque` entry is **not** the rate-limit record. It is the
`isMeta: true` user record at fixture line 6, which the meta-prompt rule in
`claude/conversation/decode.ts` keeps out of semantic history. The rate-limit
record decoded as an **ordinary assistant message** — that is precisely the
defect Stage 1 exists to fix, and the reason this fixture was extracted.

Measured against the parser at the Task 0 commit (`7f9a14d`). Stage 1
(`bffecd6`) has since added the `api_error` rule, and re-running the same
measurement at that commit moves the rate-limit record out of assistant text:

| | opaque entries | message/assistant | total characters | tool-result share |
|---|---:|---:|---:|---:|
| at `7f9a14d` (table above) | 1 | 2 entries / 276 | 132,979 | 89.5 % |
| at `bffecd6` (Stage 1) | 2 | 1 entry / 95 | 132,798 | 89.6 % |

So the record is worth 181 characters of history that a projection used to
carry into the target provider as if the model had written it. The ladder
conclusions below are unaffected — the shift is 0.14 % of this transcript — and
the other three fixtures contain no `isApiErrorMessage` records, so their tables
are identical at both commits.

### `claude-sequence-oversized` — 67 records, 67 entries

| Entry kind | Entries | Real bytes | Share | Fixture bytes |
|---|---:|---:|---:|---:|
| tool-result | 26 | 593,076 | 92.1 % | 364 |
| message/assistant | 5 | 43,496 | 6.8 % | 195 |
| tool-call | 26 | 4,901 | 0.8 % | 1,344 |
| message/user | 1 | 2,623 | 0.4 % | 39 |
| reasoning | 9 | 0 | 0 % | 108 |
| **total** | **67** | **644,096** | | **2,050** |

`estimateConversationCharacters`: 644,901 (Real), 3,037 (Fixture).
Tool-result share of measured bytes: **92.1 %**.

## The two majority-shape fixtures

Round 2. The distributions below showed that both size-selected fixtures sit at
the mild end of their populations, so the controller ruled that Stage 0 gains
two more, selected by relationships that demand the majority shape. Extracted
through the same extractor and redaction; measured against the parser at
**`bffecd6`** (Stage 1), the commit these fixtures were added on top of.

### `codex-sequence-compacted-history` — 83 records, 83 entries

Selects a rollout with exactly one `compacted` record where at least half of
`estimateSemanticCharacters` precedes it. 181 of the 1,937 local rollouts
qualify; this is the smallest by kept-record bytes.

| Entry kind | Entries | Real bytes | Share | Fixture bytes |
|---|---:|---:|---:|---:|
| tool-result | 15 | 164,191 | 70.6 % | 613 |
| message/assistant | 9 | 29,873 | 12.9 % | 351 |
| message/developer | 5 | 19,200 | 8.3 % | 195 |
| tool-call | 15 | 12,425 | 5.3 % | 210 |
| message/user | 13 | 6,771 | 2.9 % | 507 |
| reasoning | 13 | 0 | 0 % | 0 |
| compaction | 1 | 0 | 0 % | 12 |
| opaque | 12 | 0 | 0 % | 0 |
| **total** | **83** | **232,460** | | **1,888** |

`estimateConversationCharacters`: 233,606 (Real), 3,125 (Fixture).
Tool-result share: **70.6 %**.

**Characters before the compaction.** The compaction is conversation entry 23
of 83 — the point of this fixture, against `codex-sequence-compacted-once`
where it is entry 2 with nothing before it. The share depends on which measure
is used, and the two disagree sharply:

| Measure | Before | After | Share before |
|---|---:|---:|---:|
| `estimateSemanticCharacters` (the selection predicate) | 39,050 | 20,823 | **65.2 %** |
| `estimateEntryCharacters` (what the planner budgets) | 40,237 | 192,223 | **17.3 %** |

Both are correct; they count different things, and the gap is a fact about the
selection helper, not about this rollout. `estimateSemanticCharacters` sees only
59,873 of this rollout's 232,460 planner characters — 26 % — because modern
Codex tool traffic hides from it: a `custom_tool_call` keeps its input in
`payload.input` (the helper reads only `payload.arguments`) and a
`custom_tool_call_output` keeps its output in `payload.output` **as a list**
(the helper reads only a string). Both are concentrated after the compaction
here. The fixture still does its job — 23 entries and 40,237 planner characters
of real pre-compaction history where `compacted-once` has zero — but the
"≥ 50 %" clause is a property of the selection estimate, and a Stage 2 test that
wants a decoded majority before the compaction must re-select on the planner's
measure.

### `claude-sequence-oversized-turns` — 1,461 records, 1,470 entries

Selects a transcript that is over budget **and** still over budget with every
`tool_result` counted as zero: the population that forces the drop rung. 13
local transcripts qualify; this is the smallest by kept-record bytes.

| Entry kind | Entries | Real bytes | Share | Fixture bytes |
|---|---:|---:|---:|---:|
| message/user | 110 | 1,291,761 | 41.1 % | 4,415 |
| tool-call | 364 | 869,924 | 27.7 % | 17,756 |
| tool-result | 364 | 733,557 | 23.3 % | 7,519 |
| message/assistant | 263 | 225,978 | 7.2 % | 10,257 |
| compaction | 1 | 20,535 | 0.7 % | 12 |
| reasoning | 258 | 0 | 0 % | 3,096 |
| opaque | 110 | 0 | 0 % | 0 |
| **total** | **1,470** | **3,141,755** | | **43,055** |

`estimateConversationCharacters`: 3,162,471 (Real), 65,352 (Fixture).
Tool-result share: **23.3 %**.

**After zeroing tool results**, by both measures:

| Measure | Full | Tool results zeroed | Versus the 581,400 budget |
|---|---:|---:|---|
| `estimateSemanticCharacters` (the selection predicate) | 1,607,210 | 894,987 | still **1.54×** over |
| `estimateEntryCharacters` (what the planner budgets) | 3,162,471 | 2,428,914 | still **4.18×** over |

Both columns of the second row are the same measure: 3,162,471 − 733,557. An
earlier revision of this row printed 2,408,198, which is the by-kind table's
1,470-entry total (3,141,755) minus tool results — a different measure from the
3,162,471 beside it, and a ratio of 4.14× that no single measure produces.

This is the fixture the corpus was missing. At 5.44× the budget it cannot be
fitted by clearing tool results — user prompts alone (1,291,761 characters) are
more than twice the whole budget — so `dropOldestTurns` must fire, and Stage 2
can finally assert what it drops and what it keeps. It also carries one real
compaction (20,535 characters of carrier summary), so the interaction between an
existing compaction and the drop rung is exercised on real data.

Note the selection predicate found 13 transcripts where the earlier
distribution found 46. Both are right about different measures: the 46 came from
the planner's measure, which counts tool-call inputs (869,924 characters in this
fixture — Claude `Write`/`Edit` payloads), while `estimateSemanticCharacters`
ignores them. The 13 are therefore a strict, conservative subset: every one of
them is over budget on prompts and replies alone.

## Population distributions

A fixture is the *smallest* member of its population by construction, which
makes it the worst possible basis for a claim about how often a ladder rung
fires. The two conclusions below that decide Task 2's thresholds are therefore
stated from the whole population, not from the fixture. These numbers come from
a second streaming pass over the same stores that replicates
`estimateEntryCharacters` record by record; it reproduces
`estimateConversationCharacters` exactly on all four fixtures (97,288 /
182,484 / 133,788 / 644,901) and their compaction entry indexes, so
"planner characters" below is the same quantity `planConversationContext`
compares against a budget.

### All Claude transcripts over the Codex budget (n = 91)

The oversized predicate matched 91 local transcripts on the second pass, one
more than the first (transcripts are still being written on this machine; the
three smallest are unchanged, so fixture selection is unaffected). Of the 91,
**90** exceed 581,400 planner characters — the extractor's cheaper raw-record
estimate over-selects by one file.

| Statistic | min | p25 | median | p75 | p90 | max |
|---|---:|---:|---:|---:|---:|---:|
| planner characters ÷ 581,400 | 0.95 | 1.86 | **3.55** | 5.77 | 8.82 | **38.00** |
| planner characters | 554,922 | — | 2,062,214 | — | 5,128,657 | 22,093,522 |
| tool-result share of characters | 23.3 % | **49.2 %** | **71.8 %** | **85.0 %** | — | 96.7 % |
| conversation entries | 67 | — | 1,514 | — | — | 13,577 |
| file bytes | 1,293,112 | — | 6,900,486 | — | — | 56,288,285 |

After clearing **every** tool-result output in each of the 91:

| Statistic | Value |
|---|---|
| still over budget | **46 of 91 (50.5 %)** |
| still over budget with a 64-character placeholder per cleared result | 47 of 91 |
| remaining characters | min 32,241 · median 605,172 · p90 2,214,532 · max 7,216,650 |
| remaining ÷ budget | median **1.04** · p90 3.81 · max **12.41** |

The committed `claude-sequence-oversized` fixture sits at ratio 1.11 with a
92.0 % tool-result share and 67 entries: the *least* stressing member of this
population on every axis, and one of the 45 that clearing alone does fix.

### All single-`compacted` Codex rollouts (n = 230)

| Statistic | Value |
|---|---|
| compaction at conversation entry index 2 | **19 of 230 (8.3 %)** |
| compaction anywhere else | **211 of 230 (91.7 %)** |
| entry index of the compaction | min 2 · median **159** · p90 598 · max 3,751 |
| zero characters before the compaction | 18 of 230 (7.8 %) |
| share of characters before the compaction, for the 211 | q1 60.0 % · median **74.3 %** · q3 86.6 % |
| characters before the compaction, for the 211 | median 900,233 · max 2,702,571 |

The committed `codex-sequence-compacted-once` fixture is one of the 19 (8.3 %).

## What the measurements say about the ladder

1. **Clearing tool results is the rung that matters, across the population.**
   Tool output is 33.5 %, 51.6 %, 89.5 % and 92.1 % of characters in the four
   fixtures, and across all 91 oversized Claude transcripts its share has a
   median of 71.8 % with a quartile range of 49.2–85.0 % and a floor of 23.3 %.
   Nothing else is close in any of them. This rung is not in question.
2. **Clearing tool results is necessary but not sufficient: `dropOldestTurns`
   fires for about half of real over-budget transcripts.** Clearing every
   tool-result output leaves **46 of 91 (50.5 %)** still over budget, at a
   median of 1.04× and up to 12.41× the budget. Real over-budget transcripts
   are not marginally over: the median is 3.55× the budget and the worst is
   38×, so a ladder that assumes one rung suffices will simply fail to fit half
   the corpus. `dropOldestTurns` is a primary mechanism, not a theoretical last
   resort, and Stage 2 must test it against a conversation that needs it —
   `claude-sequence-oversized` is not one, since at 1.11× it is fixed by
   clearing alone. The order stays strip-native-only-compactions →
   clear-tool-results → drop-oldest-turns; what changes is the expectation that
   the third rung is exercised in production roughly as often as not.
3. **Do not build a rung on reasoning.** Reasoning contributes **zero**
   measurable characters in all four fixtures. Codex reasoning is encrypted, so
   its decoded text is empty by construction. Claude thinking blocks are
   persisted with a `signature` and an *empty* `thinking` string: in an 80-file
   sample of local Claude transcripts over 200 KB, 5,471 of 5,639 thinking
   blocks (97.0 %) have empty thinking text. There is nothing to reclaim.
4. **Codex developer messages are not boilerplate.** They are 36.9 % of the
   repeatedly-compacted fixture (4 entries, 66,172 characters — the replacement
   history and user instructions that survive a remote compaction). A ladder
   that drops or truncates developer messages would delete the only plaintext
   left in a compacted Codex thread.
5. **A Codex compaction summary is worth zero characters and carries no
   portable text.** All five `compaction` entries across the two Codex fixtures
   decode to an empty summary (`summarySource: encrypted`). Budget arithmetic
   must not credit a Codex compaction with having "already shrunk" anything.
6. **A single-`compacted` Codex rollout usually keeps most of its history
   before the compaction — the fixture is the 8 % exception.** Across all 230
   matches, **211 (91.7 %)** have the compaction somewhere other than entry
   index 2 (median entry index 159), and only **18 (7.8 %)** have zero
   characters before it. For the 211, the median share of characters preceding
   the compaction is **74.3 %** (q1 60.0 %, q3 86.6 %) — three quarters of a
   typical compacted rollout is still plaintext pre-compaction history sitting
   in the file. The three smallest candidates all being compaction-at-index-2
   is an artifact of sorting by size: a thread that *begins* from a compaction
   is short, so it sorts first. Consequences: both shapes are real and Stage 2
   needs both, `requires-portable-handoff` is **not** established as the
   ordinary Codex → Claude case, and a switch that discards pre-compaction
   records because "the rollout is compacted" would throw away roughly three
   quarters of the recoverable history in the typical case. The repeatedly
   compacted fixture does carry a split (94,200 characters before the last of
   its four compactions, 84,957 after; 27,960 before the first).

## #820 — does a rate-limit carrier exist on disk?

Seven local Claude transcripts contain an assistant record with
`isApiErrorMessage: true` and `error: "rate_limit"`. Indexed by ascending file
size; "boundary after error" means a `system` / `compact_boundary` record at a
line index greater than the first rate-limit record.

| # | File bytes | Records | `rate_limit` records | `compact_boundary` at | Boundary after error? |
|---|---:|---:|---|---|---|
| RL-1 | 439,615 | 115 | 1 (index 114, last record) | none | **no** |
| RL-2 | 1,250,863 | 326 | 1 (index 325, last record) | none | **no** |
| RL-3 | 1,781,679 | 611 | 1 (index 605) | none | **no** |
| RL-4 | 4,101,592 | 1,667 | 1 (index 1,073) | none | **no** |
| RL-5 | 4,311,063 | 1,688 | 1 (index 1,656) | none | **no** |
| RL-6 | 8,988,189 | 4,155 | 63 (indexes 2,727–3,146) | 2,342 (before) | **no** |
| RL-7 | 14,196,311 | 3,750 | 1 (index 2,870) | 2,024 (before), 2,897, 3,668 | **yes** |

**Answer: the hazard does not manifest on disk in this corpus.** Only RL-7 has a
compaction after a rate-limit error — a manual `/compact` 27 records later — and
its carrier is a genuine 16,632-character summary beginning "This session is
being continued from a previous conversation that ran out of context.", not a
limit message. Its boundary metadata is coherent (`trigger: "manual"`,
`preTokens: 612029`, `postTokens: 9760`).

Two facts from the same records still argue for the Stage 1 guard:

- The observed limit message is
  `You've hit your monthly spend limit · raise it at claude.ai/settings/usage?from=cc_cli_limit_message · your session limit resets <time> (<timezone>)`
  — 154–157 characters, identical in all seven files apart from the reset time.
  It does **not** begin with `API Error`, so Claude Code's own rule ("reject a
  summary that starts with `API Error`") would not reject it if it ever landed
  in a carrier. A prefix list built only from `API Error` is insufficient.
- RL-6 shows Claude Code writing 63 consecutive rate-limit records in one
  session. A wait loop that treats "an assistant record appeared" as progress
  will spin on those.

Field names on the rate-limit record, useful for Stage 4's exhaustion signal
(names survive redaction, values do not): `error`, `apiErrorStatus`,
`requestId`, and `quotaLimits` with `rateLimitType`, `status`, `resetsAt`,
`isUsingOverage`, `overageStatus`, `overageDisabledReason`,
`unifiedRateLimitFallbackAvailable`, `lowPriorityOffer`,
`lowPriorityRetryAfterSeconds`, `lowPriorityMaxWaitSeconds`.

## Caveats the next stages must respect

1. **The committed fixtures prove shape, not size.** Redaction replaces every
   private scalar with a placeholder and de-duplicates structurally identical
   array elements, so a fixture's byte proportions are meaningless — 0.3–2.4 %
   of the real figures, in different ratios. Entry counts, entry kinds, record
   order and field names are faithful. Any Stage 2 assertion about *characters*
   must use the numbers in this document or a conversation built in the test,
   never `estimateConversationCharacters` of a fixture.
2. **`error: "rate_limit"` does not survive redaction.** The redactor's safe
   value list covers `type`, `kind`, `subtype`, `role`, `phase`, `status` and
   `stop_reason` only, so the committed `claude-sequence-rate-limit` fixture
   carries `"error": "fixture text"`. It still proves the record's position,
   its `isApiErrorMessage: true` flag and its `quotaLimits` shape — which is
   enough for a decode rule keyed on `isApiErrorMessage`, and is what Stage 1's
   `api_error` rule in fact keys on. It cannot prove the literal `rate_limit`
   code. Stage 1 must therefore either add `error` to that allowlist
   deliberately — a redaction-policy change, since `error` is not a
   low-cardinality field on every provider — or assert on `isApiErrorMessage`
   and use the synthesized carrier fixture it already plans for the text.
3. **Both size-selected fixtures are the mild end of their populations, and
   one is an 8 % minority shape.** `codex-sequence-compacted-once` has no
   pre-compaction history, which is true of only 18 of 230 matching rollouts
   (7.8 %); the other 211 keep a median 74.3 % of their characters before the
   compaction. `claude-sequence-oversized` is 1.11× the budget where the
   population median is 3.55×, and it is one of the cases clearing tool results
   alone fixes. Neither is wrong as evidence of *wire shape*, which is all they
   claim, but neither can carry a threshold. **Resolved in round 2** by
   `codex-sequence-compacted-history` and `claude-sequence-oversized-turns`,
   whose predicates carry the missing second clause. The four original fixtures
   are kept: the mild shapes are real too, and a ladder that only ever sees the
   hard case is as untested as one that only ever sees the easy case. Stage 2
   should assert against both members of each pair.
4. **No Codex rate-limit snapshot exists locally.** Stage 4 cannot be built
   against a recorded `rate_limit_reached_type`; it must capture one during
   verification, and until then the derivation is unproven against real bytes.
