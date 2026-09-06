# Quota-independent provider switch

Status: Decomposition written 2026-09-05, awaiting user approval before any
implementation stage starts. Feature issue: [#821](https://github.com/Juliusolsson05/agent-code/issues/821).
Hazard issue: [#820](https://github.com/Juliusolsson05/agent-code/issues/820).
Package issues: [agent-transcript-parser#24](https://github.com/Juliusolsson05/agent-transcript-parser/issues/24),
[codex-headless#46](https://github.com/Juliusolsson05/codex-headless/issues/46).
Design spec: `docs/superpowers/specs/2026-09-05-quota-independent-provider-switch-design.md`.
Implementation plan: `docs/superpowers/plans/2026-09-05-quota-independent-provider-switch.md`.

## Why this decomposition applies

The switch transaction spans a parser package (neutral conversation document,
capacity planning, native projectors), two headless runtime packages, the main
process transaction, and the renderer's bulk modal. Three providers must agree
on one projected transcript, and the case set (what real transcripts look like
when a provider is exhausted, how large they are, what an oversized shrink must
preserve) has never been enumerated from recordings. The 2026-06-24 bulk switch
design shipped with no tests and the 2026-09-03 compaction-memory fix was driven
by a production heap snapshot, which is exactly the forward-patching pattern this
method prevents. The staged-decomposition threshold applies.

The user has explicitly rejected two shapes: speculative pre-summarization that
spends source tokens on a guess, and any custom "handmade compaction" prompt as a
product path. Every stage below is constrained by that.

## A — what exists and is trusted

| Artifact | Trusted responsibility | Not established by it |
|---|---|---|
| `packages/agent-transcript-parser/src/operations/contextBudget.ts` `planConversationContext` | Four outcomes: `ready`, `existing-compaction`, `requires-portable-handoff`, `requires-compaction`; character budget = tokens × effective% × 0.9 × 2.5 | Any outcome that avoids a source turn when native-only compaction exists or the effective history exceeds budget |
| `operations/compaction.ts` `describeLatestCompaction`, `compactionPortability`, `conversationAfterLatestPortableCompaction` | Claude carrier vs boundary placeholder, Codex encrypted = native-only | Rejecting a carrier whose text is a rate-limit message (#820) |
| `operations/contextBudget.ts` `fitConversationToCharacterBudget` | Lossy suffix fit at user boundaries with a synthetic compaction marker; refused for encrypted Codex by the host | Clearing tool results, indexing dropped prompts, any policy below the model budget |
| `claude/conversation/decode.ts`, `codex/conversation/decode.ts` | Claude boundary+carrier → one `compaction` entry (`summarySource: carrier`); Codex `compacted` → `compaction` (`summarySource: encrypted`); pre-compaction records stay as ordinary entries | Claude assistant records with `isApiErrorMessage: true` are decoded as assistant messages |
| `claude/project/nativeResume.ts`, `codex/project/nativeResume.ts` | Compaction entry → Claude boundary+carrier; foreign plaintext compaction → Codex developer handoff; encrypted reasoning demoted cross-provider; same-provider `compacted` preserved verbatim | Acceptance of cleared tool outputs and drop markers by the live CLIs (structural only) |
| `src/main/providerSwitch/switchProvider.ts` | Transaction order: read → plan → (compactSource) → project → write; `overflowPolicy: compact \| fail \| truncate` | Any plan that skips `compactSource` when a source turn is required |
| `src/main/providerSwitch/compactBeforeSwitch.ts` | `/compact` delivery, stat-gated compaction wait (#720), Codex/OpenCode handoff turns, 300 s timeout | Rejecting a rate-limit carrier; failing fast on a `rate_limit` record; any use against a *target* session |
| `src/main/providerSwitch/transcriptEngine.ts` | Adapters, target profiles (Claude `[1m]` → 1M, Codex from `config.toml` + `models_cache.json`, OpenCode 128k) | Nothing new needed; budgets are reused |
| `src/main/ipc/provider.ts` | Per-agent lock, per-agent native confirmation dialog, progress events | Batch-level confirmation |
| `src/renderer/src/workspace/hook/actions/providerSwitchCore.ts` | Wake source, translate, `replaceSession` pinned to the agent, progress, refusal while `processActive \|\| semantic.currentTurn` | Switching a pane that is idle because of a limit but still shows a provider wait banner |
| `src/renderer/src/workspace/hook/actions/bulkProviderSwitch.ts`, `features/workspace/ui/BulkProviderSwitchModal.tsx` | Sequential batch, remembered batch, direction and scope, mid-turn count | Exhaustion awareness, strategy labels, arrival compaction options |
| `src/main/usage/*` | Claude OAuth usage rows (`session`, `weekly_all`, `weekly_scoped`), Codex `wham/usage` primary/secondary windows, 30 s cache, severity ≥95 = critical | An "exhausted" derivation with scope (all-models vs family) and reset time |
| `packages/codex-headless/src/proxy/CodexResponsesAdapter.ts` `classifyResponseFailed` | `context_window_exceeded`, `quota_exceeded`, `usage_not_included`, `invalid_request`, `server_overloaded`, `retryable` | `usage_limit_reached` (falls to `retryable`, codex-headless#46) |
| `packages/claude-code-headless/src/parsers/ResumePromptParser.ts` + `conditions/resumePrompt.ts` | Detects "Resume from summary / Resume full session as-is / Don't ask me again" and exposes keystroke actions | Any automatic answer; the app surfaces it as a condition for the user |
| `packages/agent-transcript-parser/testing/live-resume-probe.mts` | Real resume through headless Claude/Codex with a marker prompt; capacity strategy report | Shrunk projections; arrival compaction |
| `packages/agent-transcript-parser/testing/corpus/*` + `fixtures/evidence/*` | Redacted observed fixtures with manifest schema; extraction from `~/.claude` and `~/.codex` | Fixtures for compacted Codex rollouts of realistic size, rate-limit records, oversized Claude sessions |

Source facts the stages rely on (verified 2026-09-05 against the vendored
Claude Code snapshot, the vendored Codex at upstream `47ca4619be`, and local
transcripts):

- Codex remote compaction is used for every OpenAI/ChatGPT-authenticated
  session; local plaintext compaction is only for non-OpenAI providers. The
  `compacted` payload has `message: ""`, `replacement_history` with plaintext
  user messages plus one `compaction { encrypted_content }` item, and the
  pre-compaction records remain earlier in the same rollout. No decryption code
  exists in the client. Encrypted items are model-family-bound, not thread-bound.
- Codex persists `token_count.rate_limits` (`used_percent`, `resets_at`,
  `rate_limit_reached_type`, `limit_id`, `limit_name`) in the default rollout
  mode but does not persist `Error` events. Pre-turn auto-compaction runs from
  the last token count at 90 percent of the window; remote compaction fails
  hard when its input exceeds the window and has no local fallback.
- Claude Code does not retry a subscriber 429, persists an assistant record with
  `error: "rate_limit"` and `isApiErrorMessage: true`, uses the main model for
  compaction in the same rate-limit pool, only rejects summaries starting with
  `API Error`, auto-compacts before the first turn of an oversized resume, and
  retries `/compact` up to three times dropping oldest API-round groups. Family
  limits (Opus/Sonnet/Fable) leave other families usable; session/weekly do not.
- OpenAI's `externalAgentConfig/import` (Codex app-server, installed 0.153.4
  supports it) narrates every Claude tool call into a tagged note, truncates
  results to 4,000 characters, drops thinking and edit diffs, ignores Claude
  compaction boundaries, and has no size handling.

Census of local stores on 2026-09-05 (reality, not estimate):

| Store | Files inspected | With native compaction | With `rate_limit` record | Over 2 MB | Largest |
|---|---|---|---|---|---|
| `~/.codex/sessions` (newest 300) | 300 | 146 | n/a (not persisted) | 172 | 147 MB |
| `~/.claude/projects` (newest 266 main files) | 266 | 27 | 5 | 76 | 53 MB |

Configured targets: Claude `claude-fable-5-1[1m]` → planning budget 2,250,000
characters; Codex `gpt-6-astra` 272k at 95 percent → 581,400 characters
(≈232k tokens at the parser's 2.5 characters per token).

## D — the end state

- Bulk or single switch never delivers a prompt to the source provider unless
  the user explicitly enables "compact on source first", and that option is
  disabled while the source is exhausted.
- Codex → Claude: raw history carried, encrypted markers dropped, strategy
  labeled `raw`; if raw exceeds Claude's budget, deterministic shrink, labeled
  `shrunk`. Optional native Claude `/compact` on arrival using Claude quota.
- Claude → Codex: existing plaintext summary plus raw tail when it fits
  (`native`), otherwise deterministic shrink so the projection stays under
  Codex's auto-compact limit (`shrunk`). Codex handles later compaction itself.
- OpenCode edges follow the same ladder; no OpenCode handoff turn by default.
- A rate-limit carrier is never accepted as a compaction; a `rate_limit` record
  after `/compact` fails the opt-in path immediately; limit error records are
  never projected as assistant text.
- The bulk modal reads exhaustion structurally, defaults the direction, offers
  "switch model instead" for family-scoped limits, asks once per batch, and
  reports per-agent strategy honestly.
- `docs/design/provider-switching.md` describes the new outcomes and the opt-in
  status of source mutation.

## Stages

### Stage 0 — Evidence corpus (instrumentation, produces nothing visible)

- **Produces:** redacted observed fixtures under
  `packages/agent-transcript-parser/fixtures/evidence/observed-sequences/`:
  `codex-sequence-compacted-once`, `codex-sequence-compacted-multi` (a rollout
  with ≥3 `compacted` records), `codex-sequence-rate-limit-snapshot` (a
  `token_count` with `rate_limit_reached_type` set, if one exists locally,
  otherwise recorded during Stage 4 verification), `claude-sequence-rate-limit`
  (assistant record with `error: rate_limit`), `claude-sequence-oversized`
  (a transcript whose effective history exceeds 581,400 characters), and a
  shape census `docs/decomposition/evidence/provider-switch/census.md` giving,
  per fixture, bytes by entry kind (user, assistant text, reasoning, tool call
  input, tool result output) so the shrink ladder thresholds come from measured
  proportions rather than guesses. Also: whether any of the five local
  rate-limit transcripts has a compact boundary after the error (#820 evidence).
- **Verified by:** the existing manifest schema check
  (`fixtures/evidence/manifest.schema.json`), the corpus tests
  (`testing/corpus/observedFixtures.corpus.test.ts`), and a review that no
  path, id, or secret survives redaction.
- **Why separate:** every later test is built from these files. Writing the
  shrink ladder first would encode the shapes that happened to be in context.
- **Reality check:** local `~/.codex/sessions` and `~/.claude/projects`, read
  through the existing extractor with the existing redaction rules.

### Stage 1 — Parser hazard fixes (#820, part of parser#24)

- **Produces:** `compactionAvailability` returns `rejected` for a carrier or
  boundary whose text starts with a Claude rate-limit prefix; `describeLatestCompaction`
  exposes it; Claude decode emits `opaque` (`nativeType: "api_error"`) for
  `isApiErrorMessage: true` assistant records. Tests against Stage 0 fixtures.
- **Verified by:** unit tests on the real `claude-sequence-rate-limit` fixture
  and on a boundary+carrier pair whose carrier text is taken verbatim from that
  record (documented as synthesized-from-real in the fixture manifest).
- **Why separate:** it must land before any host change so the opt-in source
  path can never accept the hazard while the new default path is built.
- **Reality check:** real rate-limit record text; Claude Code source for the
  prefix list (`services/rateLimitMessages.ts`).

### Stage 2 — Parser shrink module and planner option (parser#24)

- **Produces:** `packages/agent-transcript-parser/src/operations/shrink.ts`
  with `stripNativeOnlyCompactions`, `clearToolResults`, `dropOldestTurns`, and
  `shrinkConversationToBudget` (the ladder, returns `{ conversation, report }`);
  `planConversationContext(..., { allowSourceTurns: false })` returning the new
  outcomes `raw-history` and `shrunk` and throwing `unfittable`; projector
  structural tests proving Claude and Codex accept cleared outputs and the drop
  marker.
- **Verified by:** tests against Stage 0 fixtures asserting exact outcome kind,
  chars before/after, what was cleared and dropped (counts and the dropped
  prompt index), and that every surviving tool call still has its input intact.
  Structural projection tests. No host involvement.
- **Why separate:** this is the hard part and the reconciliation of three
  providers' notions of "fits". It gets one consumer (the planner) and one
  report shape so the host cannot arbitrate sizes itself.
- **Reality check:** Stage 0 census proportions set the ladder thresholds; the
  live probe (Stage 7) measures real token counts of a shrunk projection.

### Stage 3 — Host transaction policy

- **Produces:** `SwitchProviderRequest.contextPolicy { allowSourceTurns, compactOnArrival }`;
  `switchProvider` never calls `compactSource` when `allowSourceTurns` is false;
  new progress phase `shrinking`; `SwitchProviderResult.strategy` and
  `shrinkSummary`; `compactBeforeSwitch` throws on `rejected` availability and
  when a `rate_limit` opaque entry appears after the `/compact` baseline line.
  `overflowPolicy` retained for compatibility and mapped: `truncate` → shrink
  ladder with drop only.
- **Verified by:** `switchProvider.test.ts` extended with fake adapters fed by
  Stage 0 conversations (decoded fixtures, not literals); `compactBeforeSwitch.test.ts`
  gains the rejected-carrier and rate-limit-after-baseline cases.
- **Why separate:** the host owns transaction order and locks; the parser must
  already be green so failures here are host failures.
- **Reality check:** decoded real fixtures; the #720 retention discipline stays
  (no `ConversationDocument` held across awaits in wait loops).

### Stage 4 — Exhaustion signal

- **Produces:** pure `src/shared/usage/exhaustion.ts` deriving per-provider
  `{ exhausted, scope: 'all-models' | 'model-family' | 'unknown', resetsAt, label }`
  from `UsageProviderSnapshot`; codex-headless `usage_limit_reached` errorType
  with `resetsAt`, `limitId`, `limitName` (codex-headless#46); renderer runtime
  field `limitHit` set from Claude `rate_limit` opaque entries and Codex
  `usage_limit_reached` api errors; exposed through the existing usage IPC.
- **Verified by:** `usageNormalize.test.ts`-style tests on real payload shapes
  (the existing tests already carry real Claude and Codex payloads) and a
  codex-headless unit test on a recorded `response.failed` body.
- **Why separate:** it is a read-only signal consumed by UI defaults and by the
  opt-in gate; it must not become a hard gate inside the transaction.
- **Reality check:** real usage payloads already in the repo's tests; a
  recorded Codex 429 body if one is captured in the proxy dumps under
  `~/.config/agent-code/proxy` (check first), otherwise the body shape from
  `codex-rs/codex-api/src/api_bridge.rs` with the fixture marked synthesized.

### Stage 5 — Arrival compaction (Claude target)

- **Produces:** IPC `session:compact-after-switch` owned by
  `src/main/providerSwitch/compactOnArrival.ts`: waits for the new session's
  ready state, answers a visible `claude.resume-prompt` with "Resume from
  summary", otherwise delivers `/compact`, then reuses the Stage 3 wait against
  the *target* session kind; emits progress on the new session id; failure is
  reported, never fatal (the pane is already live with full history).
- **Verified by:** unit tests with a fake `SessionManager` for both branches;
  a system-level recording of the resume prompt appearing on a projected
  transcript (Stage 0 has none; capture during the Stage 7 live probe run).
- **Why separate:** it runs after pane replacement and touches conditions;
  bundling it into `switchProvider` would move pane replacement before the
  transcript write, which the design forbids.
- **Reality check:** the headless resume-prompt parser's observed screen
  strings; live probe capture.

### Stage 6 — Bulk modal and switch-core guard

- **Produces:** exhaustion banner and direction default, "Compact on arrival"
  and "Compact on source first" checkboxes with the stated defaults, "Switch
  model instead" row for family-scoped limits, one batch confirmation replacing
  the per-agent native dialog on the default path, per-agent strategy in the
  batch summary and toast, and a `providerSwitchCore` guard that allows a
  session with `limitHit` newer than its last turn start even if `processActive`
  is still true.
- **Verified by:** renderer tests on the modal state machine and a recorded
  Claude "Usage limit reached · continuing automatically" screen to settle how
  `processActive` behaves under the auto-wait banner (Unknown 1).
- **Why separate:** UI policy sits on top of a transaction that is already
  proven; the guard change is the one behavior that needs a recording.
- **Reality check:** recorded screen; real usage snapshot.

### Stage 7 — Integration, design doc, probe, PR

- **Produces:** `docs/design/provider-switching.md` updated; submodule pointer
  bumps with lockfile resync; vendored Codex pointer at upstream main; live
  probe run for one Codex → Claude `raw`, one Codex → Claude `shrunk`, one
  Claude → Codex `shrunk`, report attached to the PR; OpenAI importer run on
  the same Claude fixture as an oracle for message ordering only.
- **Verified by:** `npm run typecheck`, unit/system/renderer suites, the
  package suites in their own repos, the probe report read for meaning.
- **Why separate:** merge gate.
- **Reality check:** real CLIs, real resumed sessions.

## What is being isolated

- **Shrink ladder**: `packages/agent-transcript-parser/src/operations/shrink.ts`.
  Single consumer: `operations/contextBudget.ts`. Forbidden importers: every
  projector, every decoder, every host file. It knows entry kinds and character
  budgets, never provider names.
- **Arrival compaction**: `src/main/providerSwitch/compactOnArrival.ts`. Single
  consumer: the IPC handler in `src/main/ipc/provider.ts`. Forbidden: renderer
  code, `switchProvider.ts`.
- **Exhaustion derivation**: `src/shared/usage/exhaustion.ts`. Consumers: the
  bulk modal and the usage IPC. Forbidden: `providerSwitch/*` (the transaction
  never gates on it).

## Unknowns

1. How `processActive` and `semantic.currentTurn` behave while Claude Code
   shows "Usage limit reached · continuing automatically at …". If they stay
   true, every limited Claude agent is skipped by the bulk switch today.
2. Whether a shrunk projection's real token count matches the 2.5
   characters-per-token estimate closely enough to stay under Codex's 90 percent
   auto-compact limit; measured by the probe.
3. Whether Codex semantically ignores a `custom_tool_call_output` whose output is
   a placeholder, or treats it as an error; probe with a marker prompt that asks
   for the last three tool results.
4. Whether Claude's resume dialog appears for a freshly projected transcript
   (timestamps are copied from the source; the dialog needs >100k tokens and
   >1 h since the last activity). Both branches are implemented regardless.
5. Whether the #820 hazard ever manifests on disk; Stage 0 checks the five local
   rate-limit transcripts.
6. Whether a 1M Claude target rejects arrival with "Usage credits required for
   1M context" on this account; if so the exhaustion signal must include it.
7. OpenCode import size limits for shrunk envelopes; the 128k planning window
   is conservative but unverified against `opencode import`.
8. Whether PR #810 (workspace hook isolation) lands first; if so
   `bulkProviderSwitch.ts` wiring in `hook/index.ts` must be rebased, not merged
   blindly.

## Fixture plan

- Stage 0 produces every transcript fixture through
  `packages/agent-transcript-parser/testing/corpus/extract-observed-sequences.mts`
  with the existing redaction and manifest. New cases are named above.
- Stage 4's Codex 429 body comes from a proxy dump if one exists, else from the
  upstream source shape, labeled synthesized in the manifest.
- Stage 6's Claude auto-wait screen is captured with the app's "Save debug logs"
  bundle or a session recording, stored under
  `testing/fixtures/rendering-recordings/` per the rendering discipline.
- Stage 7's probe report is attached to the PR, not committed.

## Ownership boundaries

A5/A6 own #808–811 and #813–814 (subagent discovery, remote transport, worktree
reconciliation, pane runtime isolation); #701 owns picker identity; the external
operator toolkit (#812, merged) owns `main/control` and `externalControlMcp`.
This work does not touch those directories. The only shared file is
`src/renderer/src/workspace/hook/index.ts`, where the bulk actions are wired;
changes there are limited to passing new parameters through.
