# External operator toolkit continuation

Approved scope: the user requested completing the existing plan beyond #794,
prioritizing lifecycle/navigation, then batches and broader controls. On September 5
the user authorized merge after completing implementation, two independent Agent
Code orchestration reviews, resolving valid findings and passing final CI. Tracking: #795; parent design: #793.
Base: `5d6418459d8eb6aa99819eaec70e1f0610c898a7`.

## A and D

A: `src/control-sdk` owns typed registration, routing and durable execution;
`main/control/history/tasks.ts` and the SDK task launcher record long operations;
feature-owned adapters expose the first release. `providerSwitchCore.ts` already
returns outcomes, but `provider.ts` exposes focused UI actions that discard them.
The original product plan and `external-control-sdk.md` remain authoritative.

D: an external operator can complete the remaining planned lifecycle/navigation,
batch and common feature workflows using explicit IDs and observable results,
with computer use for documented UI-only decisions. Internal agents remain excluded.

## Stages

### 1. Lifecycle and navigation domain contracts

- **Produces:** exact-target domain entry points and result types for switch,
  reload, rewind/undo, resume/duplicate and placement/view actions; thin feature
  control adapters plus exact backend interrupt. No MCP imports in domain code.
- **Verified by:** existing replacement/provider/rewind tests plus focused
  behavioral checks of captured targets, changed ownership, preserved drafts,
  normal confirmations and final identity/result reporting.
- **Why separate:** wrapping toast-only/focused callbacks would bless success
  without a completed effect and silently follow a changed selection.
- **Reality check:** actual `providerSwitchCore`, `provider`, `pane`, `session`,
  Reader/Spotlight owners, native history/rewind IPC and existing test fixtures.

### 2. Native history/address discovery

- **Produces:** bounded native session and prompt catalogs using existing main
  provider readers, returning the exact provider/cwd/rewind addresses consumed by
  lifecycle actions. Do not confuse operation history with conversation history.
- **Verified by:** existing recorded provider transcripts and stale/mismatched
  addresses, pagination and cold reads without waking sessions.
- **Why separate:** invented native IDs or prompt offsets make lifecycle tools
  impossible to use reliably despite apparently valid schemas.
- **Reality check:** actual session indexes, rewind address types and provider
  capability declarations; unsupported provider discovery stays explicit.

### 3. Batch operations

- **Produces:** bounded batch read/prompt contracts with individual results,
  independent continuation cursors and stable per-target child request keys.
- **Verified by:** mixed successes/failures across actual SDK registrations;
  retrying a partially completed batch does not repeat a delivered child prompt.
- **Why separate:** whole-batch success/idempotency cannot express partial delivery.
- **Reality check:** first-release single-agent contracts and durable executor;
  concrete external-operation feedback determines additional cases.

### 4. Broader feature controls

- **Produces:** feature-owned template, ordinary settings, usage/worktree, named
  surface and workflow adapters, with live documentation updates.
- **Verified by:** existing domain owners and their UI semantics; external workflow
  ownership must be established before exposing run, and each slice has its own
  independently verified result contract.
- **Why separate:** workflow identity and settings side effects are not generic
  store edits; each owner must settle its actual semantics first.
- **Reality check:** feature registries/services and existing workflows/templates;
  no fabricated cross-provider reconciliation fixtures.

### 5. Integration and review

- **Produces:** verified packaged/external lifecycle evidence, updated capability
  coverage and a complete unmerged PR linked to #795 and relevant feedback issues.
- **Verified by:** standalone SDK/full app types, meaningful feature checks,
  system/renderer tests and production build; external trial where an isolated
  app/state is available. Report unavailable real-world evidence honestly.
- **Why separate:** unit/schema checks cannot prove installed client or window
  behavior. A useful release is not a tool-count target.
- **Reality check:** compiled app, actual clients and feedback linked to #793.

## Isolation

Domain operations remain owned by workspace/features/main services. Their public
results feed control adapters; adapters may not import MCP. The SDK remains
platform-neutral. Native history reconciliation has one main-owned port; batches
consume existing SDK calls under the original caller identity, never upgrade an
external caller to application privileges. Workflow ownership is isolated inside
the workflow service boundary, not inferred in the transport.

## Unknowns and evidence plan

- Per-provider resume/duplicate/export coverage, including open #773 for OpenCode
  picker support; do not imply that an MCP wrapper repairs unsupported discovery.
- Lifecycle outcomes after compaction, lost placement, or a user editing during
  an asynchronous operation; preserve real domain guards and report uncertainty.
- View/placement semantics for detached, buried, mirrored and related sessions.
- Batch size/output bounds and partial retries after a renderer/client restart.
- External workflow ownership; no invented parent Agent Code session.
- Which ordinary settings are safe to change through existing apply handlers.
- Real external trial access and runtime installation; preserve the user's live
  workspace and unrelated local lockfile edits.

Use existing recorded transcripts/layout fixtures where shape reconciliation is
involved. Ordinary contract/fault-injection tests need no general recording harness,
as explicitly agreed. Check #793 cross-references at stage boundaries and update
this plan/issue for concrete findings. All work stays unmerged pending confirmation.

## Checkpoints

- Planning: source owners inspected; no new feedback linked to #793 at start.

- Feedback checkpoint: #796–#801 arrived during implementation. This stage now
  includes canonical visible labels/displayed titles, explicit effective tiled
  focus, app/process attachment identity, application activation before window
  focus, native-draft uncertainty and the multi-lane navigation recipe. The
  activation root cause is a supported hypothesis until the two-monitor trial
  verifies it; no focus acknowledgment is bypassed. #800's real committed-prompt
  trial remains external evidence, not a fabricated passing fixture.
- Lifecycle adapters and native prompt catalogs are implemented. Initial existing
  checks: 11 files/33 tests passed; new lifecycle/placement/focus checks: 3 files/8
  tests passed. Recorded label/focus transitions and native catalog checks are
  being verified before the batch stage.
- Stage 1/2 code checkpoint: full TypeScript including the standalone neutral SDK
  passed. The combined lifecycle/navigation/catalog/feedback/import-boundary run
  passed 11 files/25 tests, including recorded native prompts and Dispatch
  coordinates. OS two-monitor activation and occupied native-draft trials remain
  external verification; do not label those reproduced/fixed on unit evidence.
- Stage 3 verified: bounded multi-window batch read/prompt adapters reuse the
  executor with the original caller. Real file-journal checks prove per-child
  accepted/unknown receipts, no redelivery after an executor restart/subset retry,
  and argument conflicts. Full typecheck passed. The batch is deliberately not
  atomic; independent read cursors and child call IDs remain visible.

- September 5 operator gap report reviewed alongside #796–806. Creation's default
  selects the captured focused lane; `selectCreated:false` preserves current tab
  and all lane assignments, followed by explicit `dispatch.configure/lane-select`.
  The shared index explains its target lane in UI help (#799).
- #802–803 are subagent projection correctness/discovery performance dependencies,
  not missing operator operations. #804–805 are separate Remote transport/store
  work. A5 owns #806: this branch only calls the existing worktree dump owner and
  does not change its reconciler, canonicalizer or projection caches.
- #807 records an existing replacement draft-loss bug demonstrated by a failing
  real-hook regression: edits during spawn were replaced by the old snapshot and
  supported attachments were dropped. Draft transfer is centralized at retirement;
  provider switch must not reapply a stale branch-specific image snapshot.
- Stage 4 implements templates, registry-backed ordinary settings, named surfaces,
  usage/worktree reads and external workflow runs. External workflow ownership is
  isolated in `main/workflows/externalOperator`, with only `workflows/control.ts`
  allowed to import it. Main-owned durable tasks admit before workflow approval;
  they cannot be finalized by a window caller. Existing source approval remains.
- Remaining evidence/coverage: two-monitor activation; occupied native draft and
  busy-provider admission/commit trials; full cross-provider historical topic
  search (#96/#739 and unsupported OpenCode discovery #773). Recent native session
  catalogs/prompt pages are not a full archive search. Batch acceptance does not
  imply worker completion or provide a durable wait/subscription API.

- Stage 4/5 verification: standalone SDK/full types passed; renderer suite passed
  118 files/509 tests. Full unit run passed every assertion except the unchanged
  local image-fixture provenance check referencing a missing private transcript.
  That check is retained. The real workflow-worker check is classified as system.
  The isolated Electron/HTTP MCP trial passed with two windows, reload/stale-owner
  rejection, actual process identity, a right-window preference mutation and stale
  preference refusal. Production build/output verification passed (release-only
  runtime archives were not downloaded). No live provider or user workspace was
  modified by these trials. Actual #797/#800 trial evidence remains outstanding.

- Review handoff: continuation PR #812. Related independent work now has PRs:
  #808 owns #806 worktree optimization; #809 fixes #802 child-reader overlap;
  #811 builds #803 discovery bounds on #809. This branch does not absorb their
  implementations. #810's separate pane-runtime isolation should be checked for
  ordinary shared-file conflicts at merge time. CI status belongs to #812; no
  merge is authorized by opening or updating it.


## Final extension reconciliation (authorized September 5)

PR #812 is already a feature implementation PR with its plan first, followed by
implementation. Preserve its feature branch and commit history; no rewrite or
plan-only replacement is needed. Existing conversations and lane assignments must
remain unchanged during this work and reviewer creation.

### 6. Close direct-control coverage gaps before review

- **Produces:** `nativeHistory.search` over the existing prompt-index owner;
  bounded, cancellable agent/operation observation waits; explicit agent display
  and auto-follow preferences; supported image-path prompting and structured
  delivery failure details; consistent preserve-selection lifecycle creation.
  Update the running crash course and operator skill with these exact contracts.
- **Verified by:** existing recorded transcript/index evidence, independent wait
  cancellation/timeout/cursor/lifetime cases, real feature-owner view/draft tests,
  provider refusal before any write, and isolated external MCP controls.
- **Why separate:** a recent-session list is not topic search; a transport receipt
  is not a committed message; an active process is not completed work. Establish
  those distinctions before asking reviewers to evaluate the finished feature.
- **Reality check:** `sessionIndex.searchSessionPrompts` (400 recent candidates
  per provider), `agents.read` status projection, durable `operations.read`,
  `PromptDeliveryResult`, provider `composer-occupied` readiness, workspace view
  override and tail owners. Reuse these, not a new provider queue or archive index.

| Agreed behavior | Delivered contract / final action |
|---|---|
| Historical topic lookup and exact rewind | Add prompt-index search with native IDs/cwd/snippets; exact addresses still come from nativeHistory.prompts. Search coverage is bounded and OpenCode indexing remains an explicit upstream limitation. |
| Wait for attention/progress/operation completion | Add cancellable bounded status waits with scoped expiring cursors. Status changes/idle are evidence, not proof a user task succeeded; output detail remains agents.read. |
| Prompt attachments and failures | Add Claude-supported prepared image paths, reject unsupported providers before wake/write, retain failure stage/retry disposition/written flags as structured error details. Do not bypass busy-provider admission. |
| Native composer knowledge | Expose provider-reported occupied state when that contract exists; otherwise unknown. Never infer complete text or emptiness from xterm/ready. |
| View and follow controls | Reuse configured/effective display-mode and own/global tail semantics with explicit desired values. |
| Creation and continuation placement | Preserve default UI semantics, offer selectCreated:false for create/resume/duplicate; orchestration children already preserve lanes. |
| Broad feature controls, history, setup, docs | Already implemented; validate live registration/HTTP and maintain docs. Visual editing, authentication, unusual provider dialogs and destructive worktree workflows retain their agreed UI routes. |

A5/A6 own #808–811 and #813–814; do not absorb their canonicalization, rendering,
subagent discovery or Remote fixes. #701 owns broader picker display identity.
#797's real two-monitor trial and #800's real occupied/busy native trials cannot
be claimed from isolated tests; retain honest evidence boundaries.

### 7. Light Orch Review and authorized merge

- **Produces:** two independent Agent Code orchestration reviewer results for the
  completed #812 feature, recorded finding dispositions, final CI and merge SHA.
- **Verified by:** read each review in full, fix valid findings, re-review changed
  behavior, confirm required checks pass on the exact reviewed revision, then merge.
- **Why separate:** implementation completion must precede review; a plan-only PR
  or stale review cannot satisfy the user's review-and-merge instruction.
- **Reality check:** actual orchestrated child IDs/results, current PR diff and
  GitHub checks. Reviewers get full task context and may not edit, merge, prompt
  existing agents or change the user's pane layout.
