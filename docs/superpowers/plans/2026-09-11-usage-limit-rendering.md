# Usage-limit notices in the conversation feed

Status: proposed; research and implementation plan only. No production changes.

## Outcome

Claude Code and Codex usage caps get a compact, provider-labelled feed card with
the blocking limit, precisely labelled reset information, relevant recovery
actions, and expandable original provider text. A cap is provider status, not an
assistant answer. Temporary throttling must not become a spending-cap warning.

The initial surface is the conversation feed. A persistent composer strip is an
optional follow-up, not a prerequisite. This is the working assumption while the
user's placement preference is pending.

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

Issue searches found no dedicated usage-cap-rendering feature. Before production
implementation, create `feat(rendering): render provider usage caps with reset
details and recovery actions`, linking the related work. If the Codex package
needs an event-contract change, track it in that package and update the parent
gitlink through the normal cross-repository workflow.

## What is already present, and where the information is lost

1. Codex's `CodexResponsesAdapter` and `SemanticChannel.publishApiError` already
   emit `errorType`, `resetsAt`, `limitId`, `limitName`, `status`, and
   `retryAfterMs`. Proxy streaming is on by default, but it is optional.
2. `responsesProxy.pickRateLimitHeaders` currently omits
   `x-codex-rate-limit-reached-type`; the semantic event contract also lacks
   that field. Workspace-specific UI cannot safely invent those distinctions.
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

Use a native request/turn association when available. Assign missing identities
once at ingest, scoped to the session run; never key by visible row index or by
message text alone. Idempotent redelivery should not make a second card, while
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

### 0. Freeze carrier evidence and route expectations

- Create/link the feature Issue and record this plan's acceptance criteria.
- Curate the smallest privacy-reviewed Claude carrier using the supplied text
  and the existing corpus. Preserve discriminators that earlier redaction
  erased; do not copy surrounding user conversation into public fixtures.
- Add clearly labelled source-derived Codex fixtures for ordinary/pool limits,
  workspace owner/member cases, missing reset, and generic throttling. Capture a
  real failure when naturally available; do not spend quota to manufacture one.
- Record installed CLI/source versions and evidence origin. Source-derived
  fixtures verify a contract; they do not count as observed production shapes.
- Trace a no-turn HTTP error through adapter, IPC, reducer, and feed. Inspect
  proxy-disabled, remount, replay, and remote hydration coverage as above.
- Produce a finite carrier-to-route table before source implementation. Keep
  unknown shapes explicit instead of adding permissive text heuristics.

### 1. Normalize and retain the necessary facts

- Add the shared notice type and provider-local adapters with behavioral tests.
- Extend `SemanticErrorEntry` / `foldSemanticEvent` to retain validated optional
  error fields, stable identity, and association. Preserve the existing bound
  and reference-stability behavior; keep old recordings without new fields valid.
- If delivering workspace-specific Codex cases, extend the headless package's
  exact header allowlist, classifier, channel type, and publisher together to
  carry a validated `rateLimitReachedType`. Unknown enum values remain unknown.
  No generic header forwarding. Run that package's own tests and pin the result.
- Do not replace or broaden `limitHit` during this presentation change. Test
  that the existing accepted-turn clearing and provider-switch guard still hold.

### 2. Integrate admission, ownership, and shared presentation

- Claude: `renderer/entries/{classify,dispatch}`, provider capability types,
  committed collector, and the shared notice protocol.
- Codex: bounded error records through `rendering/adapter/collectLedgerInput`,
  a notice collector, `rendering/model/{types,ledger,order}`, and the existing
  ledger-to-feed view bridge.
- Update input assembly in desktop and remote/replay callers together. No
  placeholder assistant text and no dependence on a successful turn starting.
- Thread host actions to the view with explicit session/run targets.
- Add provider catalogs/receipts only with truthful evidence provenance. Update
  the canonical rendering architecture where the new owner changes its rules;
  keep per-file rationale in thick WHY comments.

### 3. Verify the behavior people actually see

- The exact Claude example renders a monthly-cap card and separately labelled
  session reset. It remains correct in narrow panes and long timezone labels.
- Quoting that sentence in normal user/assistant/tool output does not specialize
  it. Unrecognized error wording stays readable and keeps its original text.
- Codex ordinary/pool/workspace cases have correct actions; plain 429, overload,
  authentication, context-window, and access errors never get a false reset claim.
- Missing, malformed, expired, midnight-crossing, DST, and cross-timezone reset
  values are handled without fabricated dates or a false recovery promise.
- Pre-turn errors are visible; repeated delivery is idempotent; distinct failed
  requests remain distinct; no duplicate message/card paints; pending user input
  and unrelated streaming/tool rows retain their owners and order.
- Accepted continuation clears active-limit eligibility without deleting history.
  Resume/pagination does not stamp old Claude records as fresh failures.
- Actions address the card's session in Grid and Dispatch, reject stale run
  targets, and behave appropriately in Reader, preview, and remote surfaces.
- Retained recordings and source-derived fixtures exercise the same pipeline.
  Recorded-shape auditing must not claim synthetic profiles were observed live.

Run focused adapter/ledger/reducer and renderer tests first, then the relevant
unit/system/renderer projects, typecheck, test-contract and package checks per
the repository's normal quality gate. The planning-only commit needs only
document/diff verification; no production build has been run for it.

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
