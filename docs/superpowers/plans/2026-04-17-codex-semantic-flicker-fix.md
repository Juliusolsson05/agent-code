# Codex semantic flicker fix

## Problem

Codex live rendering sometimes flickers between "0 blocks" and "1 block"
below the user prompt during an active turn. The feed alternates rapidly
— a tool row appears, disappears, a text row appears, disappears, on a
visible 0/1/0/1 cycle. The bug is intermittent: it triggers on some
turns and not others.

Symptoms observed in the debug panel:

- Two proxy flows both marked `attribution: active` at the same time
  (`proxy-1` and `proxy-2`, both `POST /v1/responses`).
- Two concurrent turn ids visible in the flows list: one `resp_…` from
  the proxy and one `live-…` from the screen fallback.

## Root cause

The Codex semantic pipeline has **three independent producers** that
can all publish turns and deltas into the same single-slot
`SemanticChannel`:

1. **Proxy adapter** — `codex-headless/src/proxy/CodexResponsesAdapter.ts`.
   Opens a turn keyed on `resp_…` on every `response.created`.
2. **Rollout tail** — `codex-headless/src/CodexHeadless.ts:555`. Opens
   a turn keyed on the real rollout `turn_id` once `task_started`
   arrives in the JSONL.
3. **Screen fallback** — `codex-headless/src/CodexHeadless.ts:237`.
   Opens a `live-${Date.now()}` turn as soon as TUI activity is
   detected AND `this.liveSemanticTurnId` is still null.

`SemanticChannel` is a single-slot tracker
(`codex-headless/src/channels/SemanticChannel.ts:76`). If `startTurn`
or `applyDelta` is called with a different `turnId` than the current
active one, it silently seals the current turn and opens the new one
(`SemanticChannel.ts:99-129`, `:164-170`). The renderer's reducer then
resets `currentTurn.blocks = {}` on every `turn_started` / `turn_delta`
whose id doesn't match
(`src/renderer/src/tiles/workspaceStore.ts:577-596`, `:606-629`).

Two concrete scenarios trigger the flicker:

**A. Proxy + screen racing.** The rollout tail is slow (file watcher
 hasn't seen `task_started` yet) while the proxy has already answered.
`CodexHeadless.liveSemanticTurnId` is still `null`, so the screen path
opens `live-xxx` and emits `applyDelta` every ~16 ms. Meanwhile the
proxy adapter has opened `resp_xxx` directly on the channel via
`this.headless.semantic.startTurn({...})`, bypassing the
`liveSemanticTurnId` machinery. Every screen snapshot fires
`applyDelta(live-xxx)`; the channel sees the id mismatch and swaps
`activeTurnId` back to `live-xxx`, resetting the reducer's blocks.
Then the proxy's next `block_started(resp_xxx)` re-populates a block.
Repeat at 60 Hz → visible flicker.

**B. Concurrent proxy flows.** Codex retries or opens a second
`POST /v1/responses` before the first is done. The adapter happily
mints `proxy-2` with its own `resp_yyy` and calls `startTurn` on it
(`CodexResponsesAdapter.ts:211-237`). Both flows publish
`flow_selected` and **no `publishFlowIgnored` is ever emitted** — I
grepped the whole adapter and confirmed it. Both flows then alternate
calling `startTurn` / `publishBlockStarted` / `publishTextDelta`
against the same channel.

The Claude side has the right architecture for this already:
`ClaudeProxyAdapter.ts:243` tracks `activeStreamingFlowId`, only the
first flow to produce chunks becomes `active`, and every other
concurrent flow is explicitly `publishFlowIgnored` with reason
`concurrent with active flow …`. Codex just never got that gate.

## Invariants we want

After the fix:

1. **At most one proxy flow is `active` at a time**, per session. Other
   concurrent flows publish `flow_ignored` and do not touch the
   semantic channel.
2. **The screen fallback does not open a turn while another source
   owns the channel.** `CodexHeadless` screen path must check the
   semantic channel's `activeTurnId`, not just its own
   `liveSemanticTurnId`.
3. **The reducer never resets `currentTurn.blocks = {}` just because
   a stale-source event arrives.** Events from a turn id that doesn't
   match the current live turn are ignored, not allowed to swap the
   slot.
4. **A legitimate source promotion is still possible** — e.g. rollout
   arriving after screen had opened a fallback turn. This needs an
   explicit `finishTurn` / `startTurn` sequence, which already exists
   (`CodexHeadless.ts:544-568`), and the reducer must handle the
   `turn_completed` → `turn_started` handoff cleanly.

## Change plan

### 1. Proxy adapter: gate to a single active flow

**File:** `codex-headless/src/proxy/CodexResponsesAdapter.ts`

Mirror the Claude adapter's `activeStreamingFlowId` pattern.

- Add a private `activeFlowId: string | null = null` field
  (`CodexResponsesAdapter.ts` class body near the `flows` map).
- On the `request` branch at `:211`, mint the flow state the same way
  as today, but **do not call `publishFlowSelected` immediately**.
  The flow starts in `attribution: 'candidate'`. Also extend
  `FlowState` with an `attribution: 'candidate' | 'active' | 'secondary'`
  field, matching the Claude shape.
- On the `response-chunk` branch at `:240`, before handing bytes to
  `drainFrames`, promote the candidate:
  - If `this.activeFlowId === null` → set `state.attribution = 'active'`,
    `this.activeFlowId = flowId`, and publish `flow_selected` with
    `reason: 'first-chunk (no competing active flow)'`.
  - Else → set `state.attribution = 'secondary'` and publish
    `flow_ignored` with
    `reason: "concurrent with active flow " + this.activeFlowId`.
- In every frame handler (`response.created`, `response.in_progress`,
  `response.output_item.added`, `response.output_text.delta`,
  `response.output_item.done`, `response.completed`, reasoning deltas,
  etc.) add an early-return if `state.attribution !== 'active'`. The
  secondary flow continues to parse SSE locally (so we can log stats)
  but **never calls any `this.headless.semantic.*` publisher**.
- On `response-end` / `response-error` / `upstream-error` at
  `:261-302`, if the flow that ended was the active one, clear
  `this.activeFlowId = null` so the next concurrent flow can promote
  on its next chunk.

**Why promotion-on-first-chunk, not promotion-on-`request`:** mirrors
Claude. SSE responses produce chunks; warmups and non-streaming /models
calls don't. Gating on chunks means a pre-warm or a cancelled request
doesn't claim the slot.

### 2. CodexHeadless screen fallback: check the channel, not the field

**File:** `codex-headless/src/CodexHeadless.ts`

The screen path at `:237` currently guards on `!this.liveSemanticTurnId`.
That only sees CodexHeadless's own state — it doesn't know the proxy has
opened a turn on the shared channel.

- Change the guard at `:237` to:

  ```ts
  if (!this.liveSemanticTurnId && this.semantic.getActiveTurnId() === null) {
    // open screen-sourced turn as before
  }
  ```

- Similarly at `:291` the per-snapshot `applyDelta` call must also be
  guarded. Right now it fires whenever `this.liveSemanticTurnId && this.semanticSource === 'screen'`.
  Add a second condition:

  ```ts
  if (
    this.liveSemanticTurnId &&
    this.semanticSource === 'screen' &&
    this.semantic.getActiveTurnId() === this.liveSemanticTurnId
  ) { ... }
  ```

  This prevents the screen path from calling `applyDelta` with a
  stale `live-xxx` id after the proxy has already swapped the channel
  to `resp_xxx`. Without this guard, every 16ms snapshot fights the
  proxy for ownership of `activeTurnId`.

- When the screen guard trips because another source owns the
  channel, `CodexHeadless` should also drop its own stale state so it
  doesn't keep retrying every tick:

  ```ts
  if (this.semantic.getActiveTurnId() !== null && this.liveSemanticTurnId && this.semanticSource === 'screen') {
    this.resetLiveTurn()
  }
  ```

  Safe because the proxy/rollout source that owns the channel will
  emit its own `turn_completed` eventually; we don't need the screen
  fallback to track the shadow anymore.

### 3. Reducer: ignore stale-turn events, don't reset blocks

**File:** `src/renderer/src/tiles/workspaceStore.ts`

Change the `turn_started` and `turn_delta` cases to never blow away
a currentTurn on a mismatched turnId without explicit consent.

- At `:577` (`turn_started` branch), **remove** the reset-on-mismatch
  path. Replace with:

  ```ts
  case 'turn_started': {
    const turnId = String(ev.turnId ?? '')
    if (!turnId) break
    if (!currentTurn) {
      currentTurn = makeEmptyTurn(turnId, ev, now)
    } else if (currentTurn.turnId === turnId) {
      // re-entry: update source if newer provenance
      currentTurn = { ...currentTurn, source: typeof ev.source === 'string' ? ev.source : currentTurn.source }
    } else {
      // stale — drop the event. The legitimate path to swap the
      // current turn is `turn_completed` (for the old id) followed
      // by `turn_started` (for the new one). Single-active-flow
      // gating on the adapter side makes that path the only one
      // we should ever see.
    }
    break
  }
  ```

- At `:606` (`turn_delta` branch), same pattern:

  ```ts
  case 'turn_delta': {
    const turnId = typeof ev.turnId === 'string' ? ev.turnId : null
    if (!turnId) break
    if (!currentTurn) {
      // soft-open a turn. This keeps the "rollout delta arrived
      // before task_started" fallback working — CodexHeadless
      // already synthesises a turn id for that case.
      currentTurn = makeEmptyTurn(turnId, ev, now)
    }
    if (currentTurn.turnId !== turnId) break
    currentTurn = {
      ...currentTurn,
      text: typeof ev.fullText === 'string' ? ev.fullText : currentTurn.text,
      source: typeof ev.source === 'string' ? ev.source : currentTurn.source,
    }
    break
  }
  ```

- The existing `turn_completed` handler at `:1076` already finalises
  currentTurn and sets it to `null` when no pending tools remain. We
  do **not** need to touch that.

**Why defensive reducer even after the adapter fix:** fixes 1 and 2
close the known races, but the reducer should not be the layer that
silently thrashes state. Making it strict means a future provider or
adapter bug can't re-introduce this flicker.

### 4. Source-change reconciliation visibility

**File:** `src/renderer/src/tiles/workspaceStore.ts`

The reducer already handles `source_changed` at `:598`. That remains
correct: when rollout takes over from screen, `SemanticChannel`
emits `turn_completed` for the screen turn and `turn_started` for the
rollout turn (per `CodexHeadless.ts:544-568`), with a `source_changed`
annotation on the next delta. Nothing to change here, but verify the
sequence in testing.

## Order of implementation

I recommend this order because each step is independently verifiable
and the easiest rollback shrinks as you progress:

1. **Step 3 (reducer defensive guard) first.** Smallest blast radius
   (renderer only, no package rebuild). Lands the "flicker can't
   happen at the reducer" safety net before touching the adapters.
   On its own it will *stop* the flicker, because stale events from a
   racing producer will be dropped instead of flipping `currentTurn`.
   But it doesn't address the underlying two-flow race.
2. **Step 2 (CodexHeadless screen guard) second.** No public-surface
   changes; purely tightens the internal gate. Eliminates scenario A.
3. **Step 1 (proxy adapter single-flow gate) last.** Largest code
   change but matches the Claude adapter pattern 1:1, so it's
   well-precedented. Eliminates scenario B. Requires a
   `claude-code-headless` build step + `electron-vite build`.

## Verification

Each step is testable without a full turn-by-turn reproduction, but
the integration signal is the ProxyDebugPanel output.

**After step 3:** submit a Codex prompt, watch the feed during a
streaming turn. Even if two flows are present in the debug panel, the
feed should render monotonically (blocks only appear or update, never
disappear). The debug panel will still show the two flows as "active"
— that's the adapter's responsibility, which we haven't touched yet.

**After step 2:** when the proxy answers before the rollout has
emitted `task_started`, the debug panel's semantic event log should
no longer show a sequence of alternating `turn_started live-xxx` /
`turn_completed` pairs. Only one `turn_started` should land per logical
turn, and its id should be `resp_…` when the proxy is active.

**After step 1:** the debug panel should show at most ONE proxy flow
with `attribution: active` at any moment. Concurrent flows should show
up as `attribution: secondary` with a `flow_ignored` entry in the event
log carrying the reason `concurrent with active flow proxy-N`.

**Manual repro suggestions:**

- Long-ish turn that uses tools. This exercises the proxy + rollout
  + screen race (scenario A).
- Network flake (toggle Wi-Fi briefly) to force a retry during a
  streaming response. This exercises the two-flow case (scenario B).

**Tests to add (nice-to-have, not blocking):**

- `codex-headless/src/testing/` — a proxy-adapter unit test that
  injects two concurrent flow states and asserts exactly one ever
  publishes to `semantic`. Mirror the Claude adapter's existing test
  pattern.
- `workspaceStore` reducer unit test: feed a sequence of
  `turn_started turnId=A`, `block_started`, `turn_started turnId=B`,
  and assert that `currentTurn.turnId === 'A'` and blocks are
  preserved (post-fix) rather than wiped (pre-fix).

## Risks

- **Regression: legitimate screen→rollout takeover.** The flow at
  `CodexHeadless.ts:544` explicitly `finishTurn`s the screen turn then
  `startTurn`s the rollout turn with a new id. With the reducer made
  strict (step 3), the `finishTurn` emits `turn_completed`, the
  reducer seals currentTurn to history, and the subsequent
  `turn_started` opens a fresh turn at the new id. This path stays
  working. Worth confirming manually.
- **Regression: rollout-only sessions (proxy off).** When Claude's
  proxy setting is off, Codex never opens a proxy flow; the rollout
  and screen paths are the only producers. CodexHeadless already
  coordinates those two via `finishTurn` / `startTurn` / `resetLiveTurn`
  at `:544-568` and `:267-281`. None of our changes affect that
  handoff.
- **Regression: resume.** `sessionId` persistence and bootstrap tail
  are orthogonal to live-turn rendering. They land `jsonl-entries`
  directly into the `entries` array, not the semantic reducer. No
  change needed.
- **Performance.** Adding `this.semantic.getActiveTurnId()` lookups
  to the screen path runs once per terminal snapshot (~60 Hz). That's
  a single field read; negligible.

## Rollback

Each change is local to one file. To roll back step N:

- Step 1: revert `codex-headless/src/proxy/CodexResponsesAdapter.ts`.
  Rebuild headless (`npm --prefix claude-code-headless run build` is
  unrelated; codex-headless has its own build). `npm run build` at
  the repo root.
- Step 2: revert `codex-headless/src/CodexHeadless.ts`. Rebuild
  headless + renderer.
- Step 3: revert `src/renderer/src/tiles/workspaceStore.ts`. Renderer
  rebuild only.

No database/state migration implications; semantic state is pure
runtime.

## Out of scope

- **Rewriting the single-slot channel into a multi-turn channel.**
  Tempting, but the existing design choice (one live turn at a time,
  model-side) is correct for the rendering contract. The bug is that
  we violate the contract from the producer side. Fixing producers is
  cheaper and doesn't churn every consumer.
- **Changing flow attribution semantics for rollout/screen.** Those
  aren't "flows" in the proxy sense — they're deterministic single
  sources inside CodexHeadless. Only the proxy has the many-per-
  request-to-one-per-session fanout problem.
