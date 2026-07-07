# Subagent / Task-tool / task-notification row UI — implementation plan

Research for the rendering rewrite (7-bundle complaint cluster). Sources: debug bundles at
`~/.config/agent-code/debug-bundles/manual/`, git/PR archaeology, HEAD code, the rendering
pipeline on `integration/rendering-pipeline` (PR #442, slices 1–20, worktree
`.worktrees/rendering-slice16`), and `docs/rendering/rendering-rewrite-plan-2026-07.md`.

---

## 1. Complaint cluster → root causes

| Bundle | Note | Root cause (verified) |
|---|---|---|
| 2026-06-18 11:12 (21c515e9) | "Not handling codex subagents at all" | Pre-#292: `subAgents` snapshot literally `{}`; `spawn_agent` painted as a generic tool row with raw `{"agent_id":"019eda6c-…","nickname":"Cicero"}` result `<pre>`. Wire shape (proxy-semantic): `function_call` blocks with `call_…`/`fc_…` ids, fan-in via separate `wait_agent {targets:[agent-uuid…], timeout_ms}`; **`agent_id` UUIDs are disjoint from the call ids and codex has NO task-notification** — completion truth is the `spawn_agent`/`wait_agent` result JSON. Fixed same day by PR #292 (91af76d) for the committed plane; live plane + lifecycle still open. |
| 2026-06-21 20:14 (62432945) | "Sub agents UI is fucking horrible? did we not do a PR?" | Three stacked defects, none a wiring regression of PR #277: (1) the session spawned via **MCP orchestration tools** (`mcp__agent_code__orchestration_create_agent` / `_wait_agents`), which never match Block.tsx's `'Agent' \|\| 'spawn_agent'` dispatch → **zero cards painted** even though `state-snapshot.subAgents` had 73 entries keyed by `toolu_…`; (2) twelve `<task-notification>` completions (incl. full agent reports whose markdown parsed into `<h2>`s) painted verbatim inside `bg-user-bg` user bubbles; (3) state unhealthy — 57/73 stuck `running`, `turnCount` up to 3036, `droppedToolCalls` 1742, repeated toolCalls (watcher re-reads + double-counts). Filed as #341 (OPEN). |
| 2026-06-22 09:05 (7733b0fc) | "UI for the tasks.." | Same stale state (~80 subagents, 77 "running") PLUS the paint pathology: **142 empty `min-h-[48px]` LazyEntry spacer divs** — the task activity rendered as a wall of blank placeholder rows with tiny expand toggles. |
| 2026-06-29 11:38 (42071335) | "task notifications … rendered like a retard" | Two surfaces. Committed: `<task-notification>` arrives as `type:"user"` entry with **no `isMeta`**; legacy renderModel only filters `isMeta===true` → raw-XML user bubble. Queue: this bundle shows the notification parked as a raw-XML **queued message** ("1 queued" in `QueueStrip`, `aria-label="queued messages"`) as if the user typed it. Also proves scope > subagents: this one was a **background Bash** completion (`tool-use-id` → a Bash tool_use). Zero handling anywhere in `src/` (no hit for `task-notification` outside `vendor/`). |
| 2026-06-29 14:13 (1b2b5e96) | "agent output is buried under task notifications" | Clearest burial: an entire subagent code-review report (`<result>` with thousands of chars, `<usage>` 27.5k tokens/13 tools/98s) crammed into ONE raw queued-message `<li>`. Ordering half fixed since; the ROW half (what notification/queue rows should look like) is this plan. |
| 2026-06-17 11:50 (a6c70f19), 2026-06-21 18:16 (fc397785) | AskUserQuestion "not handling at all" | Forensics: a6c70f19 painted the raw input JSON as a `<pre>` under a generic "AskUserQuestion / running" tool row + footer "Awaiting AskUserQuestion · 3m43s"; fc397785 was worse — bare tool NAME with no input at all, session parked in `streamPhase:"awaiting-tool"` with conditions/picker state all null. In both, the proxy had already fully parsed `questions[].{header,multiSelect,options[].{label,description}}` with the toolUseId — the renderer just had no unit for it. Both bundles predate the fix chain (#289: 37ba058+d1c17b8 on 06-21, #329/#330 conditions driver on 06-22). At HEAD the semantic-plane `AskUserQuestionRow` is a real answerable picker. Remaining gaps: committed-plane rendering (raw JSON after answer) and survival through pipeline cutover (plan §8 explicitly defers #98/#289 to "row-layer feature after cutover"). |

## 2. Archaeology — what the prior PR did and why it "stopped working"

**PR #277** (2026-06-14, 468f984/e46385c/2a4380b): main-process `SubAgentWatcher` polls
`<sessionDir>/subagents/*.jsonl` (600ms), folds into `SubAgentState` (status, tool-call ring,
`startedAt/lastActivityAt`, `currentActivity`), pushes `session:sub-agents` IPC keyed **by parent
`Agent` tool_use id** (from `agent-<id>.meta.json` → `meta.toolUseId`). Renderer:
`SubAgentsContext` → `TaskSubagentRow` (Block.tsx routes `name==='Agent'`), `SubagentGroupHeader`
("Spawned N agents · ◐R · ✓D") when ≥2 adjacent Agent blocks, `SubagentMiniFeed` drill-in.
**PR #292** (2026-06-18, issue #291) extended the same rows to codex `spawn_agent` +
`codexSubagentState.ts`, and filtered `<subagent_notification>` synthetic user rows in
`src/providers/codex/renderer/transcript/rollout.ts`.

**It did not regress in wiring.** All components are wired at HEAD (`Block.tsx:143`,
`ConversationRow.tsx:107`); `git log --follow` shows no deletions; the #288 memory series
(4df7a77…14c19b6, PR #322 "derive-and-drop") preserved the IPC contract explicitly
("SubAgentState/SubAgentToolCall IPC contract is unchanged"). What the user saw on 06-21 was
the feature's blind spots, not a rollback:

1. **Dispatch-name blind spot**: cards render only for tool_use `name ∈ {Agent, spawn_agent}`.
   The 06-21 session spawned via the built-in MCP orchestration server
   (`mcp__agent_code__orchestration_create_agent` / `_list_agents` / `_wait_agents`,
   `src/mcp/runtime/createBuiltInMcpServer.ts`) → zero cards despite 73 tracked subAgents.
2. **task-notification blind spot**: nothing anywhere consumes `<task-notification>` user
   entries, so every completion (including the child's full result report) leaked as raw XML —
   as user bubbles once committed and as raw queued lines in `QueueStrip` before delivery.
3. **Stale state**: `codexSubagentState.ts` flips a child to terminal ONLY on
   `<subagent_notification>` completed/failed or child `event_msg task_complete` — no inference
   from `wait_agent` completion, child session exit, or inactivity → codex children run forever.
   `SubAgentWatcher.metaByAgent` is never pruned except on `stop()`; `emit()` iterates every
   meta ever seen → resumed/long-lived sessions accumulate dozens of forever-running cards.
   Snapshot health also shows double-counting (`turnCount` 3036, repeated `toolCalls`,
   `droppedToolCalls` 1742) from re-reading growing transcripts.

Issue map: **#178** (umbrella, OPEN), **#341** (stale-running, OPEN — the direct write-up of the
06-21 bundle), **#291** (CLOSED via #292), **#289** (AskUserQuestion, OPEN but the answerable row
shipped; needs closing criteria re-check post-cutover), **#340** (split from #178).

## 3. Where the new pipeline stands (and why this plan fits it)

- Integration branch PR #442 (Stages 1–2), slices 1–20 merged into it; Stage 3 cutover flag
  `AGENT_CODE_RENDER_PIPELINE=1` already exists (slice 17); shadow mode `AGENT_CODE_RENDER_SHADOW`
  (slice 12); corpus extractor covers the debug-bundle corpus incl. codex rollouts (slice 20).
- `RenderCandidate.toolUseId` is reserved first-class (plan §7 rule 14) exactly for this feature
  (`src/renderer/src/rendering/model/types.ts:96-102` on the worktree).
- The **committed collector is entry-level** (`observations/committed.ts`) and the view bridge
  (`view/ledgerFeedItems.ts`) re-emits legacy `FeedRenderItem`s → `ConversationRow`/`Block.tsx`
  row components **survive cutover unchanged**. Therefore: row-level Task/notification UI built in
  the legacy row layer is NOT throwaway; it is the post-cutover UI too.
- **Trap found:** the new committed collector's `isSyntheticClaudeUserRow` (claude + role user +
  no `permissionMode` + text starts with `<`) already swallows `<task-notification>` user entries
  as `synthetic-user-filtered`. Post-cutover the ugly bubble disappears — but so does the ONLY
  carrier of a background task's final result unless we join it into the parent row first.
  This must become its own fixture-gated reason, not an accident of the `<` predicate.

### Verified data shapes (join keys)

Committed Claude task-notification entry (real transcript, verified):

```json
{"type":"user","message":{"role":"user","content":"<task-notification>\n<task-id>bs07b21gl</task-id>\n<tool-use-id>toolu_01WBGTmi74x2pgobrxhMBES9</tool-use-id>\n<output-file>…</output-file>\n<status>completed</status>\n<summary>Background command \"…\" completed (exit code 0)</summary>\n</task-notification>"}}
```

No `isMeta`, no `permissionMode`. Vendor source (`vendor/claude-code-src/full/tasks/LocalAgentTask/LocalAgentTask.tsx:246-260`)
shows the full grammar: `task-id`, optional `tool-use-id`, `output-file`, `status`
(completed|failed|stopped), `summary`, optional `result`, `usage` (total_tokens/tool_uses/
duration_ms), optional `worktree`. `tool-use-id` points at the spawning `tool_use` — which can be
an `Agent` tool_use OR a background `Bash` (so the join generalizes beyond subagents).
Transcripts also contain `type:"queue-operation"` and `type:"attachment"` task-notification
entries — already dropped as `not-conversation`; only the `type:"user"` ones need work.

`SubAgentState` (`src/shared/sessionFeed/types.ts:115`) is already keyed by `toolUseId` — the
watcher IPC path stays the source of live child telemetry; task-notifications are the source of
final results; parent `tool_result` is the source for foreground (synchronous) completion.

## 4. Target design

### 4.1 Parent Task row (`TaskSubagentRow` v2) — one card, three evidence sources

**Card eligibility generalizes** (fixes the 06-21 zero-cards bug): route to the Task card when
tool_use `name ∈ {Agent, Task, spawn_agent, mcp__agent_code__orchestration_create_agent}` **or**
`subAgents[block.id]` exists (the state join is stronger evidence than the name). Keep the name
set in one shared predicate (`isAgentSpawnToolName`) used by Block.tsx, ConversationRow's
grouping, and the semantic-plane router.

Status resolution order (strongest first), all joined by `toolUseId`:

1. **task-notification** for this toolUseId → terminal truth: status glyph, summary, expandable
   `result` text, usage chips (tokens · tool uses · duration). Claude background agents AND
   background Bash commands (bundle 42071335 proves the same grammar covers both).
2. **parent `tool_result`** for this toolUseId (already indexed in Feed context) → done/error for
   foreground agents; codex `wait_agent` output joins here too (codex has NO task-notification —
   `wait_agent`'s `function_call_output` naming the `agent_id` is its completion truth).
3. **`SubAgentState`** from the watcher → live: `currentActivity`, tool count, elapsed.
4. Nothing yet → "starting…".

New visual state **stale**: if the strongest evidence is still `running` but
`lastActivityAt` is older than a threshold (60s of silence with no live watcher pulse), render
"◐ no activity for 4m" in muted style — never a healthy spinner. This is the honest-UI half of
#341; the data half is fixed in the main process (4.4).

Collapsed by default; expanding shows `SubagentMiniFeed` (live) and/or the notification `result`
markdown (terminal). `SubagentGroupHeader` keeps its tally line and gains `⏸ N stale`.

### 4.2 task-notification rows — collapse, join, never a user bubble

- Parse to `TaskNotification { taskId, toolUseId?, outputFile, status, summary, result?, usage?, worktree? }`
  in a shared module (used by both renderers and the ledger collector).
- **If the parent `tool_use` is present in the feed** (normal case): the notification entry emits
  NO standalone row — its content is delivered to the parent Task row via a
  `Map<toolUseId, TaskNotification>` built where `toolResultIndex` is built today
  (`Feed.tsx` context). The parent card badge flips (✓/✗) at the notification's position-in-time
  is irrelevant — status is state, not a row.
- **If no parent is visible** (no `tool-use-id` tag, parent scrolled out of the loaded window,
  cross-session notification): render a compact one-line `TaskNotificationRow`:
  `✓ Agent "fix flaky test" completed · 54k tok · 2m19s ▸` — expandable to summary + result
  markdown + output-file path. Marker-gutter style (MarkerRow), assistant-side, muted. Never a
  prompt bubble, never raw XML.
- Codex `<subagent_notification>` keeps its existing rollout-level filter; its payload already
  feeds `codexSubagentState`. No standalone codex notification rows either.
- **Queue lane twin** (bundles 42071335 + 1b2b5e96): before delivery, the notification sits in
  `QueueStrip.tsx` (`aria-label="queued messages"`) as a raw XML line — the burial surface.
  QueueStrip runs the same `parseTaskNotification`: matching items render as a one-line chip
  `✓ Agent "Review AppRunJournal engine" finished — delivering to agent…` (never the XML, never
  the embedded result). No queue-model change — display-only mapping, consistent with plan D1
  (queue is not feed rows).
- **No spacer walls** (bundle 7733b0fc): suppressed/joined notification entries must be excluded
  BEFORE LazyEntry virtualization so they never emit `min-h-[48px]` placeholder divs — i.e.
  filtered in renderModel's visibleDecision, not hidden inside the row component.

### 4.3 AskUserQuestion — lifecycle across planes

Live (semantic) plane is done and stays: unresolved block → answerable `AskUserQuestionRow`
(single/multi-select, free-text, multi-question; conditions custom-action drives the real TUI;
screen condition gates clickability only; row unmounts when `resultAt` lands). Remaining work:

- **Committed plane**: an answered AskUserQuestion currently renders as generic `ToolUseRow`
  raw-JSON. Add `AskUserQuestionAnsweredRow` (committed): join `tool_use` input questions with the
  `tool_result` chosen options via the existing `toolResultIndex` → compact
  `? "How should X work?" → "Option B"` row, expandable for all questions/options.
- **Cutover guarantee**: ledger must never fold an unresolved AskUserQuestion into
  `collapsed_activity`/`collapsed-running` (the legacy guard in `renderUnits.ts:326-339` must have
  a ledger twin + fixture). Its candidate is `semantic-current`-owned until the committed
  tool_result exists; ownership handoff must not unmount the picker while unanswered (fixture from
  bundle fc397785).
- Post-D6 (SemanticStreamingTurn deletion): live blocks route through the provider registry —
  register AskUserQuestion there rather than the current `BlockRow.tsx:384` hardcode.

### 4.4 Lifecycle fix (#341) — main process, not rendering

`codexSubagentState.ts` terminal inference additions: (a) parent `wait_agent`
`function_call_output` naming the agent → done/error; (b) child rollout `task_complete`/session
end; (c) inactivity threshold → `stale` (distinct from done — we don't fabricate completion).
`SubAgentWatcher`: prune `metaByAgent`/state for agents terminal for >N minutes once painted-and-
committed; cap emitted map; `stop()` unchanged; fix the accumulation double-count (bundle
62432945: `turnCount` 3036 / repeated `toolCalls` — re-reads of a growing transcript are being
re-folded instead of resumed from the last offset). `SubAgentState.status` gains `'stale'`
(shared type + both builders + row glyphs). This is orthogonal to the rewrite and lands first.

### 4.5 Live-plane routing (codex + claude fan-out while streaming)

Semantic `BlockRow` has no Agent/spawn_agent routing → during a live fan-out turn the Task rows
are generic tool rows until the JSONL commits. Add routing: semantic block with
`isAgentSpawnToolName(block.toolName)` (same shared predicate as 4.1, so MCP orchestration
spawns get live cards too) → a thin adapter around the same Task card (block.toolUseId is the
join key; SubAgentsContext already has the data). Registered per-provider so cutover's
"live rows use the same provider registry dispatch" rule inherits it.

## 5. Ledger changes (new pipeline)

Small and additive — the plan's §8 deferral ("subagent surface: reserved key, own feature")
stays true; we only make the committed collector honest:

- `model/types.ts`: add reason `'task-notification-joined'` (+ keep `synthetic-user-filtered`
  for genuine scaffolding). Optionally `contentKind: 'task-notification'` if we ever emit
  standalone notification candidates; not needed for v1 (entry stays suppressed, join happens in
  the row layer from `entriesByUuid`).
- `observations/committed.ts`: detect `<task-notification>` BEFORE `isSyntheticClaudeUserRow`;
  emit decision `{selected:false, reason:'task-notification-joined', evidence:[taskId, toolUseId]}`
  and stamp `toolUseId` on the (suppressed) candidate so bundles can answer "where did my
  notification go" (#344 discipline).
- Rule 15: the new reason merges with fixtures extracted from bundles 42071335 + 1b2b5e96.
- View bridge: unchanged (entry-level suppression means it never sees these rows).

## 6. Tests & fixtures

Per plan rule 15 and the rendering-slice convention (tests live in
`src/renderer/src/rendering/__tests__/` + `testing/fixtures/rendering/`; no new `test:*` scripts):

1. **Fixtures from the bundles** via `scripts/extract-rendering-fixtures.mjs`:
   - `taskNotification-62432945` (committed user-entry notifications, incl. full-result reports)
     → asserts: suppressed with `task-notification-joined`, join map contains toolUseId, no
     user-text row painted, no LazyEntry spacer emitted.
   - `taskNotification-42071335` / `-1b2b5e96` (queue-lane notifications; background-Bash and
     subagent-report variants) → asserts QueueStrip chip mapping + parser handles missing
     `result`/`usage` and the `subagent_tokens` vs `total_tokens` drift.
   - `staleSubagents-62432945` (73/57 snapshot) → asserts group tally renders stale, not running
     (row-layer test, uses the state snapshot as SubAgentsContext input).
   - `codexSpawn-21c515e9` → spawn_agent + subagent_notification: notification never a user row;
     spawn joins child state.
   - `askUserQuestion-fc397785` → unresolved picker owned by semantic-current; never
     collapsed-running; unmount only on committed tool_result.
2. **Unit tests**:
   - `parseTaskNotification` grammar (all optional tags, malformed → null, quoting attack:
     real user prompt QUOTING the XML is not swallowed — require full-content match like the
     codex filter does).
   - toolUseId parent/child join: candidates for parent Task tool_use + suppressed notification →
     joined row model (pure function, no DOM).
   - codex terminal inference: wait_agent output / task_complete / inactivity → status
     transitions incl. `stale` (extends existing `SubAgentWatcher.test.ts` — an existing file).
   - Answered-question join: tool_use+tool_result → compact row model.

## 7. Code changes, file-by-file

### Pre-cutover (land now on main; legacy renderer; also survives cutover via the view bridge)

| # | File | Change | ~LOC |
|---|---|---|---|
| P1 | `src/main/subagents/codexSubagentState.ts` | wait_agent/child-exit/inactivity terminal inference | +80 |
| P1 | `src/main/subagents/SubAgentWatcher.ts` | prune terminal metas, stale sweep | +40 |
| P1 | `src/shared/sessionFeed/types.ts` | `status: … \| 'stale'` | +2 |
| P2 | `src/shared/taskNotification.ts` (new) | parser + type + `isAgentSpawnToolName` predicate (shared: renderer, main, ledger) | 80 |
| P2 | `src/renderer/src/features/feed/model/renderModel.ts` | visibleDecision: task-notification user entries → hidden, reason `task_notification` (pre-LazyEntry, so no spacer divs) | +25 |
| P2 | `src/renderer/src/features/feed/ui/Feed.tsx` (+context) | build `taskNotificationsByToolUseId` beside `toolResultIndex`; provide via context | +35 |
| P2 | `src/renderer/src/features/feed/ui/rows/TaskSubagentRow.tsx` | v2: evidence-priority status, stale state, notification result/usage in expansion | +60 |
| P2 | `src/renderer/src/features/feed/ui/rows/TaskNotificationRow.tsx` (new) | orphan-notification compact row | 70 |
| P2 | `src/renderer/src/features/feed/ui/rows/SubagentGroupHeader.tsx` | stale tally | +8 |
| P2 | `src/renderer/src/features/feed/ui/rows/Block.tsx` + `ConversationRow.tsx` | swap hardcoded name checks for `isAgentSpawnToolName` (adds Task + MCP orchestration names) | +10 |
| P2 | `src/renderer/src/workspace/tile-tree/TileLeaf/QueueStrip.tsx` | queued task-notification → one-line chip, never raw XML | +25 |
| P3 | `src/renderer/src/features/feed/ui/semantic/BlockRow.tsx` | route live spawn tools → Task card adapter | +20 |
| P3 | `src/renderer/src/features/feed/ui/rows/TaskSubagentRow.tsx` | accept semantic-block shape (adapter or prop union) | +25 |
| P4 | `src/renderer/src/features/feed/ui/rows/AskUserQuestionAnsweredRow.tsx` (new) | committed answered-question compact row | 60 |
| P4 | `src/renderer/src/features/feed/ui/rows/Block.tsx` | dispatch AskUserQuestion tool_use → answered row | +10 |

P1 ≈ 130 LOC (fixes #341's data half). P2 ≈ 315 (kills the 06-29 complaints + the 06-21
zero-cards blind spot). P3 ≈ 45. P4 ≈ 70.
Suggested PR slicing: P1 alone; P2 alone; P3+P4 together. Each is independently shippable.

### On the integration branch (pre-cutover in pipeline terms, post-P2)

| File (worktree `integration/rendering-pipeline`) | Change | ~LOC |
|---|---|---|
| `src/renderer/src/rendering/model/types.ts` | reason `'task-notification-joined'` | +2 |
| `src/renderer/src/rendering/observations/committed.ts` | detect via shared parser, stamp toolUseId, emit reason | +30 |
| `src/renderer/src/rendering/__tests__/fixtures.taskNotification.test.ts` (new) | rule-15 fixtures (above) | 120 |
| `scripts/extract-rendering-fixtures.mjs` | nothing structural — bundles already in corpus | 0 |

### Post-cutover (D6, when SemanticStreamingTurn dies)

- Move `BlockRow` AskUserQuestion + Agent routing into the provider registry dispatch (the
  cutover already plans this unification); delete the `renderUnits.ts` belt-and-suspenders guard
  once the ledger fixture proves the ledger twin.
- Optional: standalone `contentKind:'task-notification'` candidates if we ever want notification
  rows to be ledger-ordered artifacts instead of joined state (not needed while the join covers
  all observed bundles).

## 8. What this does NOT do

- No rewrite of the watcher IPC contract (#277's `SubAgentState` keyed by toolUseId is exactly
  the shape the ledger's rule-14 join wants).
- No conditions changes (AskUserQuestion answer driver #329/#330 already works).
- No new test scripts; fixtures follow the existing rendering-corpus machinery.
- #290/#193 provider tailing/lineage stay headless scope (a dead committed channel just renders
  honestly as stale).

## Appendix — bundle evidence quick reference

- Rendered DOM has NO semantic class names (all Tailwind utilities); tool rows are
  `⏺ <span class="text-accent font-semibold">Name</span>` + `⎿ <pre class="font-code">raw</pre>`;
  user bubbles `bg-user-bg -mx-8 px-8 py-3`; queue `aria-label="queued messages"`.
- `state-snapshot.subAgents` shape (all bundles): keyed by `toolu_…`, values
  `{toolUseId, agentId, agentType, description, status, startedAt, lastActivityAt, turnCount,
  toolCalls[{name,headline,status}], droppedToolCalls, currentActivity}` — exactly the
  `SubAgentState` contract; the rows can trust it once lifecycle is fixed.
- task-notification XML observed fields: `task-id`, `tool-use-id` (optional), `output-file`,
  `status`, `summary`, `note` (seen in the wild — ADD to the parser beyond the vendor grammar),
  `result`, `usage{subagent_tokens|total_tokens, tool_uses, duration_ms}`, `worktree`. Parser
  must accept both `subagent_tokens` (observed) and `total_tokens` (vendor source) —
  the tag drifted between versions.
- AskUserQuestion bundles: only runtime signal besides the semantic block is
  `streamPhase:"awaiting-tool"` + `streamPhasePendingToolName:"AskUserQuestion"`; conditions/
  picker snapshots are null — reaffirms that the semantic `parsedInput` path (not screen or
  conditions state) is the right render source, as the shipped row already does.
- Codex wire: `function_call` blocks, `call_…`/`fc_…` ids, `agent_id` UUID disjoint from both;
  `wait_agent {targets, timeout_ms}` is fan-in; no notification mechanism.
