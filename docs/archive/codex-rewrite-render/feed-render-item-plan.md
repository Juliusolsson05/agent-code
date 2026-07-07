# FeedRenderItem Plan

Date: 2026-05-20

This plan exists because the current renderer still has the exact structural flaw that keeps producing "my prompt did not render" incidents. The prompt usually did render. It rendered into the committed/optimistic entry plane, then stale semantic history, live semantic rows, and the work indicator rendered below it.

The fix is not another queue special case. The fix is for Feed to render one ordered list of typed items.

## Current Failure

The current model is only a partial selector:

```ts
type FeedRenderModel = {
  visibleEntries: Entry[]
  renderedSemanticHistory: SemanticLiveTurn[]
  renderedSemanticTurn: SemanticLiveTurn | null
  shouldShowWorkIndicator: boolean
  debugRows: DebugVisibleRow[]
}
```

`Feed.tsx` still paints those buckets in hardcoded JSX order:

1. committed / optimistic `entries`
2. `renderedSemanticHistory`
3. `renderedSemanticTurn`
4. `WorkIndicator`

`TileLeaf.tsx` then paints `QueueStrip` below `Feed`.

That means a user prompt can be present in `visibleEntries` but still not be the visual tail:

```text
entry: user: please read A LOT...
semantic-history: resp_033ca5d
semantic-history: resp_0620432
semantic-history: ...
semantic-current: resp_07ebe92
work: responding
```

From the user's point of view, the prompt is gone because the pane tail is occupied by semantic/work surfaces that are not ordered against the prompt.

## Evidence From Saved Bundles

These are not hypothetical:

- `2026-05-20T14-00-04-079-b53fc4fe`
  - Note: `prompt came before the last final response`
  - Prompt `can you figure it out for me .` exists at row `83/86`.
  - Rows below it: `semanticHistory=1`, `semanticCurrent=1`, `work=1`.
- `2026-05-20T15-09-04-906-7b859c43`
  - Note: `STILL NOT SHOWING FUCKING USER PROMPT ; THE FUCK ?`
  - Prompt `please read A LOT...` exists at row `60/76`.
  - Rows below it: `semanticHistory=14`, `semanticCurrent=1`, `work=1`.
- `2026-05-20T15-15-32-562-7b859c43`
  - Note: `same shit, no user prompt, might be related to MCP stuff?`
  - Prompt `Lets reivew it with a codex agent...` exists at row `62/110`.
  - Rows below it include later committed assistant/tool entries plus `semanticHistory=17`, `semanticCurrent=1`, `work=1`.
  - This one is not the pure "no row" shape; it is normal post-submit activity mixed with the same stale semantic-history tail.

The screen tail in the affected bundles often shows strings like `Improve documentation in @filename` or `Implement {feature}`. Those are Codex composer placeholders/suggestions, not submitted prompts. The saved `visible_rows` log is the reliable feed-render evidence.

## Why PR #252 Was Not Enough

PR #252 fixed a real path, but it fixed it at submit time only.

The patch taught `addOptimisticCodexUserEntry` to queue a Codex prompt when renderable semantic history/current already owns the feed tail:

```text
entry: previous assistant
semantic-history: previous live bridge
work: submitting
queue-strip: queued follow-up prompt
```

That makes the prompt visible at the bottom because `QueueStrip` renders after `Feed`.

But the handoff recreates the bug:

1. user submits while semantic history is renderable
2. prompt appears in `QueueStrip`
3. authoritative rollout user row arrives
4. `useIpcSubscriptions` removes the queued prompt
5. same prompt is appended to `entries`
6. `Feed` paints `entries` before semantic history/current/work

Result:

```text
entry: previous assistant
entry: queued follow-up prompt
semantic-history: previous live bridge
work: responding
```

There is also a timing race:

1. submit-time gate sees no renderable semantic history
2. optimistic prompt is appended to `entries`
3. semantic history becomes renderable on the next frame
4. prompt is now above semantic/work rows

This is why queue logic cannot be the main boundary. It can preserve immediate feedback, but it cannot decide final feed order.

## Target Invariant

Feed must render a single ordered plan:

```ts
type FeedRenderItem =
  | FeedEntryItem
  | FeedSemanticHistoryItem
  | FeedSemanticCurrentItem
  | FeedWorkItem
  | FeedQueuedPromptItem
  | FeedEmptyItem
```

Every visible surface in the conversation pane must exist as one item in that plan. JSX may switch by item type, but it must not map separate planes independently.

The core invariant:

> If two feed surfaces are simultaneously visible, the selector must explicitly decide their relative order.

No visible row should be ordered by accidental JSX branch position.

## Non-Goals

- Do not rewrite semantic folding.
- Do not change Codex rollout parsing.
- Do not remove `QueueStrip` UI styling as part of the first pass.
- Do not solve every duplicate-suppression edge with timestamps. Ownership suppression remains necessary.
- Do not treat `streamPhase` as transcript order. Work is a phase surface, not a message.

## Proposed Types

Start narrow and explicit:

```ts
type FeedRenderItemBase = {
  key: string
  order: FeedRenderOrder
  debugLabel: string
}

type FeedRenderOrder = {
  sequence: number
  timeMs: number | null
  source: 'entry' | 'semantic-history' | 'semantic-current' | 'work' | 'queue' | 'empty'
}

type FeedEntryItem = FeedRenderItemBase & {
  type: 'entry'
  entry: Entry
  visibleDecision: VisibleDecision
}

type FeedSemanticHistoryItem = FeedRenderItemBase & {
  type: 'semantic-history'
  turn: SemanticLiveTurn
  committedAssistantText: CommittedAssistantText
}

type FeedSemanticCurrentItem = FeedRenderItemBase & {
  type: 'semantic-current'
  turn: SemanticLiveTurn
  committedAssistantText: CommittedAssistantText
}

type FeedWorkItem = FeedRenderItemBase & {
  type: 'work'
  phase: StreamPhase
  toolName: string | null
  toolUseId: string | null
  turnStartedAt: number | null
}

type FeedQueuedPromptItem = FeedRenderItemBase & {
  type: 'queued-prompt'
  queuedMessage: QueuedMessage
}

type FeedEmptyItem = FeedRenderItemBase & {
  type: 'empty'
  provider: AgentProvider
}
```

`sequence` is the final stable sort key. `timeMs` is diagnostic and useful for computing `sequence`, but UI code should consume only the already-ordered array.

## Ordering Rules

These are the first-pass rules. They can evolve, but they must remain centralized.

### 1. Committed Entries

Committed and optimistic entries enter the plan as `entry` items.

Order source:

- use entry timestamp when parseable
- otherwise use original entry index as fallback

Why fallback matters: historical/tool entries sometimes have synthetic or missing timestamps. We still need stable order.

### 2. Semantic History

Renderable semantic-history turns enter the plan as `semantic-history` items.

Order source:

- prefer `endedAt`
- fallback to `startedAt`

Why `endedAt`: semantic history represents completed live turns waiting for committed catch-up. If a semantic history turn ended before a user prompt timestamp, it belongs before that user prompt, not below every committed entry.

Critical rule:

```text
semantic-history.endedAt < user-entry.timestamp
=> semantic history must render before the user entry
```

This is the rule that fixes the saved-bundle shape.

### 3. Semantic Current

Renderable current semantic turn enters the plan as `semantic-current`.

Order source:

- use `startedAt`
- if `startedAt` is missing or invalid, place after the latest committed entry but before work

Why current differs from history: a live assistant response after a user prompt is expected to appear below the prompt. We must not "fix" the bug by moving all semantic content above user input.

Expected shape:

```text
entry: user: new prompt
semantic-current: assistant response to new prompt
work: responding
```

### 4. Work

Work is a phase item, not a transcript item.

First-pass rule:

- place work after the latest renderable content item for the active phase
- do not let work be the only reason a stale semantic-history row stays below a newer prompt

This preserves current UX:

```text
entry: user prompt
semantic-current: live response
work: awaiting-tool
```

and also:

```text
semantic-history: older bridge
entry: user prompt
work: responding
```

### 5. Queued Prompts

Queued prompts should also become render-plan items.

First-pass placement:

- queued prompts remain after all feed content and work because they are "about to happen", not committed transcript rows
- when the authoritative user row arrives, the queued item disappears and the committed entry item takes over

But after handoff, the committed entry must be ordered against semantic history by timestamp. That is the part PR #252 did not and could not solve.

### 6. Empty

If no committed, semantic, queued, or work item exists, return one `empty` item.

If only work exists, return:

```text
empty
work
```

This preserves the current empty-feed behavior without a special JSX branch.

## Selector Shape

Replace the bucket-style model with a plan-style model:

```ts
type FeedRenderModel = {
  items: FeedRenderItem[]
  visibleDecisions: VisibleDecision[]
  hasSemanticStreaming: boolean
  debugRows: DebugVisibleRow[]
}
```

For migration, keep compatibility fields temporarily:

```ts
type FeedRenderModel = {
  items: FeedRenderItem[]

  // Temporary compatibility. Delete after Feed renders only items.
  visibleEntries: Entry[]
  renderedSemanticHistory: SemanticLiveTurn[]
  renderedSemanticTurn: SemanticLiveTurn | null
  shouldShowWorkIndicator: boolean

  visibleDecisions: VisibleDecision[]
  hasSemanticStreaming: boolean
  debugRows: DebugVisibleRow[]
}
```

This lets tests migrate before JSX does.

## Rendering Shape

`Feed.tsx` should render:

```tsx
{renderModel.items.map(item => {
  switch (item.type) {
    case 'entry':
      return <EntryRow entry={item.entry} />
    case 'semantic-history':
    case 'semantic-current':
      return (
        <SemanticStreamingTurn
          turn={item.turn}
          committedAssistantText={item.committedAssistantText}
        />
      )
    case 'work':
      return <WorkIndicator ... />
    case 'queued-prompt':
      return <QueuedPromptRow queuedMessage={item.queuedMessage} />
    case 'empty':
      return <EmptyFeed provider={item.provider} />
  }
})}
```

`QueueStrip` can remain as a component, but it should be mounted by a render item inside the feed plan, not by `TileLeaf` after `Feed`.

Why: if queue stays outside Feed, we still have two render owners deciding visual order.

## Debug Logging

`debugRows` must be derived from `items`, not from old buckets.

Current useful debug shape:

```json
{
  "slot": "semantic",
  "label": "semantic history resp_033ca5d · proxy"
}
```

New debug shape should include order evidence:

```json
{
  "slot": "semantic-history",
  "label": "semantic history resp_033ca5d · proxy",
  "order": {
    "sequence": 42,
    "timeMs": 1779289686118,
    "source": "semantic-history"
  }
}
```

When this bug reappears, the bundle should answer:

- did the prompt exist?
- what item type owned it?
- what items rendered below it?
- why were those items below it?
- what timestamp or fallback sequence decided that order?

## Migration Steps

### Step 1: Add Item Types

Add `FeedRenderItem` types near `renderModel.ts`.

Keep the current return fields. Add `items` beside them.

Acceptance:

- existing tests pass
- a new test can assert item order without depending on JSX

### Step 2: Build Plan From Current Buckets

Inside `deriveFeedRenderModel`:

1. derive committed projection exactly as today
2. derive renderable semantic history/current exactly as today
3. convert each visible owner into a `FeedRenderItem`
4. sort items centrally
5. derive `debugRows` from `items`

Acceptance:

- the previous `debugRows.map(row => row.slot)` compatibility tests still pass where expected
- new tests prove stale semantic history can move before a newer user prompt

### Step 3: Move Work Into The Plan

Stop appending work debug rows separately. Work becomes a real `FeedWorkItem`.

Acceptance:

- empty feed plus submitting/requesting still renders empty + work
- non-empty active feed still renders work at the tail

### Step 4: Move Queue Into The Plan

Pass `queuedMessages` into `Feed` or a render-model input.

Remove direct `QueueStrip` rendering from `TileLeaf` once `Feed` owns queued prompt items.

Acceptance:

- queued prompt remains visible at bottom while semantic history/current is active
- after queued prompt reconciles to a committed user entry, stale semantic history does not move below the committed prompt

### Step 5: Delete Compatibility Buckets From JSX

Once `Feed.tsx` renders only `items`, remove direct maps over:

- `visible`
- `renderedSemanticHistory`
- `renderedSemanticTurn`
- standalone `WorkIndicator`

Acceptance:

- a grep for `renderedSemanticHistory.map` in `Feed.tsx` returns nothing
- a grep for `renderedSemanticTurn != null` in `Feed.tsx` returns nothing
- `TileLeaf` does not render `QueueStrip` after `Feed`

### Step 6: Tighten Debug Bundles

Add saved bundle diagnostics that report:

- last user row index
- item types below last user row
- semantic history turn ids below last user row
- timestamp comparison between those semantic history turns and the user row

Acceptance:

- the next saved debug bundle can classify this bug without custom scripts

## Required Tests

These should become real tests after the temp simulation work is done.

### Stale Semantic History Before New Prompt

Input:

- assistant entry at `15:08:30`
- semantic history ended at `15:08:55`
- user entry at `15:09:00`
- stream phase `responding`

Expected:

```text
entry: assistant
semantic-history: old response
entry: user
work: responding
```

### Live Semantic Current After New Prompt

Input:

- user entry at `15:09:00`
- semantic current started at `15:09:03`
- stream phase `responding`

Expected:

```text
entry: user
semantic-current: live response
work: responding
```

### Queue Handoff

Frame 1:

```text
entry: assistant
semantic-history: old response
work: submitting
queued-prompt: follow-up
```

Frame 2 after authoritative user row:

```text
entry: assistant
semantic-history: old response
entry: user follow-up
work: responding
```

The committed user prompt must not move above the old semantic history just because it changed owners from queue to entry.

### Late Semantic Renderability Race

Frame 1:

```text
entry: optimistic user
work: submitting
```

Frame 2:

```text
semantic-history: old response
entry: optimistic user
work: submitting
```

This covers the case where `shouldQueueOptimisticCodexUserEntry` was false at submit time because semantic history was not renderable yet.

### Placeholder Is Not Prompt

Saved screen tail with `Improve documentation in @filename` must not be interpreted as a submitted prompt.

This belongs in debug-bundle analysis, not core feed rendering, but it matters for diagnosis.

## Implementation Notes

## Read-Only Investigation Addendum

On 2026-05-20 we launched read-only Codex investigations across feed architecture, semantic/proxy flow, saved bundles, vendor Codex source, and prior issue/PR history. The first pass confirmed the shape; the second deeper pass was required to read broadly enough to trust the conclusion.

Deep-pass scope reported by the agents:

- history/issues/tests: `130` targeted files content-touched, `210` files enumerated, `80+` relevant commits, and GitHub issues/PRs `#159`, `#165`, `#167`, `#168`, `#170`, `#171`, `#172`, `#183`, `#184`, `#185`, `#191`, `#239`, `#241`, `#252`
- debug/feed/render bundles: `120` files sampled from `236` relevant files, plus all three latest manual bundles
- renderer/workspace integration: `184` files scanned/read across feed, workspace, providers, shared types, scripts, and docs
- Codex/vendor flow: `140` files read across `packages/codex-headless`, `src/providers/codex`, `src/renderer/src/workspace/codex`, semantic reducer, vendor `codex-rs`, and docs

The deeper pass did not find a counterexample to the single-plan fix. It sharpened the risks and the debug requirements below.

### Tests Currently Prove The Wrong Boundary

The old script-based regression coverage did not assert the final visual-order
invariant. One removed case from `scripts/test-feed-render-model.ts` explicitly
expected the bad bucket order:

```text
entry
semantic
work
```

That test was useful as a warning that submit ownership must avoid the entry plane, but it cannot catch the actual bug once a prompt is already in the entry plane. The new tests must assert `items` order, not old `debugRows` bucket order.

Required replacement assertion:

```text
semantic-history
entry:user
work
```

for a semantic history turn whose `endedAt` predates the user entry timestamp.

### Ownership Must Run Before Ordering

Do not implement this as "throw everything into one array and sort by timestamp." That would be wrong.

The pipeline must be:

1. derive committed visibility
2. derive semantic renderability using current text/tool ownership rules
3. suppress duplicates and committed-owned semantic units
4. only then order the surviving render items

Why: Codex proxy, rollout, and committed rows often do not share one stable id. The existing `semanticTurnHasRenderableContent`, committed assistant text normalization, and committed tool-use/tool-result indices are still the safety rail that prevents duplicate bottom rows and gaps.

### Timestamp Trust Level

Use timestamps carefully:

- committed entry `timestamp` is the durable producer timestamp and is the right clock for committed/optimistic row ordering
- semantic `startedAt` / `endedAt` are local receipt times, but they are still the best available ordering signal for live/history bridge rows
- channel-level `ts` values are receipt diagnostics, not durable transcript order

The first-pass plan should therefore use timestamps for relative placement only after ownership filtering has already selected the visible surfaces.

### LazyEntry Migration Risk

`LazyEntry` is entry-only. After `Feed.tsx` renders mixed `FeedRenderItem[]`, eager/lazy calculation must use the entry ordinal among entry items, not the overall item index.

Wrong:

```ts
const eager = itemIndex >= items.length - EAGER_TAIL
```

Right shape:

```ts
const eager = entryOrdinal >= visibleEntryCount - EAGER_TAIL
```

Otherwise semantic/work/queue items near the tail can accidentally make committed entries lazy when they should mount eagerly.

### Queue Is A Second Visual Owner

`QueueStrip` rendering outside `Feed` is part of the ownership bug. It is fine as a temporary compatibility surface, but the final state must move queued prompts into `FeedRenderItem[]`.

The queue handoff test is non-negotiable:

```text
frame 1:
semantic-history: old turn
work: submitting
queued-prompt: follow-up

frame 2:
semantic-history: old turn
entry:user follow-up
work: responding
```

The committed prompt must not jump above stale semantic history just because it changed owner from queue to entry.

### Vendor Codex Confirms This Is A Renderer Ordering Problem

Upstream Codex itself does not expose one append-only UI row stream. It separates provider events, transient TUI state, queued/pending input, durable rollout items, and turn completion. User input while a turn is running may be a pending steer or queued follow-up before it becomes committed history.

Implication: Feed should not try to become a proxy/rollout healer. Feed should consume normalized owners:

- committed entries
- semantic current/history bridge
- queued prompt state
- work phase

and decide their final visual order once.

Upstream guarantees and non-guarantees that matter:

- user prompts become `ResponseItem::Message { role: "user", content }`, often without an item id, end-turn marker, or phase
- pending follow-up input can be held while a turn is active and drained after the turn finishes
- TUI placeholders/previews such as pending input preview are UI state, not durable rollout identity
- rollout durable entries are `session_meta`, `response_item`, `compacted`, `turn_context`, and `event_msg`
- proxy semantic response ids (`resp_*`) often do not match committed rollout turn ids, so text/tool ownership suppression remains necessary
- tool/MCP outputs can span Responses turns, so semantic turn replacement rules cannot be simplified to "same response id only"
- rollout envelope timestamps are durable producer timestamps; semantic `startedAt`/`endedAt` are local live bridge timing; channel `ts` is diagnostic receipt time

This means `FeedRenderItem` should order already-normalized owners. It should not parse screen text, infer Codex rollout tails, or heal proxy/rollout identity mismatches.

### Debug Bundle Gap

Save Debug Logs already captures enough raw data to reconstruct the problem: `feed-debug.jsonl`, `proxy-semantic.json`, `render-diagnostics.json`, screen tail, and HTML. The missing piece is a direct summary of render-order symptoms.

Add a future diagnostic derived from `FeedRenderItem[]`:

- last non-tool user item index
- item types below it
- semantic history turn ids below it
- timestamp comparison between those semantic history turns and the user item
- whether the pane tail is a placeholder/suggestion rather than a submitted prompt

This would have classified the 14:00 and 15:09 bundles immediately as "prompt present but buried by stale semantic/work rows."

The deep debug pass found these concrete missing fields:

- per-row item type, source, `order.sequence`, and `order.timeMs`
- committed user-row diagnostics in `render-diagnostics.json`, not only assistant/semantic ownership
- ghost predicate evidence for `g-resp_*` rows: superseded, orphaned, semantic-owned, newer-than-jsonl-tail, sidecar-shaped
- per-row DOM attributes such as `data-feed-render-key` and `data-feed-render-type`
- hidden/suppressed candidate evidence beyond the current last-12 cap
- persisted feed-debug tail larger than the renderer in-memory 500 cap, or at least `firstId` / `lastId` metadata proving what was omitted

The RENDER event should eventually log the final `FeedRenderItem[]` projection rather than a lossy `DebugVisibleRow[]` built from old buckets.

### Scroll And Lazy Rendering Risks

The renderer integration pass found two migration risks that are easy to miss:

- Autoscroll currently keys off entry count plus semantic fingerprints. Once the feed renders mixed `items`, scroll pinning should key off an item-list tail signature, not just `entries.length`.
- Lazy mounting is entry-heavy today. If `items` includes semantic/work/queue rows, lazy/eager decisions must avoid making tail entries lazy just because non-entry items share the tail region.

The first implementation should keep `LazyEntry` entry-only, but compute eager state from final item position and/or entry ordinal deliberately. Do not accidentally reuse the old `visible.length` logic after `visible` stops being the rendered row list.

### Work Hint Risk

`WorkIndicator` is correctly phase-owned, but its tool hint currently depends on the rendered current semantic turn. If the current semantic turn is suppressed while still carrying the pending tool block, a naive item migration could keep the work item but lose the hint.

The work item should carry the hint inputs explicitly:

- phase
- pending tool name
- pending tool use id
- semantic turn used for hint lookup, even if that semantic turn does not render as a semantic text row

That preserves the "work is independent from semantic text" invariant without losing useful tool context.

### Closure Checklist From Deep History Pass

Do not close `#172` again until all of these are true:

- `deriveFeedRenderModel` returns one ordered `items: FeedRenderItem[]`
- `Feed.tsx` renders exactly one `renderModel.items.map(...)`
- no `renderedSemanticHistory.map` or standalone `renderedSemanticTurn` branch remains in `Feed.tsx`
- `QueueStrip` no longer renders outside `Feed`; queued prompts are render-plan items
- debug rows are derived from the same ordered item list React paints
- tests assert final order for stale semantic history before newer user prompt, live semantic current after prompt, queue handoff, and late semantic renderability race
- bundle diagnostics report last user row, item types below it, semantic ids below it, and timestamp/order reasons
- replaying the known bundle shapes would not place stale semantic/work rows below the newer submitted prompt

### Timestamp Parsing

Use a tiny helper:

```ts
function parseEntryTimeMs(entry: Entry): number | null
```

Do not inline `Date.parse` everywhere. The helper should be explicit about invalid timestamps and fallback sequence.

### Stable Fallback Order

When two items have the same or missing time:

1. lower fallback sequence first
2. entry before semantic-history when both represent the same timestamp
3. semantic-current after the user entry that triggered it
4. work last unless it is the only non-empty surface
5. queue last while it is still queued

### Ownership Before Ordering

Do not use ordering to hide duplicates.

The current duplicate/ownership checks still run first:

- committed assistant text suppresses duplicate semantic text
- committed tool use/result indices suppress duplicate semantic tool rows
- Claude turn id suppression remains Claude-scoped
- Codex exact/normalized text suppression remains semantic-unit scoped

Only after deciding what is renderable should the selector decide where it goes.

### Why Not Just Suppress Older Semantic History?

Because semantic history can still be the only visible representation of an assistant turn while committed catch-up is late. Suppressing it because a later user prompt exists would create a different data loss bug.

The correct move is ordering, not blanket suppression:

```text
semantic-history: old answer
entry: newer prompt
```

not:

```text
entry: newer prompt
```

unless committed entries already own the old answer.

## Done Definition

This work is done when:

- `Feed.tsx` renders one `renderModel.items.map(...)`.
- `TileLeaf.tsx` no longer renders `QueueStrip` as an external visual plane.
- `deriveFeedRenderModel` is the only place that decides relative order among entries, semantic history, semantic current, work, and queue.
- Saved-bundle debug rows are derived from the same item list the JSX renders.
- Tests cover stale semantic history, live semantic current, queue handoff, and late semantic renderability race.
- Replaying the known bundle shapes would not put stale semantic history below the newer user prompt.

## Practical First PR

The first PR should be intentionally boring:

1. Add `FeedRenderItem` types and `items` output.
2. Keep existing JSX untouched.
3. Add tests asserting `items` order for the known failure shapes.
4. Keep old buckets as compatibility fields.

The second PR should switch `Feed.tsx` to render `items`.

The third PR should move `QueueStrip` into the plan and remove the `TileLeaf` external render.

Splitting it this way avoids trying to debug ordering, JSX, lazy mounting, queue reconciliation, and saved-bundle diagnostics all in one diff.
