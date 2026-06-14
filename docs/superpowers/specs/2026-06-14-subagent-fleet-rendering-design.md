# Subagent Fleet Rendering — Design Spec

- **Date:** 2026-06-14
- **Branch:** `feat/subagent-inline-render`
- **Status:** Design — awaiting user review before implementation plan
- **Author:** Agent Code (AI)

---

## 1. Problem

When the main agent spawns subagents via the `Task` tool — including several
**in parallel** (the common case: 4 `Explore` agents fired in one turn) — the
app renders each as a minimal, opaque card:

```
⏺ Task
  Current active-agent showcase surfaces
```

Two questions the operator cannot answer from the UI today:

1. **How many subagents are running at once?** When N `Task` blocks are spawned
   in one turn, you see N separate minimal cards with no concurrency summary,
   no "still running vs done" state, no elapsed time.
2. **What is each one doing?** You see only the `description` and, eventually,
   the final `tool_result`. The subagent's live internal work — its turns, its
   tool calls, its current activity — is invisible.

### Why this is worth building (and cheap to build correctly)

Everything we need is **already written to disk, live, and reliably linked** —
the app simply never reads it. Verified against the live session
`f074404f-.../subagents/` on 2026-06-14:

- Claude Code writes each subagent's **full transcript** to
  `<sessionDir>/subagents/agent-<id>.jsonl`, incrementally as the subagent
  works (file mtimes track activity in real time; sampled files were
  200–340 KB, dozens of turns each).
- Each transcript has a sidecar `agent-<id>.meta.json` carrying the
  **deterministic parent link**:

  ```json
  {"agentType":"Explore",
   "description":"Current active-agent showcase surfaces",
   "toolUseId":"toolu_01KtyHpxD4nnXwuzUVBBCYS1"}
  ```

  `toolUseId` matches the parent `Task` tool_use block's `id` exactly. **No
  heuristic correlation is required** — this is the fact that makes the whole
  feature robust. (Contrast: wire-level correlation via the proxy is
  impossible — every request gets a fresh `x-client-request-id` and the
  internal parent/child `chainId` never leaves the Claude Code process. Disk is
  the source of truth.)
- The subagent entries are standard Claude transcript shape
  (`type: user|assistant`, `message`, `uuid`, `parentUuid`, `isSidechain:true`),
  so the existing `agent-transcript-parser` can read them.

The app currently has **no dedicated renderer** for the `Task` tool at all
(`grep` for `Task`/`subagent` in `feed/ui/rows/Block.tsx` returns nothing — it
falls through to the generic `ToolUseRow`). So there is no existing behavior to
preserve or fight; we are filling a gap, not rewiring a contract.

---

## 2. Goals / Non-goals

### Goals

- **Concurrency at a glance.** Group sibling `Task` blocks spawned in one turn
  into a single live header: how many spawned, how many running, how many done,
  aggregate elapsed.
- **Drill into one.** Expand any subagent row to a **live mini-feed** of its
  tool-call timeline + a current-activity line, sourced from its
  `agent-<id>.jsonl`, updating live as the file grows.
- **Correct attribution.** Link each subagent to its parent `Task` card via
  `meta.toolUseId`. Never show a subagent under the wrong parent.
- **Durable.** Read from disk, so the view survives reload / re-focus, unlike
  the ephemeral proxy stream.

### Non-goals (YAGNI — explicitly out of scope for this PR)

- **No live proxy streaming** of subagent flows (fragile, uncorrelatable; disk
  is better).
- **No full-prose mini-feed by default.** The inline mini-feed shows the
  **tool-call timeline + current activity**, not the subagent's thinking/text.
  A "view full transcript" affordance is allowed as a thin escape hatch but the
  full transcript reader is not the focus.
- **No changes to the orchestration-MCP agents** (separate sessions / dispatch
  lanes — already streamed well, a different feature).
- **No Codex equivalent.** Codex does not spawn `Task` subagents this way; the
  feature is a no-op for Codex sessions.
- **No new persistent test suites** (per repo convention — temporary fixtures
  only; see §11).

---

## 3. Data model & linkage

### On-disk (source of truth, written by Claude Code)

```
<sessionDir>/
  <sessionId>.jsonl                  ← main transcript (already watched)
  subagents/
    agent-a6ec6f72d04aab973.jsonl    ← subagent full transcript (live-appended)
    agent-a6ec6f72d04aab973.meta.json← { agentType, description, toolUseId }
    agent-a156cda8c720cd845.jsonl
    agent-a156cda8c720cd845.meta.json
    ...
```

- **Parent link:** `meta.toolUseId` === the `Task` tool_use block `id` in the
  main transcript.
- **Liveness:** `agent-<id>.jsonl` is append-only and grows while the subagent
  runs. The file's last entry + the presence/absence of a matching
  `tool_result` in the parent transcript determine running-vs-done.

### Derived runtime state (new)

```ts
// One per spawned subagent, keyed by parent Task tool_use id.
type SubAgentState = {
  toolUseId: string            // links to the parent Task block (meta.toolUseId)
  agentId: string              // the agent-<id> filename id
  agentType: string            // meta.agentType, e.g. "Explore" | "general-purpose"
  description: string          // meta.description (the card headline)
  status: 'running' | 'done' | 'error'
  startedAt: number | null     // first entry ts
  lastActivityAt: number | null// last entry ts (drives elapsed + "live" pulse)
  turnCount: number            // assistant turns observed
  toolCalls: SubAgentToolCall[]// ordered tool-call timeline (capped, see §6)
  currentActivity: string | null // derived label: "running Grep", "thinking", …
}

type SubAgentToolCall = {
  name: string                 // "Read" | "Bash" | "Grep" | …
  headline: string | null      // first meaningful arg (path/command/pattern/query)
  status: 'running' | 'done'   // done once a tool_result for it appears
}
```

Stored on the per-session runtime:

```ts
// workspaceState.ts — SessionRuntime
subAgents: Record<string /* toolUseId */, SubAgentState>
```

Status is determined as:
- `running` — subagent file exists and the **parent** transcript has no
  `tool_result` block for this `toolUseId` yet.
- `done` — a `tool_result` for this `toolUseId` exists in the parent transcript.
- `error` — the `tool_result` is an error, or the file ends abnormally.

---

## 4. Architecture / data flow

```
 ┌─────────────────────────── main process ───────────────────────────┐
 │                                                                     │
 │  existing session-transcript watcher (sets transcriptStatus,        │
 │  streams entries for the main .jsonl)                               │
 │                          │                                          │
 │                          ├─ NEW: sibling watcher on subagents/      │
 │                          │     • on add/change of agent-<id>.jsonl  │
 │                          │       + meta.json                        │
 │                          │     • incremental parse via              │
 │                          │       agent-transcript-parser            │
 │                          │     • build/refresh SubAgentState        │
 │                          ▼                                          │
 │                   subAgentsForSession(sessionId): SubAgentState[]   │
 │                          │ IPC (same channel pattern as runtime)    │
 └──────────────────────────┼──────────────────────────────────────────┘
                            ▼
 ┌────────────────────── renderer ──────────────────────────────────┐
 │  SessionRuntime.subAgents: Record<toolUseId, SubAgentState>        │
 │                          │                                         │
 │  Feed render model: detect runs of sibling Task tool_use blocks    │
 │  → emit a "subagent group" render item                            │
 │                          │                                         │
 │  <SubAgentGroupRow>  (concurrency header)                          │
 │     └─ <SubAgentRow> × N  (per Task; looks up subAgents[block.id]) │
 │            └─ expanded: <SubAgentMiniFeed> (tool-call timeline)    │
 └────────────────────────────────────────────────────────────────────┘
```

Key principle: **the renderer never reads files.** It consumes
`runtime.subAgents` exactly like every other live field (`streamPhase`,
`ghosts`, …). All disk work is in the main process.

---

## 5. UI design (ASCII)

Status glyphs reuse the existing dispatch-activity vocabulary:
`◐` running (green), `✓` done, `✗` error (red), `⏸` queued.

### 5a. Collapsed — multiple subagents spawned in one turn (the common case)

The N sibling `Task` cards collapse into one live group header with per-agent
rows. Header shows the live tally + aggregate elapsed.

```
⏺ Spawned 4 agents              ◐ 2 running · ✓ 2 done · 1m48s   [collapse ▾]
  ├ ◐ Explore   Render integration points for nested feed        12 tools · 0:42
  ├ ◐ Explore   Sub-agent flow correlation feasibility            8 tools · 0:39
  ├ ✓ Explore   Current active-agent showcase surfaces           25 tools · done
  └ ✓ general   Review agent-code PR #265                              done
```

- Left glyph = per-subagent status (live).
- `agentType` shown dimmed before the description.
- Right column: live tool-call count + elapsed (running) or `done`.
- Each row is clickable to expand (§5c).

### 5b. Collapsed — a single subagent (degrades gracefully)

When only one `Task` is spawned, there is no group header — just the richer
single card:

```
⏺ Explore   Current active-agent showcase surfaces      ◐ 12 tools · 0:42  [▸]
```

When done:

```
⏺ Explore   Current active-agent showcase surfaces      ✓ 25 tools · 1m12s [▸]
```

### 5c. Expanded — drill into one subagent (the live mini-feed)

Expanding a row reveals its tool-call timeline + current-activity line, indented
under the row with a left rail. This is the "what is it doing right now" view.

```
  └ ▾ ◐ Explore  Render integration points for nested feed       12 tools · 0:42
        ⏺ Read   src/renderer/.../feed/ui/rows/Block.tsx
        ⏺ Grep   "tool_use"                                        18 matches
        ⏺ Read   src/renderer/.../feed/model/renderModel.ts
        ⏺ Read   src/renderer/.../workspace/workspaceState.ts
        ◐ analyzing render model…                       ← current-activity line
        ────────────────────────────────────────────────
        view full transcript ▸                          ← thin escape hatch
```

When the subagent finishes, the current-activity line resolves and the card can
re-collapse to its `✓` summary; the final `tool_result` continues to render
where it already does (unchanged).

```
  └ ▾ ✓ Explore  Render integration points for nested feed       18 tools · 1m04s
        ⏺ Read   src/renderer/.../feed/ui/rows/Block.tsx
        …
        ⏺ Read   src/renderer/.../workspace/workspaceState.ts
        ✓ returned — 6 integration points, 1 obstacle
        ────────────────────────────────────────────────
        view full transcript ▸
```

### 5d. Error / killed

```
  ├ ✗ Explore   Audit debug panel + PTY resolution        ✗ failed · 0:08
```

Expanding shows the partial timeline + the error reason from the `tool_result`.

### 5e. Live-update behavior

- The group header tally (`◐ 2 running · ✓ 2 done`) and per-row tool counts /
  elapsed tick live as the watcher pushes state.
- Newly-appearing tool calls append to an expanded mini-feed in place (no
  scroll jump — append below, like the main feed's streaming).
- A subagent transitioning running→done flips its glyph and freezes its elapsed.

---

## 6. Bounds & performance

Subagent transcripts can be large (300 KB+, dozens of turns). Guardrails:

- **Incremental parse:** the watcher tracks a byte offset per `agent-<id>.jsonl`
  and parses only appended lines on each change (reuse the streaming parser
  approach already used for the main transcript). Never re-parse from zero.
- **Tool-call cap:** keep at most the last `SUBAGENT_TOOL_CALLS_MAX` (proposed
  **40**) tool calls in `toolCalls[]`, with a `… +N earlier` affordance. The
  mini-feed is a timeline, not a full log. `log()` the truncation count so it's
  not silently hidden.
- **Collapsed by default:** the mini-feed only mounts on expand (reuse the
  `LazyDetails` first-open lazy-mount idiom from `ToolResultRow.tsx`).
- **Per-session scoping:** the watcher runs only for the focused/active
  session(s) whose feed is mounted, not every session on disk.

---

## 7. Components & files

### Main process (all disk I/O here)

- **NEW** subagents watcher — locate the existing session-transcript watcher
  (the code that sets `transcriptStatus` / streams main `.jsonl` entries) and
  add a sibling watcher on `<sessionDir>/subagents/`. Emits `SubAgentState[]`
  per session over IPC.
- **REUSE** `packages/agent-transcript-parser` to parse `agent-<id>.jsonl`
  entries (tool_use extraction, turn counting).

### Renderer — state

- `workspace/workspaceState.ts` — add `subAgents: Record<string, SubAgentState>`
  to `SessionRuntime`; add `SubAgentState` / `SubAgentToolCall` types.
- IPC subscription wiring (the existing runtime-subscription hook) — fold
  pushed subagent state into `runtime.subAgents`.

### Renderer — feed model

- `features/feed/model/renderModel.ts` — detect a **run of sibling `Task`
  tool_use blocks** within an assistant turn and emit a single
  `type: 'subagent-group'` render item carrying the ordered `toolUseId`s. A lone
  `Task` emits a `subagent-single` (or the group renderer handles N=1).

### Renderer — components (new)

- `features/feed/ui/rows/SubAgentGroupRow.tsx` — the concurrency header +
  the list of `SubAgentRow`s. Computes the live tally from `runtime.subAgents`.
- `features/feed/ui/rows/SubAgentRow.tsx` — one subagent line; holds local
  `useState(expanded)`; renders `SubAgentMiniFeed` when open.
- `features/feed/ui/rows/SubAgentMiniFeed.tsx` — the tool-call timeline +
  current-activity line; reuses `MarkerRow` and the `TruncatedOutputRow` collapse
  idiom; "view full transcript" escape hatch.

### Renderer — dispatch (Block.tsx)

- `features/feed/ui/rows/Block.tsx` — intercept `tool_use` blocks where
  `tu.name === 'Task'` **before** the generic `ToolUseRow` default, routing them
  into the subagent rendering path (or letting the render-model grouping handle
  them upstream — chosen during planning).

### Reused idioms (do not reinvent)

- Collapse / lazy-mount: `ToolResultRow.tsx` `LazyDetails`,
  `TruncatedOutputRow.tsx` (`useState(expanded)` + `… +N (click to expand)`).
- Status colors: `dispatch/DispatchAgentList.tsx` `dispatchActivity*`
  (green=working, blue=running, red=exited).
- Row layout: `MarkerRow` (`⏺` / `⎿` markers).

---

## 8. Edge cases & failure modes

- **`subagents/` dir absent** (no subagents spawned this session): watcher is a
  no-op; feed renders exactly as today. Zero regression.
- **meta.json missing / malformed** (older Claude Code, partial write): fall
  back to the file id as `agentId`, `agentType: 'agent'`,
  `description: ''`; do not crash. If `toolUseId` is absent we cannot link —
  render the subagent ungrouped under a generic "subagent" card rather than
  guessing a parent.
- **Reload mid-run:** state rebuilds from disk on watcher init; running agents
  resume ticking, done agents show their summary. Durable by construction.
- **Subagent killed / session exits:** last-known timeline freezes; status
  resolves to `error` if the parent `tool_result` is an error, else stays at the
  last observed state with a stale indicator.
- **Nested subagents** (a subagent spawns its own subagents): out of scope —
  Claude Code writes those under the subagent's own dir; we render one level.
  Note it in the spec so a future reader doesn't mistake the omission for a bug.
- **Concurrent sessions** each with their own `subagents/`: keyed by session;
  no cross-talk (the `subAgents` map lives on each `SessionRuntime`).
- **Codex sessions:** no `subagents/` dir; feature inert.
- **Very large transcripts:** bounded per §6.

---

## 9. Open questions (resolve during planning, not blocking)

1. **Grouping boundary:** group strictly by sibling `Task` blocks *within one
   assistant turn*, or also coalesce `Task` blocks across adjacent turns in the
   same "burst"? Lean: within one turn (simplest, matches how the API batches).
2. **Status source of truth:** parent `tool_result` presence vs. a terminal
   marker in the subagent file. Lean: parent `tool_result` (authoritative for
   "the main agent considers it done").
3. **Watcher hosting:** extend the existing transcript watcher vs. a dedicated
   subagents watcher module. Lean: dedicated module, invoked alongside the
   existing one, for isolation/testability.

---

## 10. Rollout

Single PR on `feat/subagent-inline-render`. No setting/flag — this is strictly
additive rendering for data that is otherwise invisible, with a clean no-op when
no subagents exist. (If we want a kill-switch, a single
`showSubagentDetail` setting can gate the group renderer, defaulting on — decide
during planning.)

---

## 11. Testing

Per repo convention (no new persistent test files / no new `test:*` scripts in
feature PRs): validate manually against the live `subagents/` data already on
disk, plus a **temporary** throwaway fixture for the parser mapping
(`meta.toolUseId` → `Task` block; running/done transition) deleted before the PR
lands. Manual acceptance:

1. Fire 4 parallel `Task` agents → group header shows `◐ 4 running`, ticking.
2. Expand one → live tool-call timeline grows in place.
3. Agents complete → glyphs flip to `✓`, elapsed freezes, tally updates.
4. Reload the session → state rebuilds from disk, done agents summarized.
5. Session with no subagents → feed identical to today.

---

## 12. Summary

The data to answer "how many agents are running and what are they doing" is
already on disk, live, and deterministically linked to its parent `Task` card by
`meta.toolUseId`. This spec wires that disk truth into the runtime via a
main-process watcher and renders it as (a) a live concurrency header grouping
sibling `Task` blocks and (b) an expandable per-subagent tool-call mini-feed —
reusing existing collapse/marker/color idioms, touching no existing contract,
and degrading to today's behavior when no subagents exist.
```