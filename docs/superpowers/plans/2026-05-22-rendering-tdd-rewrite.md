# Rendering TDD Rewrite Plan

Status: planning document, written 2026-05-22.

## Why This Exists

The feed renderer has become a repeated incident source because the app does
not have one tested owner for what appears on screen. The same visible thing
can be claimed by committed transcript rows, semantic current turn, semantic
history, ghosts, optimistic user rows, queued prompts, screen fallback, and
provider-specific renderers.

The important invariant is simple:

> Every visible feed artifact must have exactly one owner at a time, and every
> ownership transfer must be explicit, observable, and tested.

The current code partially moved toward that shape with `FeedRenderItem[]`, but
the ownership logic is still distributed across ingest, semantic folding,
ghost reconciliation, render-unit filtering, provider rows, queue handling, and
React components. That is why fixes keep moving the bug rather than ending the
class.

This plan is not another local guard. It is the plan to make rendering
test-first and turn unknown provider/screen/proxy behavior into diagnostics
that are logged for implementation instead of silently leaking into the feed.

## Issue Title Trail

These are the GitHub issues that make the pattern obvious:

- #172: Fix feed render ownership across committed transcript, semantic live/history, ghosts, and optimistic input
- #183: Add comprehensive rendering regression tests for feed ownership and streaming behavior
- #168: Codex resume feed broken: proxy streaming turn dropped + duplicate semantic-history keys
- #159: Fix feed clearing and missing user rows during MCP/tool-call turns
- #191: Fix stale semantic web-search rows sticking at bottom after rollout commit
- #239: Optimistic submitted user prompts are buried behind semantic/work rows
- #241: Codex QueueStrip can keep processed follow-up prompts stuck after idle
- #173: Codex agents cross-render transcripts: new empty Codex agent prints another agent's JSONL
- #174: Implement prompt suggestions for Claude/Codex - currently leak into the feed as raw items
- #138: Streaming Write tool calls render as raw partial JSON in the live feed
- #98: Claude/Codex interactive question tool calls render as raw JSON - user has to cancel the turn to respond
- #90: Claude prompt submit still inconsistent - detection logic falls behind under load

The bodies matter too:

- #172 already states the core bug: committed entries, semantic current/history,
  ghosts, optimistic rows, queue state, and screen fallback all attempt to own
  user-visible chat content.
- #183 states the missing safety net: explicit rendering regression tests over
  ownership output, not broad snapshots and not live-provider repros.
- #168 shows why a local anti-flicker guard is not enough: it fixed one race,
  then blocked the real proxy `resp_*` turn behind an empty rollout shell.
- #159 shows the provider/runtime side of the same failure: JSONL tailing went
  dead, semantic current churned, optimistic user rows were accepted but did
  not reliably stay visible.
- #239 and #241 prove the problem is not only assistant text. Once assistant
  duplication was patched, the same ownership ambiguity appeared as buried
  user prompts and stale queued prompts.

## PR Title Trail

These PRs show the accumulated patch stack:

- #2: Fix post-refactor permission and feed rendering regressions
- #3: Fix workspace bootstrap and Codex feed rendering
- #7: fix(workspace): render orphaned ghost fallback entries
- #25: Filter sidecar Haiku flows so session title generation stops leaking into the transcript
- #35: fix(codex): drop AGENTS.md+env_context bootstrap from feed
- #47: proxy: filter Claude Code title-gen / sidecar calls by request shape
- #54: fix(feed): suppress orphan ghosts with title-gen / predict-next-prompt shape
- #66: fix(feed): render orphan ghosts only when JSONL stalls past proxy
- #134: feat(feed): live preview for streaming Write tool calls
- #160: fix(codex): correct rollout tail ownership - feed clearing during MCP turns (#159)
- #165: fix(feed): keep semantic history visible while JSONL catches up
- #167: fix(feed): restore Codex live streaming on resume + de-dupe semantic history
- #170: fix(feed): suppress committed semantic assistant duplicates
- #175: feat(feed): establish Codex rendering foundation
- #176: feat(feed): stream codex tool rendering
- #184: feat(feed): ship semantic-first rendering stack
- #186: fix(feed): tighten semantic render ownership
- #194: fix(feed): suppress committed semantic web search
- #197: fix(codex): prove fresh rollout ownership
- #215: Fix feed debug append backpressure
- #252: Fix Codex prompt queue rendering ownership
- #256: Unify feed render item ordering
- #262: Clean up feed render model compatibility fields

The PR bodies show the direction is already partially right. #184 shipped a
semantic-first stack and temporary regression scripts. #256 made a unified
ordered item model. #262 removed compatibility buckets so `FeedRenderItem[]`
is closer to source of truth. The remaining problem is that the compiler that
produces those items is not yet a first-class tested subsystem with unknown
behavior reporting.

## Local Evidence Docs

Relevant local documents already say the same thing from different angles:

- `docs/codex-rewrite-render/first-principles-render-model.md`
- `docs/codex-rewrite-render/renderer-runtime-ingestion.md`
- `docs/superpowers/plans/2026-04-17-codex-semantic-flicker-fix.md`
- `docs/superpowers/plans/2026-04-20-rendering-fixes.md`
- `docs/superpowers/plans/2026-04-20-claude-dup-text-and-screen-churn.md`
- `docs/superpowers/plans/2026-05-07-ghost-system-findings.md`
- `docs/superpowers/plans/2026-05-07-ghost-rendering-predicate.md`

The strongest local conclusion is from the ghost findings: ghost was intended
to be a bridge, but `SemanticStreamingTurn` still owns the live current turn.
That left the app with two live render systems plus committed transcript rows.

## Scope And Affected LOC

Measured surfaces from the current tree:

| Area | LOC | Notes |
|---|---:|---|
| Shared feed UI/model/debug | 5,028 | `src/renderer/src/features/feed/**` |
| Shared semantic/ghost/entry/feed-debug runtime | 2,299 | semantic fold, ghosts, merged entries, entry helpers |
| Shared rendering core total | 7,327 | Practical first target |
| Claude provider renderer + renderer-side mapping/history | 944 | Provider-specific rows plus Claude history/mapping |
| Codex provider renderer + renderer-side mapping/history | 1,711 | Provider rows plus rollout/entry mapping |
| Provider app-specific render total | 2,655 | Added after shared core stabilizes |
| Hook/IPC/action/persistence ingestion surface | 7,818 | High-risk integration surface, not all rewritten first |
| Headless parser/channel/proxy surfaces, Claude | 6,232 | Contract-tested first, not wholesale rewritten |
| Headless parser/channel/proxy surfaces, Codex | 4,736 | Contract-tested first, not wholesale rewritten |

Practical rewrite target: about 10k LOC of renderer/shared/provider rendering
surface. The broader headless and IPC surfaces need fixtures and contracts, but
they should not be rewritten unless tests prove emitted events are wrong.

## Design Rule

Rendering becomes a compiler:

```text
raw provider input
  -> normalized observations
  -> known-pattern detectors
  -> unknown-behavior diagnostics
  -> ownership ledger
  -> FeedRenderItem[]
  -> dumb React rows
```

React should not decide ownership. React should render typed items whose owner,
suppression reason, lifecycle, and source evidence were already decided by a
pure tested layer.

## Unknown Behavior Contract

Any provider/screen/proxy behavior that is not recognized must produce a
diagnostic. Unknowns are not failures by default, but they must be visible and
counted.

Each diagnostic should include:

- provider: `claude`, `codex`, or `terminal`
- surface: `jsonl`, `semantic`, `proxy`, `screen`, `ghost`, `optimistic`, `queue`
- raw type and normalized type, if known
- session id, provider session id, turn id, item id, tool id, call id, if known
- owner candidates
- reason the behavior was not classified
- sample text hash or short preview
- first seen timestamp, last seen timestamp, and seen count
- whether it was rendered, suppressed, or ignored

Examples that must log diagnostics:

- proxy event type has no detector
- semantic block kind has no render policy
- screen condition is visible but not parsed into a condition or known fallback
- committed row cannot be correlated with semantic/ghost/optimistic candidate
- two owners claim the same visible slot
- a queued prompt remains after provider idle with no provider queue signal
- provider-native activity lacks `itemId`, `toolUseId`, or `callId`
- a live row renders from text-hash fallback because ids did not correlate

## TDD Policy

- No production rendering behavior change without a failing fixture or focused
  regression test first.
- Tests assert ownership decisions and render items, not broad DOM snapshots.
- Unknown behavior logging is tested as a feature.
- Provider-specific quirks are fixtures, not comments buried in row components.
- Every new suppression rule must include the reason and the source evidence.
- Every rendered item must expose one owner and stable logical identity.

The first-class test target should be pure TypeScript. React component tests can
exist, but they are secondary. The hard bugs are ownership and lifecycle bugs,
not CSS bugs.

## Proposed Module Boundary

Create a renderer-owned pipeline under:

```text
src/renderer/src/render-pipeline/
  observations.ts
  normalizeClaude.ts
  normalizeCodex.ts
  detectors.ts
  ownershipLedger.ts
  deriveRenderItems.ts
  diagnostics.ts
  fixtures/
  __tests__/
```

Initial consumers:

- `src/renderer/src/features/feed/model/renderModel.ts`
- `src/renderer/src/workspace/semantic/foldEvent.ts`
- `src/renderer/src/workspace/ghosts.ts`
- `src/renderer/src/workspace/mergedEntries.ts`
- `src/renderer/src/workspace/codex/rollout.ts`
- `src/renderer/src/workspace/codex/entries.ts`
- `src/renderer/src/workspace/claude/history.ts`

Do not move everything at once. Start by wrapping current behavior with tests,
then move ownership decisions behind the pipeline one class at a time.

## Phases

### Phase 0: Evidence Freeze

- Capture fixture bundles for #159, #168, #172, #191, #239, and #241 shapes.
- Add fixture builders for committed entries, semantic current/history, ghosts,
  optimistic rows, queued prompts, stream phase, and provider identity.
- Add a single `npm run test:render-pipeline` command.
- Preserve current behavior unless a test explicitly documents a bug and the
  fix is in the same PR.

Exit criteria:

- The known duplicate assistant, missing/buried user, stale queue, semantic
  web-search, ghost fallback, and Codex resume cases are executable as tests.

### Phase 1: Diagnostics Shell

- Add `diagnostics.ts` and `observations.ts`.
- Feed current render model inputs through a no-op classifier.
- Emit diagnostics for unclassified shapes without changing row output.
- Add tests proving unknowns are reported with enough evidence to implement.

Exit criteria:

- Debug bundles can answer: "What did we see, who claimed it, and why did it
  render or not render?"

### Phase 2: Committed Transcript Projection

- Extract committed-row projection from `renderModel.ts` and provider mappers.
- Keep provider-specific row renderers, but make committed ownership pure.
- Test Claude and Codex committed entries, including Codex item-level commits.

Exit criteria:

- Committed rows have stable logical ids and no React component owns
  suppression decisions.

### Phase 3: Semantic Ownership Ledger

- Move semantic current/history renderability out of React components.
- Convert `SemanticStreamingTurn` from owner to renderer.
- Preserve Codex per-block/item suppression. Do not whole-turn suppress Codex
  by `codexTurnId`.
- Add lifecycle diagnostics for stale, replaced, dropped, and archived turns.

Exit criteria:

- Semantic current/history items enter `FeedRenderItem[]` only through the
  ledger.

### Phase 4: Ghost As Fallback Owner

- Keep the current five-rule ghost predicate initially.
- Move ghost eligibility and supersedure reasons into the ownership ledger.
- Test sidecar filtering, orphan timing, `lastJsonlEntryAt`, current-turn
  hiding, and superseded ghost hiding.

Exit criteria:

- Ghosts are never a parallel hidden owner. They either own a fallback row with
  a reason or they are suppressed with a reason.

### Phase 5: Optimistic And Queue Ownership

- Model optimistic user rows and queued prompts as ledger-owned artifacts.
- Add explicit transitions for submitted, queued, accepted, committed,
  superseded, idle-cleared, and stale.
- Keep #239 and #241 as permanent regression fixtures.

Exit criteria:

- A submitted prompt cannot be present-but-buried in a way that looks missing.
- A processed queue item cannot survive provider idle without a diagnostic.

### Phase 6: Provider-Native Activity And Tool Rows

- Normalize provider-native activity blocks such as web search, reasoning,
  apply_patch, exec_command, write_stdin, Write, interactive questions, and
  prompt suggestions.
- Unknown provider-native blocks log diagnostics instead of becoming raw JSON
  feed rows by accident.
- Add provider-specific fixture suites for Claude and Codex.

Exit criteria:

- Live and committed tool/activity rows converge structurally at commit
  boundary, or the mismatch is explicitly documented and tested.

### Phase 7: Delete Duplicate Owners

- Remove old ad hoc suppression branches after equivalent ledger tests exist.
- Make `Feed.tsx` and provider row components render-only.
- Remove temporary test scripts that duplicate the pipeline suite.

Exit criteria:

- A new rendering bug should normally require adding a fixture and detector,
  not editing three unrelated guards.

## First PR Boundary

The first PR should be deliberately small:

1. Add this plan.
2. Add `render-pipeline/diagnostics.ts` and `observations.ts`.
3. Add fixture builders for current `deriveFeedRenderModel` inputs.
4. Add tests for current known cases without changing production output.
5. Wire a no-op diagnostic pass into render debug output behind existing debug
   paths.

That PR should not redesign React rows. Its job is to create the harness that
lets every later PR be test-first.

## Acceptance Criteria For The Rewrite

- `npm run test:render-pipeline` covers committed, semantic current/history,
  ghost, optimistic, queued, provider-native activity, and unknown diagnostics.
- Every `FeedRenderItem` has one owner, one stable logical identity, and one
  lifecycle state.
- Every suppressed candidate records why it was suppressed and which owner won.
- Every unrecognized provider/screen/proxy shape emits a diagnostic.
- Debug bundles include owner candidates before selection and selected items
  after selection.
- Claude and Codex provider-specific renderers only render typed items; they do
  not own cross-source suppression.
- The known issue trail above is represented in fixtures so those bugs cannot
  quietly return.

## Non-Goals

- Do not rewrite all headless packages first.
- Do not redesign the visual feed UI first.
- Do not delete provider-specific renderers until the typed item contracts are
  stable.
- Do not rely on live provider sessions as the primary test mechanism.
- Do not use one giant snapshot as proof. The tests must explain ownership.

## Open Risks

- Codex `resp_*` proxy ids and rollout `turn_id` values often do not match.
  Text-hash fallback is sometimes necessary, but every use must be observable.
- Codex commits response items one at a time, so whole-turn suppression is
  dangerous.
- Claude sidecars and prompt suggestions can look like normal assistant text
  unless explicitly detected.
- Bootstrap replay and live tailing share many shapes but should not always
  trigger the same lifecycle behavior.
- Ghost fallback has a real tradeoff: strict sidecar filtering can hide a short
  real crashed turn. That tradeoff must remain documented and tested.
- Queue and optimistic ownership are user-trust surfaces. A row that exists but
  is buried is still a rendering bug.

