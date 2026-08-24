# Codex Fresh Rollout Ownership Recovery

> **Status:** Implemented after explicit approval on 2026-08-24. The five
> stages were completed in order; the package implementation is codex-headless
> PR #41 and this Agent Code branch pins it and records its diagnostics.
>
> **Incident:** Agent Code issue #632.
>
> **Observed boundary:** the local rollout corpus contains
> `event_msg.user_message` on Codex `0.145.0` and does not contain it on
> `0.147.0` or `0.149.0`. There is no local `0.146.x` capture, so the evidence
> establishes `(0.145.0, 0.147.0]`, not an imagined exact release.

## 1. A and D

### A — what exists and is trusted

| Artifact | Location | What is trusted |
|---|---|---|
| Codex's durable rollout | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | Codex created and continuously appended the file for the active provider thread. It is the committed transcript source. |
| Prompt-delivery lifecycle | active incident/session recording, `submit.start` through `submit.result` | Four observed submits returned `ok: true` in 12–20 ms. This proves the Agent Code write path accepted the prompt; it does not by itself prove model processing. |
| Independent processing evidence | recorded terminal snapshots and semantic proxy events | The active capture contains `turn_started`, response deltas, tool calls, and completion after the submitted prompts. Together with the rollout, this proves Codex processed them. |
| Failed committed channel | session recording `17ee1e36-12ff-4d08-8470-f52de6b5f100` | Thousands of screen/semantic events and zero `session:jsonl-entries`. A second fresh `0.149.0` capture has the same shape. |
| Local prompt identity | `CodexHeadless.submittedPrompts` in `packages/codex-headless/src/CodexHeadless.ts` | A prompt observed at this particular PTY is admissible ownership evidence. CWD and file recency are not ownership evidence. |
| Cross-wire safety invariant | `decideFreshRolloutClaim` in `packages/codex-headless/src/transcript/FreshRolloutClaim.ts` | Multiple agents can start concurrently in the same CWD. Ambiguity must fail closed instead of assigning a sibling's transcript. |
| Existing recording substrate | `~/.config/agent-code/session-recordings`, `feed-debug`, and incident runs | The system already records delivery, screen, semantic, and committed channels. It does not yet record why a fresh rollout candidate was held or accepted. |

The current parser's **single-first-user-message representation is not
trusted**. It is the failed substrate. Its fallback chooses injected startup
context on the recorded `0.147.0` and `0.149.0` shapes.

### D — observable end state

1. A fresh top-level Codex session attaches its own rollout when the recorded
   rollout contains injected role-user bootstrap items before the actual prompt
   and contains no `event_msg.user_message`.
2. The committed channel emits `session:jsonl-entries`, transcript status leaves
   `disconnected`, and a prompt Codex processed no longer remains in QueueStrip.
3. Two concurrent fresh agents in the same CWD cannot claim one another's
   rollout, including when they submit identical normalized prompt text.
4. Resume/fork/subagent attachment continues to use its existing exact-id or
   lineage proof and does not regress.
5. Every fresh candidate decision is inspectable in a debug bundle without
   recording raw prompt or injected-instruction text in new diagnostics.

## 2. Root cause established before implementation

`parseFreshRolloutCandidate` currently stores only one
`normalizedFirstUserMessage`. It prefers the first
`event_msg.user_message`; when that event is absent it takes the first role-user
`response_item`. `decideFreshRolloutClaim` compares only that value with prompts
recorded from this PTY.

In the active Codex `0.149.0` rollout, the first role-user item contains injected
`AGENTS.md` instructions and the submitted prompt is a later role-user item. In
the captured `0.147.0` rollout, injected environment context comes first. Neither
version emits `event_msg.user_message`. The candidate therefore remains in the
`same-cwd candidates exist but none match` hold state forever. Because only an
accepted candidate calls `tailFile`, `CodexSession` has no `rollout-entry` to
forward as `jsonl-entry`, even while the terminal and proxy show a live turn.

The existing `RolloutOwnership.test.ts` helper manufactures an
`event_msg.user_message` fixture. That test validates an obsolete assumed wire
shape and cannot be used as evidence that current rollout ownership works.

## 3. Intermediate stages

### Stage 0 — record ownership decisions without changing them

- [x] **Produces:** a versioned, content-safe `rollout-ownership-decision`
  diagnostic record for every candidate evaluation. It records candidate file
  identity, Codex version when available, CWD-match result, counts and stable
  hashes of candidate/local normalized user texts, decision, reason, ambiguity
  cardinality, and whether tailing began. It records no new raw prompt text.
- **Verified by:** reproduce the current `0.149.0` incident and independently
  show a same-CWD candidate held because the chosen bootstrap item does not
  match, while the matching later role-user item is visible by hash/index. The
  session's attachment behavior must remain unchanged in this stage.
- **Why separate:** changing the claimant before the missing decision is
  observable would make a false attachment look like a successful fix. The
  recorder is also the only way to measure ambiguity frequency during real
  concurrent use.
- **Reality check:** the active session recording proves all surrounding
  channels are captured but contains no event explaining the claimant's hold.
  The fields above close that exact evidence gap.

### Stage 1 — build a recorded rollout-shape corpus and catalog

- [x] **Produces:** a deterministic sanitizer/extractor, committed sanitized
  fixtures, and a catalog with source CLI version, fresh/resume/subagent class,
  ordered user-entry shapes, ownership-decision result, source-recording ID,
  original SHA-256, and transformation version. Minimum source cases:
  `0.145.0` with `event_msg.user_message`; `0.147.0` with environment context
  first; two failed fresh `0.149.0` sessions with distinct injected context;
  one working resumed/subagent `0.149.0` session; and newly recorded concurrent
  same-CWD fresh sessions.
- **Verified by:** run the production parser over both each private source and
  its sanitized fixture and compare a structural signature: line types/order,
  user-item indices/counts, normalized equality relationships, CWD relation,
  thread metadata, and decision. The catalog must report frequencies, not only
  named examples.
- **Why separate:** a hand-written JSON literal would encode the same mistaken
  assumption as the current green test. Sanitization is separate from tests so
  privacy edits cannot silently alter the ownership-relevant structure.
- **Reality check:** the source corpus already shows the important shape change
  between `0.145.0` and `0.147.0`, and both failed fresh `0.149.0` recordings
  contain zero Agent Code rollout entries while their Codex rollout files grow.

### Stage 2 — state and approve ownership semantics as failing fixture tests

- [x] **Produces:** fixture-driven tests, written before the claimant change,
  that fail for the two recorded fresh `0.149.0` cases and stay green for legacy,
  resume, and cross-wire cases. An explicit outcome table in the fixture catalog
  records `accept`, `hold`, or `ambiguous` and the evidence that justifies it.
- **Verified by:** demonstrate the intended red tests against the unchanged
  claimant; review every expected ownership outcome against the source session
  rather than deriving expectations from the proposed code.
- **Why separate:** tests and implementation written from the same proposed
  algorithm would only prove self-consistency. This stage forces the ownership
  semantics—especially identical-prompt ambiguity—to be agreed before code can
  bless them.
- **Reality check:** the current imagined helper emits
  `event_msg.user_message`, while all captured `0.147.0` and `0.149.0` fresh
  failures omit it. The recorded fixtures replace that false confidence.

### Stage 3 — replace the single-message claimant inside the isolated layer

- [x] **Produces:** a claimant that represents all ownership-relevant user
  observations from the bounded candidate prefix and applies the Stage 2
  evidence table. It must retain exact local-prompt proof, same-CWD filtering,
  and fail-closed ambiguity; it must not classify bootstrap text by English
  prefixes such as `# AGENTS.md` or `<environment_context>`.
- **Verified by:** all Stage 2 fixture tests pass; mutation checks prove that
  removing the later matching item, changing its normalized text, or adding a
  second matching candidate restores `hold`/`ambiguous`. Legacy synthesized
  unit cases may supplement but may not replace the recorded corpus.
- **Why separate:** parsing/claiming is the genuinely hard ownership problem.
  QueueStrip, transcript rendering, and semantic proxy consumers should receive
  one clean attachment decision and must not arbitrate among rollout candidates.
- **Reality check:** both real failure variants differ in bootstrap text but
  share the same invariant: the actual locally submitted prompt is a later
  durable role-user item. Structural matching covers the observations without
  hard-coding either captured string.

### Stage 4 — integrate the package and verify the complete channel handoff

- [x] **Produces:** a pinned `codex-headless` revision in Agent Code, decision
  diagnostics included in debug/session recordings, and an end-to-end capture
  showing delivery → ownership acceptance → rollout tail → committed renderer
  entries → queue reconciliation for a fresh Codex session.
- **Verified by:** replay the recorded corpus in package tests, run Agent Code's
  contract/type/build suites, and record live fresh, resumed, and two-concurrent-
  same-CWD scenarios. Verification must assert provider thread IDs and rollout
  file paths, not merely that the UI looks connected.
- **Why separate:** a correct pure claimant can still fail if the file watcher
  does not re-read a growing candidate, the submodule pin is stale, or the
  renderer never receives the committed entries. Integration verifies those
  boundaries without moving ownership logic into them.
- **Reality check:** the current active incident already exercises this entire
  chain and shows its precise break: delivery/processing are present, candidate
  attachment and all downstream committed events are absent.

## 4. Isolation boundary

The hard part is **fresh rollout ownership**, not rendering and not prompt
delivery. It remains in the `codex-headless` transcript layer, with a dedicated
module/directory if Stage 3 grows beyond the current single file. Its only
runtime consumer is `CodexHeadless`, which receives one decision and alone may
start `tailFile`.

The following are forbidden from importing claimant internals or independently
choosing a rollout:

- Agent Code renderer, QueueStrip, and transcript reducers;
- `src/providers/codex/runtime/codexSession.ts`;
- prompt-delivery/readiness code;
- semantic proxy and screen-fallback channels;
- resume/fork ownership code, except through shared inert types or normalization
  helpers whose semantics are explicitly tested.

Agent Code may forward content-safe decision diagnostics and consume the final
committed stream. It may not implement a second ownership policy to compensate
for the package.

## 5. Unknowns that must not be patched around

1. No `0.146.x` rollout is present, so the exact first upstream release that
   removed `event_msg.user_message` remains unknown.
2. The full population and frequency of injected role-user bootstrap shapes is
   not cataloged. Two observed forms are not an exhaustive grammar.
3. The frequency and correct product behavior for concurrent same-CWD sessions
   submitting identical normalized prompt text needs explicit human judgment.
   The default remains fail closed until that decision is approved.
4. The candidate reader is capped at 4 MiB. We have not measured whether large
   startup instructions can push the first real prompt beyond that prefix.
5. We have not yet proved that every relevant `change` event causes a candidate
   re-read on all supported filesystems, or whether a held partial file can
   remain stale in the candidate map.
6. We have one working `0.149.0` resume/subagent capture, but have not cataloged
   all resume/fork shapes under the new upstream format.
7. It is not yet measured whether normalization can collapse two distinct real
   prompts often enough to create practical ambiguity.
8. The exact renderer transition from disconnected to ready and the queue row
   consumed by the first committed user item must be asserted in Stage 4 rather
   than inferred from package tests.

## 6. Fixture plan

Stage 0 produces the missing claim-decision observations. Stage 1 consumes the
existing private rollout/session recordings plus new controlled concurrency
recordings and emits sanitized, traceable fixtures. Sanitization replaces text
atoms consistently while preserving entry order, entry type, role, equality
relationships, wrappers, and relative size class; the catalog retains source
hashes and transformation version so a future worker can revalidate locally.

Stage 2 is the first stage that turns those recordings into test expectations.
No implementation may create a fixture, and no failing recorded case may be
deleted or weakened to make Stage 3 green. If a recorded case contradicts this
decomposition, revise this document and return to the approval gate instead of
adding a conditional.

## 7. Implementation and verification record

- **Stage 0:** `CodexHeadless` emits a content-safe ownership decision with a
  per-process HMAC fingerprint. The active `0.149.0` capture independently
  showed eight ordered observations, a non-matching legacy selection, and the
  later local match without changing the old `hold` behavior.
- **Stage 1:** seven sanitized fixtures were extracted from real rollouts. The
  corpus includes legacy `0.145.0`, first-event-free `0.147.0`, two failed fresh
  `0.149.0` Agent Code recordings, two controlled concurrent same-CWD `0.149.1`
  siblings, and one working exact-id `0.149.0` subagent. The extractor verifies
  private source hashes, pinned live-file boundaries, ordering/equality
  signatures, and absence of raw paths/user text.
- **Stage 2:** fixture tests were run before the claimant change. Six assertions
  failed red as expected: five modern candidates and the concurrent attribution
  case returned `hold` where the reviewed target table required `accept`.
- **Stage 3:** the claimant now compares the local PTY prompt ledger with every
  durable user observation. It never recognizes bootstrap strings by content,
  collapses duplicate event/response representations within one file, and
  remains ambiguous across two matching files. Recorded removal/change/collision
  mutations verify the fail-closed boundary.
- **Stage 4:** Agent Code forwards ownership decisions onto a diagnostic-only
  recording channel. A live fresh `CodexSession` smoke against real CLI
  `0.149.1` produced three incomplete-file holds, then `accept:true`, followed
  by 12 committed entries including the submitted prompt. The package's 29
  tests, typecheck, build, contract, artifact verification, and upstream drift
  check pass; accepted/latest are both `0.149.1`. Once that committed user row
  arrives, Agent Code's existing provider-neutral ingestion path removes the
  matching Codex `queuedMessages` item; no queue-specific fallback was added to
  conceal a missing transcript.
- **Agent Code integration:** the recorder suite passes 11/11 in isolation,
  TypeScript, test-contract, keybinding, production build, and `git diff
  --check` pass. The full local suite passed 1,828/1,830. One failure is the
  repository's unchanged missing private image corpus source. The other was a
  transient recorder-directory append failure under full-suite parallelism;
  the complete recorder suite passed immediately before and after that run, so
  the diagnostic assertion was not weakened to hide it.

The exact `0.146.x` change point and the 4 MiB prefix-risk frequency remain
documented unknowns. Neither is papered over: the former does not affect the
structural matcher, and the latter still fails closed rather than attaching by
recency.
