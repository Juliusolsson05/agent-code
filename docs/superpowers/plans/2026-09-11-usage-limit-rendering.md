# Usage-limit notices in the conversation feed

Status: V1 implemented and locally reviewed; production-build verification and
app PR/CI delivery are in progress. Both PRs remain subject to explicit merge approval.

Feature Issue: [agent-code#885](https://github.com/Juliusolsson05/agent-code/issues/885).
Package dependency: [codex-headless#49](https://github.com/Juliusolsson05/codex-headless/issues/49).
Branch: `feat/usage-limit-rendering`. Worktree: `.worktrees/usage-limit-rendering`.
The first branch commit, `3ce09d1a`, contains this plan only. Continue on this
outcome-named branch; do not restart the work on main or create a plan-only PR.

## Outcome

Claude Code and Codex usage caps get a compact, provider-labelled feed card with
the blocking limit, precisely labelled reset information, relevant recovery
actions, and expandable original provider text. A cap is provider status, not an
assistant answer. Temporary throttling must not become a spending-cap warning.

The initial surface is the conversation feed, following the recommended design
the user accepted. A persistent composer strip is outside the first delivery.

Illustrative Claude card, using the user-supplied message:

```text
Claude · Monthly spend limit reached

Session limit resets at 2:10 PM (America/Los_Angeles)

[Manage usage ↗]  [Switch provider…]  [Original message ▾]
```

The secondary line intentionally says **session limit**. This message does not
say that the monthly spend cap resets at 2:10 PM. Do not turn it into a countdown
to monthly-cap recovery. Until a date is established, preserve the provider's
time label instead of inventing an absolute timestamp.

Illustrative Codex card, when the structured event supplies an absolute reset:

```text
Codex · Usage limit reached

Resets Sep 11 at 2:10 PM (America/Los_Angeles)

[Manage usage ↗]  [Switch provider…]  [Original message ▾]
```

These examples describe layout, not captured Codex responses. Use existing
semantic colours and dense, square controls; no modal or new visual framework.

## Evidence and source versions

App planning base: `origin/main` at
`ce0b36f1e692dbe03121d86489163e3c8ee3e1e8`. The original checkout was 24 commits
behind this base; its files remain untouched. Relevant runtime/rendering paths
were inspected, and the semantic-error reduction was checked at the newer base.

Codex reference checkout: `vendor/codex-src` at
`47ca4619be10c20c1cec6ee9944738c5b961fa1d` (2026-09-05). GitHub's API confirmed
the source file's blob hash, `be0192f61aa580ea6660084d0464504900da24ef`, matches
the local `protocol/src/error.rs`. This is a pinned source profile, not a claim
about every installed CLI version or the latest upstream HEAD. The vendor
checkout was not changed.

Primary Codex references, relative to `vendor/codex-src/codex-rs/`:

- `protocol/src/error.rs:643`: `UsageLimitReachedError` and its display formatter.
  [Pinned upstream source](https://github.com/openai/codex/blob/47ca4619be10c20c1cec6ee9944738c5b961fa1d/codex-rs/protocol/src/error.rs#L643)
- `codex-api/src/api_bridge.rs:133`: HTTP 429 plus `error.type` determines
  `usage_limit_reached`; `error.resets_at` is Unix seconds. The mapper reads
  active-pool and reached-type headers.
- `protocol/src/protocol.rs:2340`: reached-type enum distinguishes workspace
  owner/member spending caps and depleted credits.
- `protocol/src/error.rs:431`: `UsageLimitExceeded` groups usage exhaustion,
  insufficient quota, and usage-not-included. That protocol tag alone cannot
  prove a resettable subscription window.
- `tui/src/chatwidget/turn_runtime.rs:411`: the TUI can replace the formatted
  error with workspace-owner-specific remediation and open a native nudge.
- `rollout/src/policy.rs:141`: `EventMsg::Error` is transient, not persisted.
  Do not design Codex cap rendering around an assumed durable error record.

Codex's source-defined families are:

| Evidence | Presentation | Recovery semantics |
|---|---|---|
| `usage_limit_reached`, ordinary pool | Usage limit reached | Absolute reset when supplied; provider usage settings |
| A non-default named pool | Usage limit reached for the named pool | Model change may help, but do not promise another model has capacity |
| `workspace_owner_usage_limit_reached` | Workspace spend cap reached | Owner can increase the cap |
| `workspace_member_usage_limit_reached` | Workspace spend cap reached | Ask a workspace owner to increase it |
| `workspace_owner_credits_depleted` | Workspace credits exhausted | Owner can add credits |
| `workspace_member_credits_depleted` | Workspace credits exhausted | Ask a workspace owner to refill |
| `insufficient_quota` / `usage_not_included` | Quota or access unavailable | Do not imply that waiting fixes it |
| Plain 429 / `rate_limit_exceeded` | Temporary rate limit | Keep distinct from a cap; use any actual retry hint |

The ordinary Codex formatter also varies remediation by plan and promotional
metadata. Agent Code should not duplicate its whole subscription upsell matrix.
Retain the exact message, use stable product settings destinations, and prefer
typed scope/remediation facts when available. `gpt-reserve` is explicitly treated
as ordinary-usage fallback by this source; an arbitrary pool name is not enough
to infer a model-family escape path.

Claude evidence is the user's exact supplied message plus the repository's
existing carrier census and regression tests. No closed-source Claude internals
were assumed. The known durable carrier is `type: "assistant"`,
`isApiErrorMessage: true`, `error: "rate_limit"`, with text in `message.content`.
The code alone is broader than a monthly spend cap: subtype recognition still
needs a provider-owned, narrowly matched message profile.

Existing sources:

- `docs/decomposition/evidence/provider-switch/census.md`: seven Claude
  transcripts with the rate-limit carrier; no captured Codex reached-type
  snapshot in that census. This is historical evidence, not a fresh scan.
- `packages/codex-headless/src/proxy/CodexResponsesAdapter.httpFailure.test.ts`:
  explicitly **source-derived** fixtures, not a recorded real 429.
- Related completed work: Agent Code #474 (Usage view), #820 (limit message
  mistaken for compaction), #821 (switching away from exhausted providers), and
  codex-headless #46 (typed HTTP usage-limit events).

Issue searches found no existing dedicated usage-cap-rendering feature. #885 is
now the authoritative problem/acceptance record, with #49 tracking the additive
Codex event-contract dependency. Update these records when scope or evidence
changes. Implementation defects discovered while delivering this feature do not
need separate Issues unless they establish an independent meaningful problem.

## What is already present, and where the information is lost

1. Codex's `CodexResponsesAdapter` and `SemanticChannel.publishApiError` already
   emit `errorType`, `resetsAt`, `limitId`, `limitName`, `status`, and
   `retryAfterMs`. Proxy streaming is on by default, but it is optional.
2. `responsesProxy.pickRateLimitHeaders` currently omits
   `x-codex-rate-limit-reached-type`; the semantic event contract also lacks
   that field. Workspace-specific UI cannot safely invent those distinctions.
   The proxy also already has a distinct per-call `requestId`, but the API-error
   publisher drops it. #49 preserves both facts as optional event metadata.
3. `session-runtime/semantic/foldEvent.ts` reduces errors to `{ ts, kind,
   message }`. The bounded errors collection is consumed by debug views,
   not currently by the feed's ledger collectors.
4. `SessionRuntime.limitHit` only preserves the time and source for the
   provider-switch guard. It is not enough for a card, and it is not a durable
   event history. In current code it clears on accepted `turn_started` or
   `turn_completed`, despite an older type comment mentioning only completion.
5. Claude's transcript mapper retains its assistant carrier. Its durable-entry
   classifier/dispatcher currently specializes compaction and queued prompts,
   not usage caps, so the cap follows ordinary conversation presentation.
6. Codex's rollout mapper and headless semantic switch do not currently handle
   `event_msg.error`. Adding a mapper branch alone would not fix live coverage:
   the inspected upstream persistence policy does not write that event.
7. Account Usage snapshots and `deriveProviderExhaustion` are useful context,
   but they are expressly advisory. A global 100% reading does not identify the
   failing request, pool, or account configuration of an individual session.

## Rendering contract

### Provider adapters produce a small shared model

Introduce `UsageLimitNotice` under `src/shared/types/usageLimitNotice.ts`, plus
pure provider adapters. The exact TypeScript shape is finalized with the fixture
matrix, but it must retain these facts:

- Provider, stable observation identity, source channel, session-run identity,
  original observation timestamp, and optional native request/turn identity.
- Category: usage window, spend cap, depleted credits, access/quota unavailable,
  or unknown limit. Temporary throttling is classified separately and is not
  painted as a hard-cap card in this first delivery.
- Scope only when proven: account, workspace, named pool/model family, or unknown.
- Original provider message and normalized display title/detail.
- Reset hints with an explicit subject (`blocking-limit`, `session-window`, or
  unknown), and either a validated absolute time or a preserved text/timezone
  label. One notice may mention more than one window.
- Suggested recovery intent, such as manage usage, ask owner, or choose provider.
  The view receives callbacks/capabilities; it does not operate sessions itself.

Provider adapters own recognition and field extraction. Shared components never
parse provider JSON, inspect raw HTTP headers, or search assistant prose.

Claude admission requires the real error-carrier metadata. Only after admission
may a narrowly tested text profile recognize the monthly spend cap and extract
the provider's session-reset clause. Unknown wording remains visible as a
generic provider error; ordinary assistant/user/tool text quoting the same
sentence must remain ordinary text. A record also marked as compaction must be
classified as the API error before compaction presentation, preserving #820.

Codex admission uses `api_error.errorType`. Known reached-type metadata refines
the cap; missing/unknown fields keep a generic title. Convert Unix seconds to
milliseconds exactly once at this adapter boundary, validate the Date range,
and never interpret a missing reset as zero. Never infer recovery from a bare
HTTP 429 or an arbitrary display label.

### One feed owner per notice

Claude's durable notice remains a committed candidate with its native entry
identity. Add a provider durable-entry kind and shared content kind for notices,
and dispatch it through the existing provider capability route before ordinary
assistant rendering. Admission and painting use the same adapter result.

Codex can fail before there is a semantic turn. Do not manufacture an assistant
turn to make an HTTP error fit the feed. Extend the bounded semantic-error
record with its validated metadata and stable ingest identity, then collect
recognized errors as a narrowly defined `provider-notice` ledger owner. This
new owner is an explicit architecture change: it paints status notices only,
does not claim assistant text/tool ownership, and survives turn-null/turn-end
transitions until bounded runtime retention removes it.

Carry the selected model through the existing ledger-to-feed view bridge. The
shared `UsageLimitNoticeView` paints the ledger's selected notice; it must not
run a second independent visibility derivation or add an overlay outside the
ledger. Add a provider-notice render receipt and fixture-backed reason entries.

Use the HTTP proxy's `requestId`, scoped to the session/proxy run, for new Codex
observations. #49 forwards this existing identity rather than inventing another
counter downstream. Preserve any native turn association separately; a failed
request is not a model turn. Assign identities for legacy events without a
request ID once at ingest, using the replay record/ingest sequence when available;
never key by visible row index or message text alone. Exact deduplication of two
unidentified legacy deliveries cannot be promised: keep both observations rather
than accidentally merge distinct failures. Identified redelivery must not make
a second card, while
distinct failed requests must not be merged merely because they share a message
and timestamp. Do not introduce a guessed temporal dedupe window. When a second
channel later gains an evidenced correlation, one candidate supersedes the
other with a recorded reason. Repeated independent Claude failures retain their
native identities; collapsing a whole retry run needs its own proven grouping.

History and active-blocking state are separate. An accepted new turn can clear
`limitHit` without erasing an earlier feed notice. A timer, a newly typed prompt,
or opening usage settings is not evidence that capacity recovered. V1 must not
change queue submission, auto-retry, compaction, or provider-switch guard policy.

### Rendering and actions

Create `src/providers/shared/renderer/protocols/usage-limit/{model.ts,
UsageLimitNoticeView.tsx}`. Keep recognition in the Claude/Codex adapters.

- Show a provider label, short title, and only evidenced detail. Do not use a
  generic red stack-trace treatment for an expected capacity condition.
- Show absolute resets with a date and timezone. A relative time can supplement
  a known instant, never replace it. Text-only reset hints get no countdown.
- Use stable, provider-approved destinations: Claude usage settings and Codex
  usage settings. Do not render arbitrary URLs extracted from messages as
  privileged action buttons. Preserve the unmodified original text in details.
- `Switch provider…` opens the existing flow for the card's explicit session
  identity, not whichever pane happens to be focused. It does not switch
  immediately. Recheck target existence and normal eligibility at click time.
- Reuse the existing Usage view through its explicit open action. Its palette
  command toggles, so blindly dispatching that toggle could close the view.
- Workspace-member cases explain that an owner must act. Do not label their
  button as an action they cannot take. No automatic billing changes or admin
  messages. Model switching is only offered when the existing session capability
  and proven limit scope support it; otherwise preserve the native guidance.
- Reader/preview/remote surfaces use the same presentation. Expose only actions
  their host supports, and never apply a historical card to a replacement run.

## Coverage boundaries that must remain explicit

The smallest useful release covers Claude's durable error carrier and Codex's
existing structured proxy event, including failures with `turnId: null`.

Codex proxy-disabled coverage needs a separate evidence check in Stage 0. Its
native error is not durable in the inspected source, so neither polling JSONL
nor estimating exhaustion from account percentages closes that gap. Inspect
actual terminal snapshots and supported structured sources for the installed
version. Only add a provider-owned status parser if recorded context proves it
can distinguish native error UI from quoted conversation/tool output, including
wrapping and redraws. Screen-derived status must remain status, never semantic
assistant content. If that proof is unavailable, explicitly retain the raw
terminal fallback and report the coverage limitation; do not claim all Codex
transports are covered. Do not redesign the Codex runtime transport for this UI.

Claude cards can be reconstructed from native history. Codex live-only notices
cannot be reconstructed after a cold restart unless an app-owned durable record
exists. V1 uses bounded runtime storage and the existing session-recording/replay
path; it does not create a new persistent journal or write fake records into
provider transcripts. Cold-history parity would be a separately scoped storage
change. Confirm renderer-remount and remote-feed hydration behavior in Stage 0
instead of assuming in-memory events will be re-sent.

## Implementation sequence

Complete these tasks in order. Proposed new filenames below describe ownership;
reuse an existing matching abstraction if the evidence pass finds one. Each
implementation commit must carry the WHY comments that explain its invariants.

### 0. Evidence and carrier contract

- [x] Inspect README/instructions, current rendering ownership, provider limits,
  pinned upstream source, and existing related Issues.
- [x] Create the dedicated worktree from current remote main, commit the plan
  first, and create/link app #885 and package #49.
- [x] Initialize the worktree's pinned package submodules before running code.
  Do not reuse dirty package source from another active checkout.
- [x] Curate the smallest Claude carrier with the supplied product text and
  original discriminators. Keep private surrounding conversation out of fixtures.
- [x] Add labelled source-derived Codex cases for ordinary/pool limits, all four
  workspace reasons, absent/unknown reason, invalid reset, and temporary 429.
- [x] Freeze a carrier-to-route matrix with expected category, reset subject,
  ownership, actions, and fallback. Record source/CLI versions and fixture origin.
- [x] Check no-turn, proxy-disabled, renderer-remount, replay, and remote hydration
  inputs. This is a bounded source/fixture inspection, not a quota-exhaustion run.
  Record unsupported paths without expanding V1 into a new runtime transport or
  durable journal. Source-derived tests do not constitute observed shape evidence.

Exit: the finite fixture matrix can explain every admitted route and every
deliberate fallback. No implementation should depend on an unobserved transcript
error, guessed screen classifier, or guessed timestamp.

### 1. Codex event-contract dependency (#49)

- [x] In a separate codex-headless worktree/branch named for usage-cap metadata,
  commit a package-local plan first. Leave the app's pinned package checkout intact.
- [x] Update `src/proxy/responsesProxy.ts`,
  `src/proxy/CodexResponsesAdapter.ts`, `src/channels/types.ts`, and
  `src/channels/SemanticChannel.ts`: exact reached-type header allowlist, validated
  optional enum, and optional existing proxy `requestId` on HTTP API-error events.
- [x] Extend the colocated HTTP-failure/header-filter tests to cover all known
  reasons, unknown values, missing metadata, different attempts, and unchanged
  non-cap classification. Preserve Unix-second reset units at this package seam.
- [x] Update the package API/event reference only for the actual added fields.
- [x] Run package `npm run check`; review and open the fully implemented package
  PR with `Fixes #49`. Record its exact tested commit in app #885.

Exit: new metadata survives proxy-to-publisher delivery without broadening header
capture or breaking old consumers. App development may use that committed package
revision for integration; package merge and app merge still require explicit
user authorization. Do not publish an app pin whose package commit is unavailable
to a clean CI checkout.

### 2. Shared model and provider normalization

- [x] Add `src/shared/types/usageLimitNotice.ts` and provider-local
  `src/providers/{claude,codex}/renderer/adapters/usageLimitNotice.ts` with
  colocated behavioral tests. There is one canonical model, not another
  independently defined UI variant of its fields.
- [x] In `src/renderer/src/session-runtime/{state.ts,semantic/foldEvent.ts}`,
  retain validated optional error metadata and stable ingest identity. Preserve
  bounded retention and no-op reference stability. Legacy recording fields remain
  optional and no date/message heuristic pretends to supply a missing request ID.
- [x] Admit Claude's verified carrier before compact-summary classification.
  Identify monthly-cap text only inside that carrier and retain the session-reset
  subject. Unknown wording stays visible without an invented subtype.
- [x] Normalize Codex type/reason/reset/pool fields and retain original text.
  An unknown reached type stays a generic limit, never a guessed owner/member role.
- [x] Prove `limitHit` and provider-switch eligibility behavior are unchanged.

Exit: pure tests establish cap categories, accurate reset subjects/units,
negative recognition, and compatible old-event behavior before UI changes.

### 3. Ledger ownership and one shared card

- [x] Extend `src/shared/types/providerConfig.ts` and
  `src/providers/registry.renderer.capabilities.ts` with provider-owned notice
  admission. Claude's `renderer/entries/{classify.ts,dispatch.tsx}` and committed
  collector must agree on that admission, including error/compaction precedence.
- [x] Add the narrow `provider-notice` owner/content contract in
  `src/renderer/src/rendering/model/{types.ts,ledger.ts,order.ts}`. Add a notice
  collector under `rendering/observations/` and pass bounded error input through
  `rendering/adapter/collectLedgerInput.ts`. Preserve unrelated owner decisions.
- [x] Update the real view bridge at
  `src/renderer/src/features/feed/ledger/{useLedgerFeedItems.ts,ledgerFeedItems.ts}`,
  `features/feed/model/renderModel.ts`, and `features/feed/ui/Feed.tsx` so the
  selected notice carries its normalized model into the row. Do not reclassify
  raw provider input in JSX or add a second visibility calculation.
- [x] Implement shared `protocols/usage-limit/UsageLimitNoticeView.tsx`; use its
  optional `model.ts` for presentation helpers only, importing the canonical
  shared type. Use existing UI primitives, theme tokens, and accessible details.
- [x] Add fixture-backed ownership decisions and render receipts. Update the
  canonical rendering design's owner rules because this changes architecture.
  Do not rewrite unrelated design docs for routine implementation details.

Exit: a Codex failure with no turn produces one visible status row, while a
Claude committed cap replaces its ordinary assistant presentation. Earlier user
input and unrelated streaming/tool artifacts retain their order and ownership.

### 4. Session actions, surfaces, and replay

- [x] Thread explicit session/run-bound action callbacks into the shared view.
  Open the existing provider-switch flow and existing Usage view; validate the
  target at invocation and preserve normal eligibility checks. Do not dispatch
  the Usage palette toggle when the intent is an explicit open.
- [x] Allow only known provider-settings destinations. Offer appropriate
  owner/member guidance; opening settings must not claim that a cap was changed
  or an admin request sent. Original text stays available verbatim.
- [x] Extend `RuntimeRenderInput` and all actual input producers together:
  the desktop ledger hook, `src/remote-client/src/transcript/store.ts`,
  `src/remote-client/src/ui/SessionView.tsx`, and
  `src/renderer/src/rendering/replay/reconstructSlices.ts`. Verify the existing
  recording replay harness sees the same notice inputs. Inspect
  `src/main/remote/SessionFeedSource.ts` only for the event/hydration gap proven in
  Task 0; no speculative persistent state transport.
- [x] Verify Reader and preview use the same card when source evidence exists;
  actions are offered only by hosts that support them. A historical card must
  never operate a replacement session run.

Exit: Grid, Dispatch, Reader, preview, and connected remote clients behave
consistently for supported source evidence; remount/reconnect limitations are
documented precisely, with no cold-history parity claim.

### 5. Verification and delivery

| Behavior protected | Necessary verification |
|---|---|
| Monthly cap versus session reset | Exact Claude example; unknown text; quoted text in user/assistant/tool carriers; error plus compaction flags |
| Reset accuracy | Missing/malformed/out-of-range/expired epochs, text-only times, midnight, DST and alternate viewer timezone |
| Error taxonomy | Ordinary/pool/workspace reasons; bare 429, overload, auth, context-window and access errors never gain a false recovery claim |
| Identity and ownership | Same identified delivery twice, distinct equal-text/equal-time requests, no-turn failure, resumed/paginated Claude history, unrelated streaming/tools |
| Lifecycle and scope | Accepted continuation, old-event replay, exact session/run action targeting, stale/replaced session and different focused pane |
| Shared presentation | Narrow/wide panes, original-message disclosure, keyboard access, Grid/Dispatch/Reader/preview/connected remote and recording replay |

- [x] Run focused colocated adapter, reducer, ledger and renderer tests as each
  task lands. Do not add tests that simply mirror field assignments.
- [ ] After integration and the committed package pin, run app `npm run check`
  and the normal CI quality gate. The package runs its own `npm run check`; do
  not substitute app compilation for package behavioral checks.
- [x] Inspect the rendered cards at narrow/wide widths and record the observed
  results in the PR. Declare source-derived fixtures separately from real captures.
- [ ] Review the complete diff, resolve valid feedback, synchronize #885/#49,
  and open the app PR only with implementation, verification, and migration/
  limitation notes complete. Suggested title:
  `feat(rendering): show provider usage caps and recovery actions`.
- [x] Use `Fixes #885` only if the agreed V1 criteria are met. Link the package
  PR and related #820/#821 with `Refs` where appropriate; do not claim to resolve
  unrelated follow-up work. Keep the Issue and PR current if scope changes.
- [ ] Require passing current-head CI and review before proposing either merge.
  Never automatically merge. The user authorized implementation and PR creation; merge remains a separate
  explicit user decision.

There is no persisted workspace/settings schema change in V1. Optional new event
fields preserve older recordings, and dropping runtime-only notice state during
rollback follows the same existing lifetime as semantic errors. No provider
transcript or durable account data needs migration. The first two commits are planning-only; the implementation verification record follows below.

## Explicit exclusions

No automatic provider/model switching, billing changes, retry scheduling,
composer disabling, new account polling, provider-native transcript writes,
generic all-error framework, or OpenCode-specific profiles in the first delivery.
The shared presentation can accept future provider adapters without guessing
their carrier formats now.

Implementation is complete when the documented carriers render through the
single ledger with correct provenance, cap/reset semantics and actions, the
negative and lifecycle cases pass, and any unsupported transport/history
coverage is disclosed in the PR rather than hidden behind fallback heuristics.

## Implementation evidence update

The finite source-derived carrier matrix lives in
`testing/fixtures/provider-usage-limits/cases.json` and its feature tests in
`src/renderer/src/features/usage-limit/usageLimit.test.ts`: Claude monthly cap owns a
committed notice with a text-only session reset; Codex ordinary/pool and known
workspace reasons own transient API-error notices. Unknown reasons preserve a
generic limit; temporary throttling does not gain a cap/reset claim. The fixture
labels distinguish supplied product text/synthetic carrier IDs from live traffic.

Codex native errors are not durable in the pinned upstream source. No safely
attributable terminal-only error carrier was established, so proxy-disabled and
cold-history recovery remain explicitly outside V1. Connected remote feeds fold
live semantic events with the shared reducer; native-history bootstrap alone
cannot restore a prior transient error. Component remounts retain errors while
the shared session runtime survives. No new journal/transport is introduced.


### Delivered boundaries and verification

- The dependency is published at `codex-headless` commit `5bfeaca` in PR #50;
  `npm run check` passed all 212 tests and the package CI quality gate is green.
- The app reuses the existing bounded semantic error history (20 records), with
  request/run identity and optional typed metadata. `RuntimeRenderInput` already
  contains the complete semantic state, so it required no new wire/schema field.
- Remote memoization now includes errors, raw-screen fallback yields to an
  admitted notice, and the reconnect prefix gate admits complete API errors while
  continuing to withhold interrupted assistant suffixes. Grid and Dispatch share
  Feed; Reader and preview dispatch reuse the same card.
- Feature tests cover the provider adapters through the real fold, ledger,
  Feed/Reader/remote views, existing `limitHit` regression suite, and recording
  invariant harness, including bounded eviction and a negative disappearance
  control. The usage feature's executable control reference documents the UI.
- Real Electron/Chromium inspection used the actual component and stylesheet in
  an isolated temporary profile with synthetic fixture input: 360 px and 900 px,
  no horizontal overflow, and Space opens the focused original-message summary.
- Full local `npm run check` reached 466 test files / 3,228 cases. It exposed the
  feature ownership registration requirement (fixed and separately verified) and
  the pre-existing missing personal image transcript assertion tracked by #839.
  The latter reproduces in the unchanged image test and remains outside this PR;
  it is not skipped or weakened. Final build/check details live in the PR.
