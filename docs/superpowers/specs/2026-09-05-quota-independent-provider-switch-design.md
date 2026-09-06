# Quota-independent provider switch — Design

**Date:** 2026-09-05
**Branch:** `feat/quota-independent-provider-switch`
**Issue:** [#821](https://github.com/Juliusolsson05/agent-code/issues/821) (feature),
[#820](https://github.com/Juliusolsson05/agent-code/issues/820) (hazard),
[agent-transcript-parser#24](https://github.com/Juliusolsson05/agent-transcript-parser/issues/24),
[codex-headless#46](https://github.com/Juliusolsson05/codex-headless/issues/46)
**Status:** Approved direction from the 2026-09-05 discussion; spec awaiting review.
**Decomposition:** `docs/decomposition/quota-independent-provider-switch.md`

## Problem

The bulk provider switch exists for the moment a subscription window is
exhausted. Today the transaction still asks the source provider for a live turn
in the common cases: every Codex session that has ever compacted (146 of the
last 300 local rollouts), any Claude session over Codex's budget (frequent with
a 1M Claude model), and any oversized OpenCode session. When the source is at
its limit those turns fail, and the switch waits 300 seconds per agent, shows a
native dialog per agent, and moves nothing.

Two constraints from the user shape the fix: no speculative pre-summarization
that spends source tokens on a guess, and no custom summarization prompt as the
product path.

## What the evidence allows

- Codex keeps all pre-compaction records on disk. The encrypted summary is the
  only opaque part, and Codex itself never decrypts it locally; OpenAI's server
  does. So the summary is unreadable everywhere, and unnecessary: the history
  it summarizes is present in plaintext.
- Claude's compaction summary is a plaintext carrier and already portable.
- Both targets digest overflow natively with their own quota: Codex pre-turn
  auto-compaction from the seeded token count (must stay under the window),
  Claude pre-turn auto-compaction and the "Resume from summary" dialog.
- Deterministic shrinking without a model is what both vendors ship: Anthropic's
  `clear_tool_uses` context editing, and OpenAI's `externalAgentConfig/import`,
  which narrates Claude tool calls into notes and truncates results to 4,000
  characters. The OpenAI importer is Claude → Codex only, ignores compaction
  boundaries, drops edit diffs and thinking, and has no size handling. It is an
  oracle for our projector, not a replacement.
- Exhaustion is observable structurally: the usage endpoints the app already
  polls, Codex `token_count.rate_limits` in every rollout, Claude `rate_limit`
  transcript records, and the Codex 429 body on the proxy stream.

## Design principles

1. The source provider is never required. Every default path is
   read-transcript → plan → deterministic shrink if needed → project → write →
   replace pane.
2. Overflow is handled deterministically before projection, so a target never
   receives input above its window. The target's own native compaction is the
   only summarizer, and only after arrival, using the target's quota.
3. Every lossy step is explicit, reported, and visible to the user as a
   strategy label. No silent truncation.
4. The existing source-side compaction path is preserved as an opt-in for the
   case where the source is alive and the user prefers a native summary over a
   larger raw history.

## Parser (`agent-transcript-parser`)

### Planner outcomes

`planConversationContext(conversation, targetProvider, budgetCharacters, options?)`
gains `options.allowSourceTurns` (default `true`, preserving every current
outcome). With `allowSourceTurns: false` the outcomes are:

| Outcome | Condition | Conversation returned |
|---|---|---|
| `ready` | no compaction, fits | unchanged |
| `existing-compaction` | latest compaction is portable, tail fits | from that boundary |
| `raw-history` | latest compaction is native-only, raw entries minus native-only compaction entries fit | stripped |
| `shrunk` | anything else that can be made to fit | shrunk, with `report` |
| throws `ConversationUnfittableError` | the last complete user turn alone exceeds the budget | n/a |

`raw-history` and `shrunk` carry `estimatedCharacters`, `budgetCharacters`, and
for `shrunk` a `ShrinkReport`.

### Shrink ladder (`operations/shrink.ts`)

Pure, provider-neutral, one consumer (the planner). Steps, applied in order and
only as far as needed:

1. **Strip native-only compactions.** Remove `compaction` entries whose
   availability is `native-only`. Portable and synthetic compaction entries
   stay; they are real content. Report: `strippedCompactions`.
2. **Clear tool results, oldest first.** Replace `tool-result.output` with a
   bounded placeholder text
   `[tool output cleared during provider switch: N characters]`, keeping the
   entry, its `callId`, and `isError`. Walk from the oldest entry forward, never
   clearing results inside the most recent `keepRecentTurns` user turns
   (default 3). Tool-call inputs are preserved in full; edit diffs live there.
   Stop as soon as the estimate fits. Report: `clearedResults`, `clearedChars`.
3. **Trim long inputs.** If still over budget, truncate tool-call inputs longer
   than `maxInputChars` (default 8,000) with a marker, oldest first, same
   recent-turn protection. Report: `trimmedInputs`.
4. **Drop oldest complete turns.** Reuse the `fitConversationToCharacterBudget`
   boundary rules, but the synthetic compaction marker now lists the dropped
   user prompts (first 200 characters each, up to 40) so the target knows what
   was asked earlier. Any plaintext compaction summary among the dropped
   entries is prepended, as today. Report: `droppedEntries`, `droppedTurns`,
   `promptIndexChars`.
5. If a single final turn still exceeds the budget, throw `ConversationUnfittableError`
   with the report so far. Never emit a fragment.

Thresholds are set from the Stage 0 census, not from these defaults; the
defaults above are placeholders the census replaces in the same PR.

### Hazard fixes

- `compactionAvailability` returns `rejected` when the carrier or boundary text
  starts with one of Claude's rate-limit prefixes (`You've hit your`,
  `You've used`, `You're now using extra usage`, `You're close to`,
  `You're out of extra usage`). `conversationAfterLatestPortableCompaction`
  treats `rejected` like `incomplete`.
- Claude decode maps assistant records with `isApiErrorMessage: true` to
  `opaque` entries with `nativeType: "api_error"` and keeps the raw record.
  Projectors already drop opaque entries.

### Projection

No projector rule changes. Cleared results are ordinary `tool-result` entries
with short output; the drop marker is a synthetic `compaction` entry, which
Claude projects as boundary + carrier and Codex as a developer handoff. Both
paths exist today. Structural tests prove acceptance; the live probe proves
semantic acceptance.

## Host (`agent-code` main process)

### Transaction

`SwitchProviderRequest.contextPolicy?: { allowSourceTurns: boolean; compactOnArrival: boolean }`
with defaults `{ allowSourceTurns: false, compactOnArrival: <see UI> }`.

- `allowSourceTurns: false`: plan with the parser option; never call
  `runtime.compactSource`; emit progress `shrinking` with the report summary
  when the outcome is `shrunk`; result carries `strategy: 'native' | 'raw' | 'shrunk'`
  (`native` covers `ready` and `existing-compaction`) and a one-line
  `shrinkSummary` for toasts.
- `allowSourceTurns: true`: the current path, unchanged, except that
  `compactBeforeSwitch` fails immediately when the latest compaction's
  availability is `rejected` or when an `api_error` opaque entry appears after
  the `/compact` baseline line. The per-agent native confirmation stays on this
  path only.
- `overflowPolicy` is kept for compatibility: `truncate` maps to the shrink
  ladder restricted to step 4; `fail` is unchanged.

The #720 retention discipline holds: wait loops keep scalars, not documents.

### Arrival compaction (`compactOnArrival.ts`)

New IPC `session:compact-after-switch({ sessionId })`, called by the renderer
after `replaceSession` returns, only when the target is Claude and the policy
asked for it:

1. Wait for the new session's prompt-ready state through the provider's
   delivery readiness.
2. If a `claude.resume-prompt` condition is visible, resolve it with the
   "Resume from summary" action; Claude then runs its own compaction.
3. Otherwise deliver `/compact` through `deliverPromptToAgent`.
4. Reuse the compaction wait against the target session and kind; emit
   `compacting` progress on the new session id.
5. On timeout or provider error, report a non-fatal toast. The pane is already
   live with its full history; the user can compact later.

Codex and OpenCode targets skip this step; Codex auto-compacts at its own
threshold and the projection is written below it.

### Exhaustion signal

`src/shared/usage/exhaustion.ts`: pure derivation from `UsageProviderSnapshot`
to `{ exhausted: boolean; scope: 'all-models' | 'model-family' | 'unknown'; resetsAt: string | null; label: string }`.
Claude: `session` and `weekly_all` rows are all-models; `weekly_scoped` rows are
model-family. Codex: the main `rate_limit` windows are all-models; entries
under `additional_rate_limits` are model-family. `exhausted` is `percent >= 100`
on an active row. The usage IPC returns it alongside the snapshot.

Live signals: the renderer runtime gains `limitHit: { at: number; source: 'transcript' | 'api_error' } | null`,
set when a Claude `api_error` opaque entry with rate-limit text arrives or a
Codex `usage_limit_reached` api error arrives (codex-headless#46 adds the
errorType with `resetsAt`, `limitId`, `limitName`). Cleared on the next
completed turn.

## Renderer

### Bulk modal

- Banner per provider from the exhaustion signal: "Codex: 5-hour window at
  100 percent, resets 14:32" and the direction defaults to that source.
- "Compact on arrival with Claude" checkbox, shown for Claude targets, default
  on when the batch's largest source estimate exceeds 150,000 characters.
- "Compact on source first (uses source quota)" checkbox, default off, disabled
  with a reason when the source is exhausted.
- "Switch model instead" row when the hit limit is model-family scoped: runs
  `/model <other family>` on the selected agents rather than a provider switch.
  Claude only; Codex's backend-driven model switch is left to Codex.
- One confirmation per batch. The per-agent native dialog only appears on the
  opt-in source path.
- Summary and toast report strategy counts: "Switched 17 agents to Claude: 9
  native, 6 raw, 2 shrunk (1 failed)". Pane toast per agent shows its strategy.

### Switch core guard

`switchAgentProvider` currently refuses while `processActive || semantic.currentTurn`.
It additionally allows a session whose `limitHit.at` is newer than its last turn
start. Replacement kills the process, which is what ends a provider's wait
banner. Whether the banner keeps `processActive` true is Unknown 1 in the
decomposition and is settled by a recording before this guard ships.

## Failure policy

The switch aborts without replacing the pane when: the source transcript cannot
be decoded; the target model or profile cannot be resolved; the shrink ladder
cannot fit the last complete turn; projection validation or the target write
fails; the source process exits during the transaction. Arrival compaction
failure is not an abort. The opt-in source path keeps its existing failure
list plus the two hazard checks.

## Testing

- Parser: unit tests against redacted real fixtures produced in Stage 0;
  structural projection tests for cleared outputs and the drop marker; the live
  probe extended with shrunk projections and the marker prompt. No invented
  transcript literals.
- Host: `switchProvider.test.ts` and `compactBeforeSwitch.test.ts` extended
  with decoded real fixtures; `compactOnArrival.test.ts` with a fake session
  manager; `exhaustion.test.ts` on the real usage payloads already in the
  suite.
- codex-headless: unit test on a recorded or source-derived 429 body.
- Renderer: modal state tests; the auto-wait screen recording for the guard.
- Merge gate: `npm run typecheck`, unit, system, renderer, package suites in
  their repos, probe report attached to the PR.

## Coordination

A5/A6 own #808–811 and #813–814; #701 owns picker identity; the operator
toolkit (#812) owns `main/control` and `externalControlMcp`. This work stays
in `providerSwitch/`, `ipc/provider.ts`, the bulk modal and its action, the
usage service, and the two packages. `workspace/hook/index.ts` is touched only
to pass parameters. The vendored Codex pointer moves to upstream main in this
branch as a `chore(vendor)` commit because the design cites its current source.

## Out of scope

- Speculative pre-summarization of any kind.
- Custom summarization prompts as a product path. The existing portable-handoff
  prompt survives only inside the opt-in source path.
- Using the OpenAI importer as the Claude → Codex product path.
- Moving transcript decoding off the main thread (#764).
- Persisting the remembered batch across restarts.

## Open constraints

1. The `processActive` behavior under Claude's auto-wait banner decides whether
   the guard change is needed at all; it needs a recording, not reasoning.
2. Character-per-token accuracy for shrunk Codex projections is unverified until
   the probe runs; if the estimate is off, the reserve fraction, not the ladder,
   is the knob.
3. The 1M Claude target may itself require usage credits on this account. If
   arrival returns "Usage credits required for 1M context", the exhaustion
   signal must cover the target too; the switch itself still succeeds.
4. Stage 0 may find that the #820 hazard never lands on disk. The parser
   rejection and the fast-fail stay regardless; the issue is then closed as
   defended rather than reproduced.
