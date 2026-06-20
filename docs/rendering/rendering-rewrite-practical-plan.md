# Rendering Rewrite Practical Plan

Date: 2026-05-22

This is the practical architecture plan for rewriting Agent Code's rendering system. It intentionally uses the best findings from the rendering knowledge dump and the architecture research agents, but it does not copy their most elaborate shapes. The goal is not to build a framework. The goal is to make the feed understandable, testable, and hard to break.

The short version:

```text
provider/raw input
  -> observation
  -> detector output / unknown
  -> render state
  -> candidates
  -> ownership ledger
  -> ordered view model
  -> React rows
```

The renderer is currently fragile because too many parts compete to decide what is visible: committed JSONL, semantic live state, screen parsing, proxy events, ghost rows, optimistic prompts, queue state, work state, and provider conditions. The rewrite makes that competition explicit. Every visible artifact has exactly one owner, and every rejected artifact has a recorded reason.

## What We Are Building

We are building a new rendering pipeline from scratch, tests first, alongside the old renderer. The old renderer stays alive until the new one proves itself against fixtures and shadow comparisons.

The new pipeline produces a typed feed view model. React consumes that view model and renders it. React does not decide ownership, parse provider shapes, suppress duplicate semantic rows, reconcile optimistic prompts, or classify conditions.

The system has four primary jobs:

1. Normalize provider/local inputs into typed observations.
2. Detect known behavior and record unknown behavior.
3. Resolve ownership into a ledger.
4. Convert selected ledger entries into ordered view-model rows.

This is not a cleanup of the current renderer. Existing code can be used as reference material and as a source of invariants, but the new pipeline should not inherit the old shape.

## What We Keep From The Research

The research agents were useful, but too expansive. These ideas are worth keeping:

- **Pipes and filters:** each stage has a clear input and output.
- **Anti-corruption layer:** provider quirks die at the normalization boundary.
- **Event-sourced projection mindset:** given the same observations, the same feed view model should be reproducible.
- **Typed discriminated unions:** adding a new event or row kind should force explicit handling.
- **Ownership ledger:** selected and rejected candidates are both observable.
- **Case fixtures:** one behavior or bug class per directory.
- **Unknown diagnostics:** unknown provider/screen/proxy behavior is a structured artifact for future implementation.
- **Dumb rows:** React renders typed data and does not own rendering policy.

## What We Reject Or Defer

These ideas are too much for the first rewrite and should not be included unless later pain justifies them:

- A giant `render-pipeline/` package with everything flat inside it.
- Fifteen PRs of scaffolding before the feed changes.
- A diagnostic code generator or OpenTelemetry-style schema registry.
- Bitemporal modeling as a formal concept.
- A general-purpose rules engine or detector DSL.
- XState as a dependency.
- Stryker/mutation testing in the first implementation.
- Separate Vitest projects for every pipeline stage.
- Treating `ghost`, `queue`, `optimistic`, and `runtime` as detector channels from day one. They are ownership sources first; only promote them to detector channels if needed.

The standard is: if a boundary prevents a known class of rendering bug, keep it. If a boundary only makes the directory tree look more architectural, cut it.

## Proposed Structure

```text
src/renderer/src/rendering/
  observations/
    types.ts
    fromClaude.ts
    fromCodex.ts
    fromLocal.ts

  detectors/
    types.ts
    unknowns.ts
    claude/
      screen/
      semantic/
      proxy/
      committed/
    codex/
      screen/
      semantic/
      proxy/
      committed/

  model/
    state.ts
    reduce.ts
    candidates.ts
    ownershipLedger.ts
    order.ts
    viewModel.ts

  view/
    Feed.tsx
    FeedRow.tsx
    rows/
    tools/
    markdown/
    conditions/

  fixtures/
    claude/
    codex/
    mixed/

  __tests__/
    reduce.test.ts
    ownershipLedger.test.ts
    viewModel.test.ts
    fixtures.test.ts
```

This structure is intentionally smaller than the research proposals. It still gives us real boundaries:

- `observations/` handles input normalization.
- `detectors/` handles known and unknown behavior classification.
- `model/` handles state, candidates, ownership, ordering, and view-model derivation.
- `view/` handles React rendering only.
- `fixtures/` holds executable examples.
- `__tests__/` drives the pipeline from the outside.

If any file starts growing into a second subsystem, split it then. Do not pre-split everything.

## Module Responsibilities

### `observations/`

`observations/` converts raw provider and local input into a provider-neutral observation union.

Examples of raw inputs:

- Claude JSONL entries.
- Claude proxy/SSE semantic events.
- Claude screen parser outputs.
- Codex rollout JSONL entries.
- Codex Responses API proxy events.
- Codex screen parser outputs.
- local submit events.
- queue/optimistic prompt events.
- work-state transitions.
- ghost lifecycle events.

The output should be boring and typed:

```ts
type RenderObservation =
  | { kind: 'committed.user'; provider: 'claude' | 'codex'; /* ... */ }
  | { kind: 'committed.assistant'; provider: 'claude' | 'codex'; /* ... */ }
  | { kind: 'semantic.text_delta'; provider: 'claude' | 'codex'; /* ... */ }
  | { kind: 'semantic.tool_call'; provider: 'claude' | 'codex'; /* ... */ }
  | { kind: 'screen.frame'; provider: 'claude' | 'codex'; /* ... */ }
  | { kind: 'proxy.event'; provider: 'claude' | 'codex'; /* ... */ }
  | { kind: 'local.optimistic_prompt'; provider: 'claude' | 'codex'; /* ... */ }
  | { kind: 'local.queue'; provider: 'claude' | 'codex'; /* ... */ }
  | { kind: 'work.phase'; provider: 'claude' | 'codex'; /* ... */ }
  | { kind: 'ghost.entry'; provider: 'claude' | 'codex'; /* ... */ }
  | { kind: 'unknown.observation'; provider: 'claude' | 'codex' | 'unknown'; /* ... */ }
```

The exact union should be designed by the first implementation PR, but the invariant is fixed: downstream code consumes observations, not raw provider shapes.

Provider-specific quirks belong here or in provider-specific detectors. They should not leak into React rows.

### `detectors/`

`detectors/` identifies known provider behavior and emits either a typed detection or a typed unknown.

The first detector split should be:

```text
detectors/
  claude/
    screen/
    semantic/
    proxy/
    committed/
  codex/
    screen/
    semantic/
    proxy/
    committed/
```

This maps to the real problem:

- Claude screen behavior is different from Codex screen behavior.
- Claude semantic behavior is different from Codex semantic behavior.
- Proxy behavior can matter before it becomes semantic state.
- Committed transcript behavior can matter for dedupe and ownership.

Detector outputs must be typed. They should describe what was found, where it came from, and what evidence supports it.

Example:

```ts
type RenderDetection =
  | {
      kind: 'condition.permission_prompt'
      provider: 'claude'
      channel: 'screen'
      conditionKey: string
      actions: ConditionAction[]
      evidence: DetectionEvidence
    }
  | {
      kind: 'sidecar.detected'
      provider: 'claude' | 'codex'
      channel: 'proxy' | 'semantic' | 'committed'
      reason: string
      evidence: DetectionEvidence
    }
  | {
      kind: 'unknown.behavior'
      provider: 'claude' | 'codex' | 'unknown'
      channel: 'screen' | 'semantic' | 'proxy' | 'committed'
      evidence: DetectionEvidence
      disposition: UnknownDisposition
    }
```

Detectors are not allowed to:

- import React.
- return JSX.
- decide final feed ownership.
- mutate render state.
- hide unknown behavior.

### `model/`

`model/` is the heart of the rewrite. It transforms observations/detections into a feed view model.

Files:

- `state.ts`: render state shape.
- `reduce.ts`: pure reducer over observations and detections.
- `candidates.ts`: enumerates every possible visible artifact.
- `ownershipLedger.ts`: chooses winners and records rejected candidates.
- `order.ts`: sorts selected entries.
- `viewModel.ts`: converts selected ledger entries into rows for React.

The most important file is `ownershipLedger.ts`.

The ledger must answer:

- What wanted to render?
- What won?
- What lost?
- Why did it lose?
- Which raw observations or detections caused this?

Candidate examples:

```ts
type RenderCandidate =
  | { owner: 'committed'; slot: SlotKey; /* ... */ }
  | { owner: 'semantic-current'; slot: SlotKey; /* ... */ }
  | { owner: 'semantic-history'; slot: SlotKey; /* ... */ }
  | { owner: 'ghost'; slot: SlotKey; /* ... */ }
  | { owner: 'optimistic-prompt'; slot: SlotKey; /* ... */ }
  | { owner: 'queued-prompt'; slot: SlotKey; /* ... */ }
  | { owner: 'work-state'; slot: SlotKey; /* ... */ }
  | { owner: 'condition'; slot: SlotKey; /* ... */ }
  | { owner: 'empty-state'; slot: SlotKey; /* ... */ }
  | { owner: 'unknown'; slot: SlotKey; /* ... */ }
```

Ledger decision examples:

```ts
type OwnershipDecision = {
  candidateId: string
  selected: boolean
  owner: RenderOwner
  slot: SlotKey
  reason:
    | 'selected'
    | 'committed-text-owns-semantic'
    | 'committed-tool-use-owns-semantic'
    | 'committed-tool-result-owns-live-output'
    | 'claude-whole-turn-suppressed'
    | 'codex-block-level-suppressed'
    | 'ghost-sidecar-shape'
    | 'ghost-stale-orphan'
    | 'semantic-current-owns-turn'
    | 'optimistic-prompt-owned-by-committed'
    | 'queue-owned-by-active-submit'
    | 'unknown-hidden'
    | 'unknown-queued-for-implementation'
  evidence: string[]
}
```

The exact reason union will evolve, but rejected candidates must never disappear without a reason.

### `view/`

`view/` renders typed view-model rows.

It may contain:

- `Feed.tsx`
- `FeedRow.tsx`
- `rows/UserMessageRow.tsx`
- `rows/AssistantMessageRow.tsx`
- `tools/*`
- `markdown/*`
- `conditions/*`

It must not contain:

- committed vs semantic dedupe.
- ghost visibility decisions.
- optimistic prompt reconciliation.
- queue ownership logic.
- screen parsing.
- provider proxy parsing.
- unknown behavior classification.

React rows can choose presentation details. They cannot choose source-of-truth ownership.

### `fixtures/`

Fixtures are the executable spec for rendering.

Proposed shape:

```text
fixtures/
  codex/
    proxy-responses/
      001-resp-id-split/
        input.observations.jsonl
        expected.ledger.json
        expected.rows.json
        expected.unknowns.json
        README.md
    committed-rollout/
    screen/

  claude/
    proxy-sse/
    committed-jsonl/
    screen/

  mixed/
    buried-prompt-239/
    stale-web-search/
    ghost-sidecar-shape/
```

Every fixture directory must explain why it exists. The `README.md` should include:

- what bug or behavior this protects.
- related issue/PR if known.
- which source planes are involved.
- what would break if this fixture were removed.
- whether user text has been redacted.

## Unknown Behavior Contract

Unknown behavior is not a fallback row. Unknown behavior is a structured finding.

Minimum fields:

```ts
type UnknownBehavior = {
  id: string
  provider: 'claude' | 'codex' | 'unknown'
  channel: 'screen' | 'semantic' | 'proxy' | 'committed'
  sourceKind: string
  firstSeenAt: number
  observationHash: string
  sessionId?: string
  turnId?: string
  rawShape: unknown
  redactedPreview?: string
  disposition:
    | 'queued_for_implementation'
    | 'hidden_unowned'
    | 'hidden_duplicate'
    | 'rendered_fallback_dev_only'
  evidence: string[]
}
```

Rules:

- Unknowns are logged in tests and debug bundles.
- Unknowns do not silently become assistant rows.
- Unknowns do not vanish behind `return null`.
- Unknowns should be easy to convert into a new fixture.
- If raw payload can contain user text, store a redacted preview plus a hash.

## Test Strategy

Vitest is the base framework. Do not reintroduce script tests.

The first test suite should be small but load-bearing:

```text
rendering/__tests__/
  reduce.test.ts
  ownershipLedger.test.ts
  viewModel.test.ts
  fixtures.test.ts
```

### Unit Tests

Unit tests should cover:

- reducer purity.
- idempotent replay of the same observation id.
- candidate enumeration.
- ownership selection.
- rejection reasons.
- ordering.
- unknown behavior creation.

### Fixture Tests

Fixture tests should replay real/minimized cases end to end:

```text
observations -> detections -> state -> candidates -> ledger -> rows
```

Assertions should compare:

- `expected.ledger.json`
- `expected.rows.json`
- `expected.unknowns.json`

Do not snapshot massive DOM output. DOM tests are for row presentation, not ownership.

### First Tests To Write

These should exist before meaningful implementation:

1. Committed user + assistant messages produce two ordered rows.
2. Codex semantic current matching committed text is suppressed by committed text.
3. Claude semantic history can be whole-turn suppressed when committed `message.id` matches.
4. Codex does not use Claude-style whole-turn suppression.
5. Newer optimistic Codex prompt sorts after stale semantic history.
6. Ghost sidecar-shape candidate is rejected with a ledger reason.
7. Unknown Codex proxy event is hidden and logged as `queued_for_implementation`.
8. Claude screen permission prompt is detected as a condition, not assistant text.
9. Codex approval screen is detected as a condition, not assistant text.
10. A full fixture run emits matching rows, ledger, and unknowns.

## Migration Plan

The migration should produce value early. Avoid a long scaffolding runway.

### PR 1: Skeleton And First Fixtures

Create:

- `src/renderer/src/rendering/observations/types.ts`
- `src/renderer/src/rendering/model/*`
- `src/renderer/src/rendering/fixtures/*`
- first Vitest tests.

No React cutover. No production behavior change.

Acceptance:

- tests run.
- first fixtures fail until implementation starts.
- README explains the pipeline contract.

### PR 2: Minimal End-To-End Model

Implement enough to pass:

- committed user/assistant fixture.
- Codex semantic duplicate suppression fixture.
- unknown proxy event fixture.

Acceptance:

- `observations -> ledger -> rows` works for simple cases.
- ledger has selected and rejected entries.

### PR 3: Provider Conditions

Implement detector shell and first screen/condition cases:

- Claude permission/trust.
- Codex approval/trust/readiness.

Acceptance:

- conditions are typed.
- React condition outlets can consume typed condition view models.
- screen condition detections do not become transcript rows.

### PR 4: Ghost, Optimistic, Queue Ownership

Move the known hard cases into the ledger:

- ghost sidecar shape.
- stale orphan ghost.
- optimistic prompt ownership.
- queue strip ownership.
- buried prompt ordering.

Acceptance:

- current known ghost/queue bugs have fixtures.
- every hidden ghost or prompt has a ledger reason.

### PR 5: Shadow Mode

Run new model beside the current renderer.

Acceptance:

- old renderer still paints.
- new renderer emits debug comparison.
- divergences become fixtures.

### PR 6: View Cutover

Only after enough shadow confidence:

- `Feed.tsx` reads new view model.
- old row ownership guards are removed when their ledger tests exist.

Acceptance:

- fixture suite green.
- manual Claude and Codex smoke passes.
- legacy fallback remains available briefly through a simple env/debug flag if needed.

## Design Rules

These rules matter more than the exact directory tree:

1. Every visible artifact has exactly one owner.
2. Every rejected artifact has a reason.
3. Unknown behavior is structured and testable.
4. Provider-specific parsing stays before shared ownership.
5. React rows render typed data only.
6. Tests assert ledger and rows, not just DOM.
7. Fixtures explain why they exist.
8. Time is explicit in tests.
9. Avoid generic abstractions until a second real use case exists.
10. Do not preserve old code shape for compatibility if the whole point is escaping it.

## Open Questions

These should be decided before implementation:

- Should the new folder be `rendering/` or `render-pipeline/`? This plan recommends `rendering/` because it includes detectors, model, fixtures, and view.
- Should queue prompts be rows in the feed model or a composer-adjacent strip model? The ledger should decide ownership either way.
- Should conditions render inside feed, as overlays, or both? The condition data should be shared; presentation can be separate.
- What is the minimal legacy shadow comparison we need before cutover?
- Which real debug bundles should become the first fixture corpus?

## Success Criteria

The rewrite is succeeding when a rendering bug report can be phrased like this:

> Candidate `semantic-history:resp_abc` was rejected because committed text owns that slot; fixture `mixed/buried-prompt-239` reproduces the old failure.

It is failing if we are still saying:

> The feed rendered something weird and we need to inspect three React components to guess why.

The new renderer should make the reason visible in the ledger, reproducible in a fixture, and boring to debug.
