# External operator toolkit continuation

Approved scope: the user requested completing the existing plan beyond #794,
prioritizing lifecycle/navigation, then batches and broader controls. No merge
without fresh explicit confirmation. Tracking: #795; parent design: #793.
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
