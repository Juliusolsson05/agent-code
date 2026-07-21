# Provider Switching — Design

> Status: evergreen design doc. Update this when provider-switch ownership,
> compaction policy, or native transcript semantics change.

## Purpose

Provider switching moves one live Agent Code pane from Claude to Codex, or from
Codex to Claude, while preserving enough conversation state for the target
provider to continue useful work. The target receives a new provider session
and a newly projected native transcript. The local Agent Code pane is replaced
only after every preparation step succeeds.

This is not a byte-for-byte format conversion. Claude and Codex persist
different concepts, and some provider-owned data is intentionally not portable.
The durable contract is therefore:

1. Decode the source into `ConversationDocument`.
2. Determine the effective history after the latest real compaction.
3. Ask the parser for a typed target-context plan.
4. If necessary, compact through the live source provider and wait for durable
   evidence of completion.
5. Project the effective conversation into a native target transcript.
6. Replace the pane only after the target file has been written successfully.

## Capacity outcomes

The parser owns semantic history, capacity planning, durable-compaction
classification, and provider portability rules. It does not own live processes,
timeouts, prompt delivery, or UI. Planning has four meaningful outcomes:

| Outcome | Meaning | Production action |
|---|---|---|
| Ready | Effective history fits the target | Project immediately |
| Existing compaction | A persisted source summary plus newer turns fits | Project from that summary boundary |
| Portable handoff required | Codex has a durable encrypted compaction | Ask the live compacted Codex session for plaintext; do not compact twice |
| Compaction required | No sufficient persisted summary exists | Drive native source compaction, then reassess |

Lossy suffix truncation exists as an explicit parser operation for diagnostics
and emergency tooling. It is never the production default. A normal provider
switch must fail loudly rather than silently omit earlier work.

Character estimates intentionally exclude `source.raw`, because raw provenance
duplicates semantic content and can be much larger than the prompt the target
actually constructs. Target budgets reserve room for provider-added system
instructions, tool schemas, and environment context.

## Source transcript mutation

A switch that already fits is non-destructive: Agent Code reads the source and
writes a new target transcript.

An oversized switch is different. Agent Code submits `/compact` to the live
source session. The source provider therefore appends its own native compaction
records to the source transcript. Before that irreversible command, Agent Code
shows a warning that defaults to cancellation. After acceptance, the switch
remains locked until a durable compaction record appears or the operation fails.

The pane is not replaced while this happens. If compaction, summary extraction,
projection, or target write fails, the user remains on the source provider.

## Claude compaction

Claude persists one semantic compaction across two records:

1. `system/subtype=compact_boundary`
2. a following `user/isCompactSummary=true` carrier

Current Claude versions put the generic UI text `Conversation compacted` in the
boundary's `content`. The actual detailed handoff is in the carrier's message
content. The decoder must always prefer the carrier when it exists, even when
the boundary content is non-empty. Treating the placeholder as authoritative
causes a structurally valid switch that has forgotten all substantive work.
The live poll therefore treats the boundary as incomplete and waits for the
carrier instead of accepting the first syntactically valid JSONL snapshot.

Claude's summary is plaintext and can be represented natively in another Claude
transcript or carried to Codex as ordinary history.

## Codex compaction

Current Codex rollouts persist `type=compacted` with a provider-authenticated
encrypted item in `replacement_history`. Agent Code cannot decrypt or forge
that payload, and a plaintext object shaped like a native compaction record is
not equivalent. Codex may load such a record without a syntax error but ignore
the supposed summary when constructing the next API request.

This creates two directional rules:

- **Claude → Codex:** project Claude's plaintext compact summary as a developer
  handoff message. Do not manufacture a Codex `compacted` record.
- **Codex → Claude:** if no native compaction exists, first let Codex run
  `/compact`. Then ask the compacted live Codex session, read-only and without
  tools, to write a detailed portable handoff. Persist only the authoritative
  completed-turn message—not an earlier assistant preamble—as the plaintext
  summary used to construct Claude's compact boundary and carrier.

The second Codex turn is necessary because only Codex can read its encrypted
replacement history. It is not a fallback truncation and does not ask Agent
Code to interpret ciphertext.

## Model metadata

The target transcript and capacity check must use the same target model.

For Codex, Agent Code reads the active profile (or top-level model and model
provider) from `$CODEX_HOME/config.toml`, then resolves context metadata from
`models_cache.json`. A stale hardcoded model can produce a transcript that loads
with `Model metadata ... not found`, prevents prompt submission, or applies the
wrong context budget.

If exact cache metadata is unavailable, the configured model remains the target
identity and the budget falls back conservatively. If no model identity can be
resolved at all, lookup fails before a target transcript is written.

Claude uses an explicit `ANTHROPIC_MODEL` or `settings.json` model when present.
Without an explicit `[1m]` selector, capacity planning assumes the conservative
200k window rather than treating a long-context beta as the default.

## Transaction and UI rules

- The renderer rejects switching during an active source turn.
- Renderer and main process both lock by the live Agent Code session id, so a
  repeated command cannot start a second compaction or target write.
- Main emits explicit `compacting`, `summarizing`, and `projecting` progress.
- The progress surface has no cancellation action after `/compact` is accepted.
- Provider-native prompt delivery owns composer readiness and Enter handling.
- Completion means a new durable transcript record, not merely a successful PTY
  write or an idle-looking screen.
- The target pane replacement happens last.

Closing or crashing the source provider still aborts the operation. The lock is
not permission to continue against a dead or re-owned session.

## Failure policy

The switch aborts without replacing the pane when any of these occur:

- source session kind or workspace no longer matches the request;
- target model or context profile cannot be resolved;
- provider rejects `/compact` or the portable-summary prompt;
- no new durable compaction appears before the bounded timeout;
- native compaction still exceeds the target budget;
- projected native transcript validation or write fails;
- the source process exits during orchestration.

No failure path silently invokes lossy truncation.

## Code map

- `src/main/providerSwitch/switchProvider.ts` — executes the parser's typed plan
  and owns transaction order.
- `src/main/providerSwitch/compactBeforeSwitch.ts` — live source compaction and
  Codex portable-summary orchestration.
- `src/main/providerSwitch/transcriptEngine.ts` — provider adapters, target
  model metadata, decode/project/write boundaries.
- `src/main/ipc/provider.ts` — main-process lock and progress events.
- `src/renderer/src/workspace/hook/actions/providerSwitchCore.ts` — renderer
  lock, active-turn guard, and pane replacement ordering.
- `packages/agent-transcript-parser` — neutral conversation model, compaction
  planning/portability, native projectors, and real resume probe.

## Verification

Structural tests prove legal native record shapes, but they cannot prove that a
provider includes translated history in its next model request. The opt-in live
probe in `agent-transcript-parser/testing/live-resume-probe.mts` therefore:

1. reads a real transcript or corpus directory;
2. decodes and projects it into the target provider;
3. resumes through the real headless Claude or Codex package;
4. submits a read-only diagnostic prompt;
5. requires a committed assistant response with a unique marker;
6. reports capacity strategy, projection changes, and provider diagnostics.

Large-corpus review must inspect the meaning of the response, not only the exit
code. The Claude placeholder bug and the fake Codex compaction bug both produced
syntactically valid sessions and successful model turns whose answers revealed
that the actual work context had been lost.

## Warning

Do not unify Claude and Codex compaction behind a shared wire shape. They share
the word "compaction", not persistence semantics. Never copy encrypted provider
payloads across providers, never treat Claude's boundary placeholder as its
summary, and never make truncation an implicit recovery path. Any change to
these rules requires both structural tests and a real semantic resume probe.
