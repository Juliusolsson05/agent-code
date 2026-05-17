# Feed UI Rendering: Current Model and First-Principles Target

This note describes the renderer as it exists in the production Feed path:

- `src/renderer/src/features/feed/ui/Feed.tsx`
- `src/renderer/src/features/feed/ui/semantic/*`
- `src/renderer/src/features/feed/ui/rows/*`
- `src/renderer/src/features/feed/WorkIndicator.tsx`
- `src/renderer/src/features/feed/ui/markdown/*`
- `src/renderer/src/features/feed/scroll.ts`

The key finding: Feed already has many local duplicate guards, but it does not yet have one explicit, first-principles “visible render units” owner. React currently receives committed transcript entries, archived semantic turns, the current semantic turn, and a work indicator as adjacent JSX branches. That split is workable but makes duplicate and missing-row behavior depend on scattered suppression rules.

## Current Top-Level Render Order

`Feed` renders in this order:

1. Build `visibleDecisions` from `entries`.
2. Build tool indices from all entries:
   - `toolUseIndex`: `tool_use.id -> ToolUseBlock`
   - `toolResultIndex`: `tool_use_id -> ToolResultBlock`
3. Filter archived semantic turns at turn level for Claude only.
4. Render committed visible entries.
5. Render archived semantic history turns.
6. Render the current semantic turn.
7. Render `WorkIndicator`.
8. Render the bottom sentinel.

The JSX order in the non-empty branch is:

```tsx
visible.map(entry => (
  <div key={entry.uuid ?? `i${i}`}>
    <LazyEntry>
      <EntryRow entry={entry} />
    </LazyEntry>
  </div>
))

renderedSemanticHistory.map(turn => (
  <SemanticStreamingTurn
    key={`semantic-history:${turn.turnId}`}
    turn={turn}
    committedEntries={entries}
  />
))

renderedSemanticTurn != null && (
  <SemanticStreamingTurn
    turn={renderedSemanticTurn}
    committedEntries={entries}
  />
)

<WorkIndicator ... />
<div ref={endRef} />
```

The empty branch is separate: when there are no visible committed entries and no semantic streaming, Feed returns a centered `waiting for ...` placeholder plus a bottom `WorkIndicator` if `streamPhase !== 'idle'`.

## Current Keys

Committed entry rows use:

- Wrapper key: `entry.uuid ?? i${visibleIndex}`.
- Debug row key: `entry:${debugKeyForEntry(entry, index)}` where `debugKeyForEntry` prefers `entry.uuid`, then falls back to `${entry.type}:${index}`.
- Multi-block committed content keys: block array index inside `ConversationRow`.

Semantic rows use:

- Archived turn JSX key: `semantic-history:${turn.turnId}`.
- Current turn JSX has no explicit key because it is a single conditional child.
- Semantic render-unit keys:
  - Collapsed activity: `collapsed:${unit.blockIndices.join(',')}`.
  - Block row: `unit.block.blockIndex`.

Work indicator debug key is `work:${streamPhase}:${streamPhasePendingToolUseId ?? 'none'}`. Its JSX has no explicit key because it is a fixed final child.

The riskiest key is committed fallback `i${visibleIndex}`. It is acceptable only when entries without UUIDs are truly stable synthetic rows. If an older-history prepend or visibility filter shifts an un-UUIDed entry, React can reuse the wrong subtree. The code mostly relies on real transcript entries having UUIDs.

## Current Committed Row Dispatch

`EntryRow` dispatches:

- `compact_boundary` -> `CompactBoundaryRow`
- `compact_summary` -> `CompactSummaryRow`
- conversation entries -> `ConversationRow`
- everything else -> `SystemRow`

`ConversationRow` dispatches:

- string content:
  - user -> `UserBand` + `MarkerRow("❯")` + `TextProse`
  - assistant -> `MarkerRow("⏺")` + `TextProse`
- array content:
  - each block -> `Block key={i}`

`Block` dispatches:

- `text`:
  - user role -> `UserBand` + `MarkerRow("❯")` + `TextProse`
  - assistant role -> `MarkerRow("⏺")` + `TextProse`
- `thinking`:
  - empty -> `null`
  - non-empty -> muted expandable details row
- `image` -> `ImageBlockRow`
- `tool_use`:
  - optional git custom widget on the tool-use row
  - Codex `apply_patch` -> `CodexApplyPatchRow`
  - other Codex -> `CodexToolRow`
  - Claude `Edit`, `MultiEdit`, `Write`, `TodoWrite` -> rich rows
  - fallback -> `ToolUseRow`
- `tool_result`:
  - optional git result suppression
  - Codex -> `CodexToolResultRow`
  - Claude/fallback -> `ToolResultRow`
- unknown block type -> muted type label

Important user-role rule: `ConversationRow` does not wrap a whole user-role array message in `UserBand`. Tool results arrive in user-role messages, so only text blocks get the user prompt band.

## Current Semantic Row Dispatch

`SemanticStreamingTurn` does not dump `turn.text` when blocks exist. It sorts `turn.blocks` by `blockIndex`, builds semantic render units, then renders either:

- `SemanticCollapsedActivityRow`
- `SemanticLiveBlockRow`

If there are no blocks:

- `turn.text === ''` -> `null`
- `turn.text` duplicates committed assistant text -> `null`
- otherwise -> `MarkerRow("⏺")` + `StreamingProse`

Compaction synthesis is a special turn-level override: render a muted `Compacting conversation...` placeholder instead of raw XML-like model output.

`buildSemanticRenderUnits` currently:

- Sorts blocks by `blockIndex`.
- Drops finalized/completed semantic text/message blocks that match committed assistant text.
- Drops live tool blocks whose `toolUseId` or `callId` already exists in the committed tool-use index.
- Drops associated output blocks when their `callId` is committed.
- Collapses runs of low-signal searchable/read/list/bash tool-use blocks into one `collapsed_activity` unit.
- Flushes collapsed runs before non-collapsible blocks.

`SemanticLiveBlockRow` then renders block kinds directly:

- thinking/reasoning:
  - empty -> `null`
  - non-empty -> muted expandable details
- function/custom calls -> tool name + argument JSON + parse error
- function/custom/tool-search outputs -> `⎿` pre output
- web search, image generation, local shell, tool search -> compact status rows
- Claude-like tool_use/server/mcp tool_use -> tool input, TodoWrite preview, live Write preview, parse error, optional result
- text with an open streaming code fence -> prose + Monaco code block
- text with citations -> prose + citation count
- plain text -> `StreamingProse`

## Current Markdown Rules

There are two prose renderers:

- `TextProse`: committed JSONL text, `remark-gfm`.
- `StreamingProse`: live text, `remark-gfm + remark-breaks`.

The split matters because committed transcript text is treated as real markdown, while streaming text may be screen-derived plain text where single newlines are visual line breaks.

Both use shared `MARKDOWN_COMPONENTS`:

- `<pre>` wrapper is stripped.
- inline code stays a plain `<code>`.
- fenced or multi-line code renders through static `CodeBlock`.

Live semantic text has one extra path before markdown: if the text has an odd number of triple-backtick fences, `splitStreamingCodeFence` pulls out the open fence and renders the partial code with a Monaco `CodeBlock`. Closed fences go through normal markdown.

## Current Lazy Mounting and Scroll

Committed entries are wrapped in `LazyEntry`.

- Last `EAGER_TAIL = 30` visible entries mount immediately.
- Older entries start as `min-h-[48px]` placeholders.
- IntersectionObserver mounts older rows when they approach the scroll viewport.
- Once mounted, they never unmount.
- During bootstrap, observer attachment is suspended to avoid mounting many rows during replay.

Feed owns the scroll container and keeps per-session scroll state in a module-level `scrollPositions` map. It restores scroll synchronously in `useLayoutEffect`:

- no saved position -> bottom
- saved sticky bottom -> new bottom
- saved non-sticky -> exact saved `scrollTop`

Auto-scroll happens only when `tailMode` is enabled or `stickyBottomRef.current` is true. Sticky bottom is broken immediately on real upward scroll, not only after the user escapes the 48px near-bottom band.

Content-growth effects listen to:

- `entries.length`
- semantic current-turn signal
- semantic history signal
- bootstrap transition
- explicit `scrollToLatestRequest`

This scroll model is mostly independent of row ownership, but lazy placeholders can hide render bugs: a missing row above the eager tail may not be realized until the user scrolls enough to mount it.

## Current Suppression Rules

Entry-level suppression in `Feed`:

- compact boundary and compact summary are always visible.
- non-conversation entries are hidden by default.
- conversation entries with `isMeta === true` are hidden.
- ordinary conversation entries are visible.

Archived semantic turn suppression:

- Claude-only turn-level suppression: if a committed entry message id equals an archived semantic turn id, drop that archived turn.
- Codex intentionally does not use whole-turn suppression because one committed response item can share a Codex turn id while other live blocks from that turn still need to bridge JSONL lag.

Semantic block suppression:

- finalized/completed semantic text/message blocks are dropped if their `(turnId, text)` key or exact `text` exists in committed assistant text.
- semantic tool-use/call blocks are dropped if `toolUseId` or `callId` is in the committed tool-use index.
- semantic output blocks are also dropped if their `callId` is in the committed tool-use index.
- empty no-block semantic turns render `null`.
- compaction synthesis replaces all raw blocks with a placeholder.

Committed block suppression:

- committed empty thinking renders `null`.
- `ToolResultRow` suppresses non-error results for `Edit`, `MultiEdit`, `Write`, and `TodoWrite`.
- `ToolResultRow` summarizes Read output instead of dumping bytes.
- git custom rendering consumes output on the tool-use row and suppresses the paired tool-result row.
- `SemanticCollapsedActivityRow` returns `null` while its collapsed group is still running; WorkIndicator carries the active signal.

Work indicator suppression:

- `phase === 'idle'` -> `null`
- unknown/null phase label -> `null`
- otherwise always rendered, independent of semantic turn presence.

## Where Duplicates Arise

The structural duplicate risk is that there are two live-ish surfaces after the committed rows:

- `renderedSemanticHistory`
- `renderedSemanticTurn`

Both are rendered after all committed entries, not interleaved at the location where their durable entry will eventually land. That means any missed suppression appears as a bottom-of-feed duplicate, even if the committed owner is already above.

Known duplicate classes:

1. Committed assistant text plus live/archived semantic text.
   - Current guard: exact committed text set, plus `(turnId, text)` keys.
   - Weakness: exact-string matching only. It is intentionally conservative, but any normalization difference leaves both rows visible.

2. Committed tool rows plus live semantic tool blocks.
   - Current guard: committed tool-use index by `toolUseId` / `callId`.
   - Weakness: if ids are missing, rewritten, or provider-specific mapping is late, both render.

3. Committed tool result plus live semantic output.
   - Current guard: output block `callId` matching committed tool-use index.
   - Weakness: output blocks without stable call correlation cannot be owned safely.

4. Archived semantic turn plus current semantic turn with the same content but different ids.
   - Current history helper replaces by equal `turnId`, but cannot dedupe semantically identical turns with different ids.

5. Git custom rendering.
   - Tool-use row renders command + output from `toolResultIndex`; tool-result row must suppress. If the detect/extract path differs between the two branches, the card and raw output can both render.

6. React key reuse.
   - Entries without UUIDs use visible index fallback. If order shifts, React may retain a mounted subtree for a different entry. This presents like a duplicate or stale row even when the data list is correct.

## Where Missing Rows Arise

Missing rows are mostly caused by suppression operating before ownership is fully known.

1. Codex whole-turn suppression would be too broad.
   - The code avoids this at Feed level. A single committed Codex response item must not hide the whole archived semantic turn because later text/tool rows may still be live-only.

2. Exact text suppression can hide a live text block that legitimately repeats committed text.
   - This is rare but possible when an assistant intentionally repeats a sentence in the same active turn. The guard is exact and finalized/completed-only to reduce this blast radius.

3. Tool-id suppression can hide a semantic block if the committed index claims the id but the committed row itself renders `null`.
   - Example: committed result rows for Edit/Write/TodoWrite success intentionally suppress. That is correct if the tool-use row carries the visible content; wrong if the tool-use row is also absent or filtered.

4. Collapsed activity can hide running low-signal tools.
   - `SemanticCollapsedActivityRow` returns `null` while running. This is intentional, but if `WorkIndicator` is idle or lacks a useful hint, the feed can appear to be missing activity.

5. Empty thinking and encrypted reasoning render nothing.
   - This is intentional; WorkIndicator is the visible active signal.

6. `isMeta` conversation entries are hidden wholesale.
   - Correct for task notifications/system reminders, but a misclassified real message would disappear.

7. Lazy mounting defers rows above the eager tail.
   - The row is present as a placeholder, not missing from React's list, but visually it is blank until mounted.

## First-Principles Render Model for React

React should receive exactly one ordered array of render units. Every visible row should have:

- a stable semantic id
- one owner
- one position
- one render component
- explicit suppression reason when omitted

The target shape should be something like:

```ts
type FeedRenderUnit =
  | {
      kind: 'committed-entry'
      id: `entry:${string}`
      owner: 'committed'
      sort: FeedSortKey
      entry: Entry
    }
  | {
      kind: 'semantic-block'
      id: `semantic:${string}:${number}`
      owner: 'semantic-live' | 'semantic-history'
      sort: FeedSortKey
      turnId: string
      block: SemanticLiveBlock
    }
  | {
      kind: 'semantic-collapsed-activity'
      id: `semantic:${string}:collapsed:${string}`
      owner: 'semantic-live' | 'semantic-history'
      sort: FeedSortKey
      unit: CollapsedActivityUnit
    }
  | {
      kind: 'work-indicator'
      id: 'work'
      owner: 'session-phase'
      sort: FeedSortKey
      phase: StreamPhase
    }
```

The render pipeline should be:

1. Normalize committed transcript entries into committed units.
2. Normalize semantic history/current turn into candidate semantic units.
3. Build ownership indices:
   - committed assistant text keys
   - committed assistant text hashes
   - committed tool call ids
   - committed output ids
   - committed turn ids by provider
4. Reconcile candidates into one ordered list:
   - committed units win over semantic units for the same visible artifact
   - semantic current wins over semantic history for the same artifact
   - history bridges only artifacts not yet committed
   - WorkIndicator is a session-phase unit, not a substitute for rows
5. Return both:
   - `visibleUnits`
   - `suppressedUnits` with reason codes for debug
6. React maps `visibleUnits` once.

The rule should be: no renderer component decides whether its sibling should exist. Components can decide their own internal presentation, but ownership and suppression should happen before JSX.

## Target Output Semantics

For React, the first-principles output should be:

- User prompt: one committed text unit with marker `❯`.
- Assistant committed text: one committed text unit with marker `⏺`.
- Assistant live text before commit: one semantic text unit at the tail.
- Assistant live text after commit: semantic text suppressed by committed owner.
- Tool call before commit: one semantic tool unit.
- Tool call after commit: committed tool-use/result units own the artifact; semantic tool units suppressed.
- Low-signal live tool runs: one collapsed semantic activity unit only when it is useful to history; active running state belongs to WorkIndicator.
- Work phase: one final work unit while `streamPhase !== 'idle'`.
- Hidden/system/meta entries: omitted with visible debug reasons, never silently dropped.

Keys should be derived from artifact identity, not array position:

- committed entries: `entry:${entry.uuid}`; entries without UUID need an ingest-time stable synthetic id.
- committed blocks: `entry:${entry.uuid}:block:${blockStableId}`.
- semantic blocks: `semantic:${turnId}:block:${blockIndex}` plus provider call id when available.
- collapsed groups: `semantic:${turnId}:collapsed:${firstBlockIndex}-${lastBlockIndex}`.
- work indicator: fixed `work`.

Ordering should be explicit. Today all semantic content is appended after committed rows, which is acceptable for a live bridge but not a general model. A better sort key is:

- committed transcript order for committed entries
- semantic turn order based on turn start and source order
- semantic blocks by block index inside their turn
- work indicator always last

When a semantic artifact is known to belong to a committed turn, it should reconcile against that committed location before render. If it is not committed yet, it can stay at the tail as a bridge.

## Practical Rewrite Direction

The next render rewrite should extract a pure builder, for example:

```ts
buildFeedRenderPlan({
  entries,
  semanticHistory,
  semanticTurn,
  provider,
  streamPhase,
  toolUseIndex,
  toolResultIndex,
}): {
  visibleUnits: FeedRenderUnit[]
  suppressedUnits: SuppressedRenderUnit[]
}
```

`Feed.tsx` would then own scroll, lazy mounting, contexts, and mapping units to components. It would not own duplicate logic inline.

The debug `renderedRows` array should come from this same render plan, not from a parallel approximation. That prevents the debug layer from saying a row exists while JSX later returns `null`, which is one of the current sources of confusion when diagnosing “missing rows.”

The most important invariant for the new model:

> A user-visible artifact is rendered by exactly one owner. If ownership changes from semantic to committed, the semantic unit is suppressed with a reason before React sees it.

