# Feed Debug Stream And Open Debug Logs Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new `Open Debug Logs` surface to cc-shell that shows, with timestamps, exactly how the feed is being built and why rows appear, disappear, reorder, or get suppressed. The panel must make rendering bugs diagnosable after the fact. Example target: if a user prompt vanishes when the agent starts working, the log should show which state transition removed it, which selector or gate hid it, and what the visible feed list became immediately before and after.

**Architecture:** Reuse the rendering harness's existing FAT debug stream model as the production design. Do **not** add another isolated ad hoc debug panel. Instead:

- create one per-session debug log ring buffer in renderer state
- feed it from the same state transitions that mutate workspace/runtime/feed inputs
- add a dedicated `RENDER` layer that logs feed derivation and visibility decisions
- expose it in a new panel toggled by `Open Debug Logs`

**Tech Stack:** TypeScript, React, Zustand store, existing `window.api.onSessionSemanticEvent` / session screen / process-state subscriptions. No new deps.

---

## Why current debugging is not enough

Today we have two production debug surfaces:

- [DebugPanel.tsx](/Users/juliusolsson/Desktop/Development/cc-shell/src/renderer/src/DebugPanel.tsx:1)
- [ProxyDebugPanel.tsx](/Users/juliusolsson/Desktop/Development/cc-shell/src/renderer/src/ProxyDebugPanel.tsx:1)

They are useful, but they do **not** answer the actual rendering question:

> "Given this state transition, what feed rows did we decide to show, hide, or replace?"

Current problems:

1. `DebugPanel` shows raw state slices, not feed mutations.
2. `ProxyDebugPanel` shows semantic reducer state, not what `Feed` actually rendered.
3. There is no causally ordered log that ties:
   - incoming event
   - reducer mutation
   - selector/visibility decision
   - resulting visible feed rows
4. When something disappears, we currently infer the cause by reading unrelated state fields after the fact.

That is too weak for bugs like:

- user message disappears when assistant turn starts
- live semantic turn duplicates committed tail
- entry is in `runtime.entries` but filtered out of the visible list
- `semanticTurn` exists but is not rendered
- renderer swaps from one row identity to another

The rendering harness already solved this for itself:

- [testing/rendering/renderer/RenderingHarnessApp.tsx](/Users/juliusolsson/Desktop/Development/cc-shell/testing/rendering/renderer/RenderingHarnessApp.tsx:189)
- [testing/rendering/renderer/RenderingHarnessApp.tsx](/Users/juliusolsson/Desktop/Development/cc-shell/testing/rendering/renderer/RenderingHarnessApp.tsx:416)
- [testing/rendering/renderer/RenderingHarnessApp.tsx](/Users/juliusolsson/Desktop/Development/cc-shell/testing/rendering/renderer/RenderingHarnessApp.tsx:1137)

It already has:

- one unified debug stream
- layered events (`JSONL`, `SEM`, `STATE`, `MAP`, `RENDER`)
- timestamps relative to spawn
- tail-locking UI
- copy-last-N / copy-all affordances

We should promote that idea into the main app instead of inventing a parallel system.

---

## Design position

### Principle 1. Log feed derivation, not just raw inputs

Raw semantic and transcript events are necessary but insufficient.

The debug stream must include:

- what changed in runtime/store
- what `Feed` inputs became
- what rows the feed decided to render
- why any candidate rows were excluded

### Principle 2. Log at decision boundaries, not React paint boundaries

Do **not** try to log every React render or every DOM mutation.

That will be:

- noisy
- non-deterministic
- hard to compare
- still not very explanatory

Instead, log at stable semantic boundaries:

- reducer input accepted
- reducer state changed
- feed-visible list derived
- candidate row suppressed by explicit gate

That gives deterministic, high-signal logs.

### Principle 3. Production app should reuse harness concepts

The harness already has the right debug taxonomy.

We should preserve the same layer vocabulary in the app:

- `STATE`
- `JSONL`
- `SEM`
- `MAP`
- `RENDER`

That lets a bug reproduced in the app be compared directly to harness runs.

### Principle 4. Per-session ring buffer, not global append-only log

We care about "what happened in this session's feed."

So:

- keep a log per session id
- cap it in memory
- clear/reset on session restart
- preserve enough history to diagnose a disappearing-row bug

Recommended cap:

- `800` items, same order of magnitude as harness

---

## What the new panel should look like

Add a new command:

- `Open Debug Logs`

Add a new panel component:

- `FeedDebugPanel.tsx`

It should be visually similar to the harness debug stream panel, not to the current raw-state debug panel.

### Header controls

- session id / provider
- log count `visible/total`
- copy last `50`
- copy last `200`
- copy all visible
- layer toggles:
  - `STATE`
  - `JSONL`
  - `SEM`
  - `MAP`
  - `RENDER`

### Row structure

Each log row should include:

- relative timestamp from session start, e.g. `+1423ms`
- layer
- kind
- one-line summary
- expandable payload JSON

### Tail behavior

Mirror the harness:

- tail locked by default
- if user scrolls up, stop auto-jumping

---

## Data model

Add renderer-only debug log types.

Suggested types:

```ts
export type FeedDebugLayer = 'STATE' | 'JSONL' | 'SEM' | 'MAP' | 'RENDER'

export type FeedDebugItem = {
  id: number
  sessionId: string
  tMs: number
  wallTs: number
  layer: FeedDebugLayer
  kind: string
  summary: string
  data?: unknown
}
```

Add per-session runtime fields in renderer state:

```ts
debugLog: FeedDebugItem[]
debugEpochMs: number | null
debugCounter: number
```

Keep it renderer-local. No preload or main-process persistence needed for the first version.

---

## Where to instrument

This is the most important part.

### 1. Session event ingress

File:

- [workspaceStore.ts](/Users/juliusolsson/Desktop/Development/cc-shell/src/renderer/src/tiles/workspaceStore.ts:1966)

Instrument all incoming session event subscriptions:

- `onSessionSemanticEvent`
- screen updates
- process state updates
- jsonl/rollout entry ingestion

Log them into the per-session debug stream using the harness-style layers:

- semantic event => `SEM`
- transcript entry append => `JSONL`
- process/session status flip => `STATE`
- entry-to-feed mapping changes => `MAP`

Important:

- keep text-delta rollup like the harness for noisy delta families
- do not spam one row per token

### 2. Feed input derivation

Files:

- [Feed.tsx](/Users/juliusolsson/Desktop/Development/cc-shell/src/renderer/src/feed/Feed.tsx:1)
- [TileLeaf.tsx](/Users/juliusolsson/Desktop/Development/cc-shell/src/renderer/src/tiles/TileLeaf.tsx:1)
- [workspaceStore.ts](/Users/juliusolsson/Desktop/Development/cc-shell/src/renderer/src/tiles/workspaceStore.ts:1)

This is where the new work needs to happen.

Right now the app does not have one explicit "resolved render list" step.
That is why bugs are hard to explain.

Add a pure helper that derives a feed render model from runtime state.

Suggested shape:

```ts
type FeedRenderItem =
  | { key: string; source: 'entry'; entryId: string; role: string; blockTypes: string[] }
  | { key: string; source: 'semantic'; turnId: string; blockCount: number }
  | { key: string; source: 'streaming-row'; reason: string }
```

Suggested helper:

```ts
function deriveFeedRenderItems(args): {
  items: FeedRenderItem[]
  decisions: Array<{ kind: string; summary: string; data?: unknown }>
}
```

The important part is not the exact type. The important part is:

- one deterministic place computes "what feed rows exist"
- that function also emits structured decision records

### 3. Visibility/suppression decisions

Every explicit feed gate should produce a `RENDER` or `MAP` debug record.

Examples:

- committed entry filtered out of visible set
- `semanticTurn` suppressed because no active turn
- streaming row hidden because committed tail already covers it
- tool_result success stub suppressed because specialized row already rendered
- Codex/Claude provider-specific row substitution

For each such gate, log:

- what candidate was considered
- why it was suppressed
- what visible list was produced after the decision

Example summaries:

- `hide semantic turn: committed tail superseded turn msg_123`
- `drop entry uuid_abc from visible list: compact summary`
- `replace bash/tool_result pair with git row`

### 4. Visible list diffs

This is the key feature for "message disappeared" bugs.

After deriving the visible feed list, diff it against the prior visible list for that session.

Log only when changed.

Suggested diff payload:

```ts
{
  before: ['entry:user:uuid1', 'semantic:msg_1'],
  after: ['entry:user:uuid1', 'entry:assistant:uuid2'],
  added: ['entry:assistant:uuid2'],
  removed: ['semantic:msg_1'],
  moved: []
}
```

This should be a `RENDER` event with a summary like:

- `visible feed changed: +1 -1`

That one line plus expandable payload is the thing that will catch disappearing rows.

### 5. Row identity keys

Part of the payload for every visible-list log should include each row key.

That lets us catch bugs caused by:

- unstable keys
- row replacement when we expected row mutation
- provider-specific component switching

---

## Recommended implementation structure

## Task 1. Add a renderer debug log slice

**Files:**
- `src/renderer/src/tiles/workspaceState.ts`
- `src/renderer/src/tiles/workspaceStore.ts`

- [ ] Add per-session debug log storage.
- [ ] Add helper:
  - `pushFeedDebug(sessionId, item)`
- [ ] Cap at `800` items per session.
- [ ] Reset epoch/counter when a new session is spawned or resumed into a fresh runtime.

**Success criteria:**
- Any renderer/store code can append a causally ordered debug item for a session.

## Task 2. Promote the harness debug item model into shared renderer code

**Files:**
- `testing/rendering/renderer/RenderingHarnessApp.tsx`
- new shared file in `src/renderer/src/features/debug/`

- [ ] Extract or mirror the harness debug item type and formatting helpers.
- [ ] Reuse the layer vocabulary and copy behavior.
- [ ] Do not duplicate formatter logic in two places if a small shared util works.

**Success criteria:**
- Production panel and harness panel speak the same debug language.

## Task 3. Instrument session ingress

**Files:**
- `src/renderer/src/tiles/workspaceStore.ts`

- [ ] Log semantic event ingress.
- [ ] Log transcript entry ingress.
- [ ] Log process/session-status ingress.
- [ ] Roll up noisy delta families exactly like the harness.

**Success criteria:**
- You can see the ordered raw causes before any feed derivation.

## Task 4. Add explicit feed render derivation helper

**Files:**
- `src/renderer/src/feed/Feed.tsx`
- or a new helper file near `feed/`

- [ ] Extract "what rows are visible" into one pure helper.
- [ ] Return:
  - resolved visible items
  - debug decisions
- [ ] Stop burying key visibility choices inside JSX branches without logging.

**Success criteria:**
- There is one deterministic place to ask: "what did the feed decide to render?"

## Task 5. Log suppression and replacement decisions

**Files:**
- `src/renderer/src/feed/Feed.tsx`
- provider row files where replacements happen

- [ ] Log all important suppression paths:
  - semantic turn hidden
  - entry filtered
  - specialized row replaces generic row
  - success result stub suppressed
  - streaming row hidden because committed state superseded it

**Success criteria:**
- Every surprising disappearance has a matching `RENDER` or `MAP` line.

## Task 6. Log visible-list diffs

**Files:**
- `src/renderer/src/feed/Feed.tsx`
- or the new feed-derivation helper

- [ ] Keep prior visible list per session.
- [ ] Compute `before/after/added/removed/moved`.
- [ ] Emit only when changed.

**Success criteria:**
- If a user prompt disappears, the log shows the exact transition that removed it.

## Task 7. Add `Open Debug Logs` panel

**Files:**
- new `src/renderer/src/FeedDebugPanel.tsx`
- `src/renderer/src/App.tsx`
- command palette / session commands / shell state files

- [ ] Add a new panel component using the harness-style layout.
- [ ] Add layer toggles and copy actions.
- [ ] Add open/close command:
  - `Open Debug Logs`
- [ ] Keep current `DebugPanel` and `ProxyDebugPanel` intact.

**Success criteria:**
- Production app can inspect the per-session FAT debug stream without the harness.

## Task 8. Add “focus on render diffs” filters

**Files:**
- `FeedDebugPanel.tsx`

- [ ] Add quick filters:
  - `show only RENDER`
  - `show only changes`
  - `show only removals`

These are optional but high leverage for the exact class of bugs the user is hitting.

**Success criteria:**
- A disappearing-row bug can be narrowed in seconds instead of scanning everything.

## Task 9. Wire a “snapshot now” export

**Files:**
- panel component
- maybe preload if later persisted

- [ ] Add copy/export of:
  - current visible feed model
  - last `200` debug items
  - current runtime semantic summary

This is for sending bug reports or pasting into the agent.

**Success criteria:**
- One click produces enough data to reason about the bug offline.

## Task 10. Validate against known bad cases

**Files:**
- rendering harness
- real app

- [ ] Reproduce:
  - user message disappears when agent starts
  - semantic row duplicates committed reply
  - semantic row exists but is hidden
  - feed row key changes unexpectedly
- [ ] Confirm logs identify:
  - triggering input event
  - reducer/state change
  - visible-list diff
  - suppression reason

**Success criteria:**
- We can debug rendering bugs from the log without guessing from raw state.

---

## Logging examples

These are the kinds of lines we want.

### Example 1. User message disappears

```text
+1240ms  JSONL  entry_appended       assistant uuid=abc text=42 chars
+1242ms  STATE  runtime_entries      entries 17 -> 18
+1244ms  RENDER candidate_rows       3 candidates [entry:user:u1, semantic:msg_9, entry:assistant:abc]
+1244ms  RENDER suppress_semantic    hide semantic:msg_9 because committed tail superseded turn
+1244ms  RENDER visible_diff         before=[entry:user:u1, semantic:msg_9] after=[entry:user:u1, entry:assistant:abc] added=[entry:assistant:abc] removed=[semantic:msg_9]
```

### Example 2. User row disappears incorrectly

```text
+2310ms  STATE  semantic_turn_start  turn=msg_10
+2311ms  RENDER candidate_rows       2 candidates [entry:user:u2, semantic:msg_10]
+2311ms  RENDER visible_diff         before=[entry:user:u2] after=[semantic:msg_10] removed=[entry:user:u2]
+2311ms  RENDER warning              user row removed while no committed assistant row exists
```

That last warning is worth adding as an explicit invariant check.

---

## Optional invariant warnings

These are not blockers for MVP but are very valuable.

Emit warning-level `RENDER` log items when:

- a user row disappears while no assistant replacement row exists
- a committed assistant row and semantic turn both render the same turn simultaneously
- row keys change but underlying source ids did not
- visible list shrinks during a semantic delta without an explicit suppression reason

These warnings will surface classes of bugs even before the user notices them.

---

## Recommended implementation order

1. Renderer debug log slice
2. Session ingress logging
3. Feed render derivation helper
4. Visible-list diff logging
5. `FeedDebugPanel`
6. Layer filters and copy/export
7. Invariant warnings
8. Validation with known repros

---

## Non-goals

- Persisting logs to disk
- Shipping logs over IPC to main
- Replacing the current `DebugPanel` or `ProxyDebugPanel`
- Logging raw React commit lifecycle
- Fixing the rendering bugs themselves in this plan

---

## Expected payoff

If implemented correctly:

- rendering bugs stop being "something weird happened"
- every disappearance/replacement has a timestamped causal chain
- bug reports become copy-pasteable
- the production app and rendering harness use the same debug language
- we can finally debug feed behavior instead of inferring it from unrelated state snapshots
