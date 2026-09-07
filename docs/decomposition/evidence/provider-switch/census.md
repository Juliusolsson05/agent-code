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
the five Task 0 relationship predicates evaluated against each file. For each
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

## Local corpus scale, 2026-09-07

| Store | Files | Bytes |
|---|---:|---:|
| `~/.codex/sessions` | 1,937 | 5,112,541,916 |
| `~/.claude/projects` | 1,391 | 2,036,779,522 |

## Candidates per predicate

| Relationship | Predicate | Matching files |
|---|---|---:|
| `codex-sequence-compacted-once` | exactly one `compacted` record | 230 |
| `codex-sequence-compacted-multi` | at least three `compacted` records | 181 |
| `codex-sequence-rate-limit-snapshot` | `token_count` payload with `rate_limits.rate_limit_reached_type` set | **0** |
| `claude-sequence-rate-limit` | assistant record with `isApiErrorMessage: true` and `error: "rate_limit"` | 7 |
| `claude-sequence-oversized` | estimated semantic characters > 581,400 | 90 |

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

Selection is by smallest serialized kept-record bytes, which coincided with
smallest file size for all four cases.

| Case | Source file bytes | Records kept | Kept bytes (raw) | Committed `source.jsonl` bytes |
|---|---:|---:|---:|---:|
| `codex-sequence-compacted-once` | 469,134 | 52 of 101 | 250,970 | 19,616 |
| `codex-sequence-compacted-multi` | 694,068 | 154 of 495 | 323,602 | 27,334 |
| `claude-sequence-rate-limit` | 439,615 | 71 of 115 | 390,749 | 61,757 |
| `claude-sequence-oversized` | 1,293,112 | 67 of 70 | 1,261,111 | 63,960 |

All four are far below the 2 MB fixture cap. They are larger than the ~8 KB
sequence fixtures already in the corpus because they keep whole rollouts, but
redaction collapses them by a further 20–95×.

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

The single `opaque` entry is the rate-limit record itself: today's Claude
decoder emits it as an opaque entry, which is what Stage 1 changes to carry
`nativeType: "api_error"`.

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

## What the measurements say about the ladder

1. **Clearing tool results is the only rung that matters at these sizes.** Tool
   output is 33.5 %, 51.6 %, 89.5 % and 92.1 % of measured bytes in the four
   fixtures. Nothing else is close.
2. **The one real over-budget case is fixed by that rung alone.**
   `claude-sequence-oversized` estimates 644,901 characters against the
   configured Codex budget of 581,400 — 10.9 % over. Clearing tool-result
   output removes 593,076 characters and lands at roughly 51,825, about 9 % of
   budget. Dropping oldest turns is never reached. The ladder should therefore
   be ordered strip-native-only-compactions → clear-tool-results →
   drop-oldest-turns, and `dropOldestTurns` should be treated as the rung that
   almost never fires rather than the primary mechanism.
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
6. **A single-`compacted` Codex rollout usually has nothing before the
   compaction.** In all three smallest candidates the compaction is entry index
   2 of the conversation, with **0** measured bytes before it and 100 % after —
   these are resumed or forked threads that *begin* from a compaction, not long
   sessions that compacted midway. Only the repeatedly-compacted fixture shows a
   real split (94,200 characters before the last compaction, 84,957 after,
   47.4 % after). Consequence for the design: `requires-portable-handoff` is the
   ordinary Codex → Claude case, not an edge case, and Stage 2 tests that need
   substantial pre-compaction history must use `codex-sequence-compacted-multi`.
   See the caveat below on what this means for the `compacted-once` predicate.

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
   its `isApiErrorMessage: true` flag, its `quotaLimits` shape, and that today's
   decoder turns it into an `opaque` entry. Stage 1 must either add `error` to
   that allowlist deliberately — a redaction-policy change, since `error` is not
   a low-cardinality field on every provider — or key its test on
   `isApiErrorMessage` and use the synthesized carrier fixture it already plans.
3. **`codex-sequence-compacted-once` has no pre-compaction history.** The
   smallest-candidate rule selected a rollout whose compaction is at entry
   index 2. That is representative (all three smallest candidates look the same)
   but it does not exercise "pre-compaction records still present earlier in the
   rollout". If Stage 2 needs that, the predicate needs a second clause — e.g.
   at least N characters of content before the `compacted` record — and a new
   extraction, not a hand edit of the fixture.
4. **No Codex rate-limit snapshot exists locally.** Stage 4 cannot be built
   against a recorded `rate_limit_reached_type`; it must capture one during
   verification, and until then the derivation is unproven against real bytes.
