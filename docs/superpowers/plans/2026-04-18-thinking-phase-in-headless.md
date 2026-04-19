# Thinking / working phase — derived in the headless packages

**Supersedes:** `2026-04-18-thinking-indicator-rework.md` — specifically
the `workPhase.ts` / `deriveWorkPhase` part. The target UX (one
`WorkIndicator` component with `header` / `footer` / `strip` variants,
collapse-by-default live thinking, always-on pane chrome, severity-aware
tab dot) from that doc stays valid. The **derivation location** is what
this plan replaces.

## Why the previous location was wrong

The earlier plan put phase derivation in the renderer
(`src/renderer/src/tiles/workPhase.ts`) and computed it by re-folding the
already-emitted `SemanticLiveTurn` state
(`src/renderer/src/tiles/workspaceState.ts:160`). That is two mistakes:

1. **It rebuilds a state machine upstream already ran.** Each headless
   package owns a `ClaudeProxyAdapter` / `CodexResponsesAdapter` whose
   `applyAnthropicEvent` / `handleFrame` loop IS the state machine
   Claude Code's own `handleMessageFromStream`
   (`claude-code-src/full/utils/messages.ts:2929`) encodes — same event
   types (`message_start`, `content_block_start:text|thinking|tool_use`,
   `text_delta`, `thinking_delta`, `input_json_delta`,
   `content_block_stop`, `message_delta`, `message_stop`), same
   decisions. The adapter already knows, at each transition, what
   Claude Code labels `streamMode`. The renderer re-deriving from the
   post-facto block list loses provenance (`stream_request_start` is not
   recoverable post-event) and duplicates work.

2. **It re-ties phase to screen parsing through the fallback seam.**
   `deriveWorkPhase` step 6 fell back to
   `processActive && !currentTurn → thinking`. `processActive` comes
   from `ClaudeCodeHeadless.ts:377` — `detectActivity(snap.plain)`, the
   TUI spinner glyph parser. Any time the proxy is enabled we already
   have better data; falling through to screen state at the renderer
   boundary makes the renderer provider-aware and fragile.

## What we actually have

The proxy adapter reads the same bytes Anthropic's SDK / OpenAI
Responses API deliver to Claude Code / Codex respectively and routes
them through typed publishers on `SemanticChannel`. File map, for
reference:

| File | Role |
|---|---|
| `claude-code-headless/src/proxy/ClaudeProxyAdapter.ts:434` | `applyAnthropicEvent(state, ev)` — the per-event switch that is structurally identical to `handleMessageFromStream`. |
| `claude-code-headless/src/proxy/anthropicEvents.ts` | SSE record → `AnthropicStreamEvent` parser. Owns the `message_start` / `content_block_start` / `*_delta` / `content_block_stop` / `message_delta` / `message_stop` / `error` / `ping` / `unknown_delta` taxonomy. |
| `claude-code-headless/src/channels/SemanticChannel.ts` | Typed publishers for every event we care about. Where we add one more. |
| `claude-code-headless/src/channels/types.ts:170` | `SemanticBlockKind` taxonomy. What an adapter already classifies. |
| `claude-code-headless/src/ClaudeCodeHeadless.ts:377` | Legacy screen-parsed `activity`/`idle` path. Stays — as a fallback for `useProxy=false`. |
| `codex-headless/src/proxy/CodexResponsesAdapter.ts:405` | `drainFrames` + `handleFrame` — the per-event switch for Codex. Mirrors `applyAnthropicEvent` 1:1 with Responses API event names. |
| `codex-headless/src/CodexHeadless.ts:825` | `ingestRolloutIntoSemantic` — the rollout-tailer path that acts as the authoritative live source when the proxy is disabled. Also publishes phase (see section 3a). |
| `codex-headless/src/channels/SemanticChannel.ts` | Strict-lifecycle semantic channel. Has `startTurn` / `applyDelta` / `finishTurn` + block-level publishers. Gains `publishStreamPhase`. |
| `codex-headless/src/channels/types.ts:237` | `SemanticBlockKind` for Codex (13 variants mapped from `ResponseItem` in `codex-rs/protocol/src/models.rs:188-341`). |

**How the Codex adapter events were verified.** I walked
`CodexResponsesAdapter.ts:459-894` (the `switch (t)` in `handleFrame`)
with the authoritative upstream parser at
`codex-src/codex-rs/codex-api/src/sse/responses.rs` as reference. The
event type strings we parse are the exact wire payload types
(`response.created`, `response.output_item.added`,
`response.output_text.delta`, `response.reasoning_summary_text.delta`,
`response.output_item.done`, `response.completed`, `response.failed`,
`response.incomplete`). Every `content_block_start`-equivalent already
lives at `CodexResponsesAdapter.ts:479` inside
`response.output_item.added` with `mapItemTypeToBlockKind` classifying
it into one of the 13 ResponseItem variants. No new wire-level
knowledge is needed for the phase publisher; it's a fold on events
the adapter already consumes.

The renderer already subscribes to every event the channel emits via the
`semantic-event` IPC fanout
(`src/renderer/src/tiles/workspaceStore.ts:697+` reducer). Adding one
more event type costs: one publisher + one reducer case + one runtime
field.

## How upstream Codex does it

Codex's `• Working (Ns • esc to interrupt)` row (detected today in
`codex-headless/src/parsers/ScreenParser.ts:215` via
`CODEX_WORKING_ROW_RE`) is visible IFF a `/v1/responses` request is in
flight. The upstream TUI does not screen-scrape itself — it tracks
that flag directly from the client that dispatches the request and
drops it on `response.completed` / `response.failed` /
`response.incomplete` / a transport error. During tool execution
between responses, the TUI dispatches a NEW request (with the
`function_call_output` injected into `input`), so the Working row
stays on continuously through a multi-step agent loop. That's exactly
the `requesting → thinking → (tool-input → tool-use →) awaiting-tool
→ requesting → thinking → ...` cycle the adapter already sees, and
it's why putting phase derivation in the adapter is the natural
placement: we already observe every transition Codex's own TUI keys
off.

The only state the upstream TUI shows that we don't get from the
wire is `Booting MCP server: <name>` (see
`CODEX_BOOTING_RE` at `ScreenParser.ts:213`). That is a PTY-only
startup state and stays on the screen channel; it has no phase
analog and is out of scope here.

## How upstream Claude Code does it

From `claude-code-src/full/utils/messages.ts:2929`:

```
stream_request_start                           → 'requesting'
content_block_start: thinking/redacted_thinking→ 'thinking'
content_block_start: text                      → 'responding'
content_block_start: tool_use / server_tool_use/
                     mcp_tool_use / …          → 'tool-input'
message_stop                                   → 'tool-use'
message_delta / default                        → 'responding'
```

That is *the* table. Five labels. Nothing more. Every other "is it
busy?" signal in Claude Code's UI is a downstream consumer of this one
field.

Claude Code also tracks two things that sit OUTSIDE the table but are
derivations of events we already see:

- **`waiting-tool-result`** — not in the upstream state machine; Claude
  Code simply renders the turn as "tool_use in progress" because the
  pending `tool_use` block has no paired `tool_result` yet. Our semantic
  channel already has the matching cross-turn linkage
  (`SemanticToolResultEvent`, `claude-code-headless/src/channels/SemanticChannel.ts:527`).
- **`submitting`** — the brief gap between the user pressing Enter and
  `message_start` arriving. Captured renderer-side as "I sent a message,
  no proxy event yet."

Both are fine to keep, but they are the ONLY two things the renderer
derives. Everything else comes out of the adapter.

## Invariants we want

1. **One source.** `StreamPhase` is emitted by the proxy adapter as a
   typed `SemanticChannel` event. Every provider gets the same event
   shape; the renderer never branches on provider.
2. **No screen parsing in the happy path.** When `useProxy=true`, the
   adapter drives phase exclusively from transport-level Anthropic /
   OpenAI SSE events. The screen spinner stays wired for `useProxy=false`
   **only**, as a degraded fallback — and even then it's a
   package-internal computation that publishes the same
   `stream_phase` event, so the renderer can't tell the difference.
3. **The renderer holds only the current phase.** No deriving, no
   priority tables, no reducing a turn's block list into a phase
   string. Reducer reads the event and assigns.
4. **`activityStatus` verb goes away as user-visible state.** It stays
   in the headless screen channel for diagnostics (`DebugPanel`) but
   stops feeding the user-facing label.
5. **Provider symmetry.** Claude and Codex adapters publish the same
   `StreamPhase` events with the same vocabulary, keyed by the adapter's
   own turnId. Cross-provider rendering stays uniform.

## Phase vocabulary

Match upstream 1:1 where possible; add the two renderer-owned edge
phases explicitly so the set is complete.

```ts
export type StreamPhase =
  | 'idle'
  | 'submitting'         // renderer-only — set when we send a message and
                         // no stream_phase event has landed yet. Cleared
                         // on the first 'requesting' event for the turn.
  | 'requesting'         // stream opened; no content yet
  | 'thinking'           // thinking/redacted_thinking/reasoning block active
  | 'responding'         // text/connector_text block active
  | 'tool-input'         // tool_use block accumulating input_json_delta
  | 'tool-use'           // message_stop arrived; waiting on tool execution
  | 'awaiting-tool'      // block_completed for a tool_use with no tool_result
                         // yet. Renderer-visible distinction from 'tool-use'
                         // because 'tool-use' is instantaneous in Claude Code
                         // but can be the dominant wall-clock phase for us.
  | 'compacting'         // cc-shell extension: CompactionChannel says active
  | 'exited'             // process gone
```

Rationale for `awaiting-tool` vs `tool-use`: Claude Code's `message_stop
→ tool-use` transition is notional (the TUI shows the tool's own
rendering, not a spinner) because the tool runs in the same process and
returns in ~milliseconds. For cc-shell the shell sometimes runs a tool
for minutes; treating `tool-use` and `awaiting-tool` as one label would
make the indicator display `tool-use` for five minutes with no elapsed
time attached, which is exactly the "looks hung" problem.

## Change plan

### 1. Add the event to SemanticChannel types

**File:** `claude-code-headless/src/channels/types.ts`.

Add:

```ts
/** Semantic stream phase — the minimal "what is Claude doing right now"
 *  signal, derived at the transport-event boundary and mirrored exactly
 *  on the upstream claude-code `streamMode` state machine in
 *  utils/messages.ts:2929. Consumers drive UI off this one field
 *  instead of refolding block lists. */
export type SemanticStreamPhaseEvent = {
  type: 'stream_phase'
  turnId: string | null       // null while phase is 'idle'/'submitting'
  phase: StreamPhase
  /** Tool name when phase is 'tool-input' or 'awaiting-tool' — lets
   *  the renderer show "Calling Read" without joining block state. */
  toolName?: string
  /** Tool use id when phase is 'tool-input' or 'awaiting-tool' — so the
   *  renderer can match against incoming tool_result events. */
  toolUseId?: string
  source: SemanticSource
  confidence: SemanticConfidence
  ts: number
}
```

Append `SemanticStreamPhaseEvent` to the `SemanticEvent` union at
`types.ts:500-521`.

**File:** `claude-code-headless/src/channels/SemanticChannel.ts`.

Add `stream_phase: [SemanticStreamPhaseEvent]` to
`SemanticChannelEvents` (around line 58-95) and a typed publisher:

```ts
publishStreamPhase(params: {
  turnId: string | null
  phase: StreamPhase
  toolName?: string
  toolUseId?: string
  source: SemanticSource
  confidence?: SemanticConfidence
}): void {
  const ev: SemanticStreamPhaseEvent = {
    type: 'stream_phase',
    turnId: params.turnId,
    phase: params.phase,
    toolName: params.toolName,
    toolUseId: params.toolUseId,
    source: params.source,
    confidence: params.confidence ?? this.defaultConfidence(params.source),
    ts: Date.now(),
  }
  this.emit('stream_phase', ev)
  this.emit('event', ev)
}
```

Also track the currently-published phase as `lastPhase` on the channel
so duplicate emits are suppressed (the adapter may hit the same branch
twice for back-to-back deltas; we never want two identical
`stream_phase` events in a row). Expose `getLastPhase(): StreamPhase` as
a read-only helper for the screen fallback to compare against when it
wants to post a phase.

### 2. Derive phase inside ClaudeProxyAdapter

**File:** `claude-code-headless/src/proxy/ClaudeProxyAdapter.ts`.

The adapter already has everything it needs. Add a single helper:

```ts
private publishPhase(
  state: FlowState,
  phase: StreamPhase,
  extras: { toolName?: string; toolUseId?: string } = {},
): void {
  if (state.attribution !== 'active') return
  this.channel.publishStreamPhase({
    turnId: state.turnId,
    phase,
    toolName: extras.toolName,
    toolUseId: extras.toolUseId,
    source: 'proxy',
    confidence: 'high',
  })
}
```

Wire it into `applyAnthropicEvent` at exactly the upstream branches.
Note that the `isActive` guard (`ClaudeProxyAdapter.ts:440`) already
suppresses all non-`ping`/`error` work on secondary flows; the
`publishPhase` helper's own `attribution === 'active'` check is
defense-in-depth.

| Branch in adapter | Phase emitted |
|---|---|
| `onChunk` first-chunk promotion, before `applyAnthropicEvent` fires (flow becomes `active`) — emit a synthetic `'requesting'` with `turnId: null` | `requesting` |
| `message_start` (`ClaudeProxyAdapter.ts:461`) — after `startTurn`, re-emit `requesting` with the real turnId so renderer can re-key | `requesting` |
| `content_block_start: text` / `connector_text` (`ClaudeProxyAdapter.ts:492`) | `responding` |
| `content_block_start: thinking` / `redacted_thinking` (`:492`) | `thinking` |
| `content_block_start: tool_use` / `server_tool_use` / `mcp_tool_use` (`:492`) | `tool-input` + `toolName` + `toolUseId` |
| `text_delta` / `thinking_delta` / `input_json_delta` / `connector_text_delta` / `signature_delta` / `citations_delta` / `unknown_delta` (`:565-722`) | no emit. Phase stays at whatever `content_block_start` set. The dedupe in `publishPhase` would catch re-emits anyway, but not emitting keeps the event rate flat. |
| `content_block_stop` (`ClaudeProxyAdapter.ts:724`) — for a `tool_use` block, record the toolUseId and leave phase at `tool-input` until `message_stop`; for text/thinking stops, no emit | — |
| `message_stop` — if any `tool_use` block completed in this turn without a matching `tool_result` emitted yet, transition to `awaiting-tool` with the earliest unresolved `toolUseId`; otherwise no emit | `awaiting-tool` |
| `message_delta` (`ClaudeProxyAdapter.ts:811`) — stopReason present → no phase change, let `finishTurn` drive it | — |
| `finishTurn` / `publishTurnStopped` — terminal emit | `idle` (if no pending tools) |
| `onEnd` defensive path (`ClaudeProxyAdapter.ts:403`) when stream closed without `message_delta` | `idle` |
| `api_error` (`ClaudeProxyAdapter.ts:448`) | `idle` |
| `ping` (`:445`) | no emit |

**Why `awaiting-tool` at `message_stop`, not at `content_block_stop`**:
Claude Code's actual `content_block_stop` for a `tool_use` is followed
immediately by either `message_stop` (if this was the last block) or
another `content_block_start` (if more blocks remain). Waiting until
`message_stop` lets us distinguish "tool call amidst other blocks" from
"turn ended with tool calls pending," which is the only case we want
to render as "Awaiting Tool."

**Tool-result correlation** stays on the existing `SemanticToolResultEvent`
pipeline (the committed/JSONL side posts it; see
`SemanticChannel.ts:527`). The renderer transitions away from
`awaiting-tool` when the matching `tool_result` event arrives — no
additional adapter logic needed.

### 3. Same for Codex — proxy path

**File:** `codex-headless/src/proxy/CodexResponsesAdapter.ts`.

The Codex adapter's `handleFrame` switch
(`CodexResponsesAdapter.ts:459`) is structurally identical to the
Claude adapter's `applyAnthropicEvent`. Same helper pattern:

```ts
private publishPhase(
  flow: FlowState,
  phase: StreamPhase,
  extras: { toolName?: string; callId?: string } = {},
): void {
  if (flow.attribution !== 'active') return
  if (flow.phase === phase &&
      flow.phaseToolName === (extras.toolName ?? null) &&
      flow.phaseCallId === (extras.callId ?? null)) return
  flow.phase = phase
  flow.phaseToolName = extras.toolName ?? null
  flow.phaseCallId = extras.callId ?? null
  this.headless.semantic.publishStreamPhase({
    turnId: flow.responseId,
    phase,
    toolName: extras.toolName,
    toolUseId: extras.callId,     // channel event field is provider-neutral
    source: 'proxy',
    confidence: 'high',
  })
}
```

Extend `FlowState` (`CodexResponsesAdapter.ts:91`) with:

```ts
phase: StreamPhase               // last emitted; 'idle' at flow creation
phaseToolName: string | null     // for dedupe
phaseCallId: string | null       // for dedupe
openToolCalls: Set<string>       // itemIds of tool-call blocks not yet .done
```

Full event table. All events are the JSON payload type under `data:`
on the SSE frame:

| Responses event | Precondition | Phase action |
|---|---|---|
| First `response-chunk` that promotes `candidate → active` (`CodexResponsesAdapter.ts:283`) | `flow.phase === 'idle'` | `requesting` (turnId still null) |
| `response.created` (`:461`) | `phase === 'requesting'` | re-emit `requesting` now that `responseId` is set, so the renderer re-keys off the real turnId |
| `response.in_progress` (`:461`) | — | no emit (pure noise; the prior `requesting` stays correct) |
| `response.output_item.added` kind=`message` (`:479`) | — | `responding` |
| `response.output_item.added` kind=`reasoning` (`:479`) | — | `thinking` |
| `response.output_item.added` kind=`function_call` / `custom_tool_call` / `local_shell_call` / `web_search_call` / `image_generation_call` / `tool_search_call` (`:479`) | — | `tool-input` + `toolName = item.name` (or `item.action?.type` for web_search / image_generation fallback) + `callId = item.call_id ?? itemId`. Also `openToolCalls.add(itemId)` |
| `response.output_item.added` kind=`compaction` / `ghost_snapshot` (`:479`) | — | `compacting` (Codex-only; the renderer override is a belt-and-braces path for Claude, but Codex can emit this directly from the wire) |
| `response.output_text.delta` (`:526`) | phase is `responding` | no emit (stream is steady) |
| `response.reasoning_summary_text.delta` / `response.reasoning_text.delta` (`:569`) | phase is `thinking` | no emit. Track split (`summary` / `full`) stays on the existing `SemanticThinkingDeltaEvent`; phase does not care. |
| `response.output_item.done` kind=tool variant (`:613`) | `openToolCalls.has(itemId)` | `openToolCalls.delete(itemId)`. Phase stays `tool-input` — the call is now fully formed but we haven't seen `response.completed` yet and more blocks may still open. |
| `response.output_item.done` kind=`message` / `reasoning` / `compaction` / other (`:613`) | — | no emit. The next `output_item.added` or `response.completed` will change phase. |
| `response.completed` (`:812`) | `openToolCalls.size > 0` | `awaiting-tool` + `toolName` = most-recently-added open call. Codex's agent loop will now execute the tools locally and open a NEW request with the outputs injected. Next `request → response.created` will flip back to `requesting → thinking`. |
| `response.completed` (`:812`) | `openToolCalls.size === 0` | `idle` |
| `response.failed` (`:835`) | — | `idle`. `publishApiError` already surfaces the error via the existing path. |
| `response.incomplete` (`:864`) | — | `idle`. `publishTurnStopped` already carries the stop reason. |
| `response-end` without a prior `response.completed` (`:329`) | phase not `idle` | `idle`. Defensive close, mirrors the flow at `:347-355`. |
| `response-error` / `upstream-error` (`:365`) | — | `idle`. |

**Why `openToolCalls` and not just a flag.** Codex can emit multiple
tool calls in one response (`function_call` × N before any output).
Each is a separate `output_item`. A flag would miss the "2 of 3
completed when `response.completed` fires" case that still needs
`awaiting-tool`. A set per-flow is the minimum data structure to
answer "any tool calls still pending when the response ended?"
correctly.

**Why `pendingToolName` tracks the latest open tool when multiple
are in flight.** The in-feed WorkIndicator shows one tool hint at a
time; the newest open call is what the user last saw the model
produce. Acceptable approximation; the renderer does not need a full
list.

**Tool output correlation.** Codex pairs `function_call` (itemId A,
call_id C) with `function_call_output` (itemId B, same call_id C). The
`function_call_output` may arrive inside the SAME `/v1/responses` (if
the upstream model self-executes — rare) OR in a LATER response after
the agent loop runs the tool locally. In both cases the phase path is
the same: `awaiting-tool` clears when the NEXT `request` lands
(renderer flips to `requesting`) or, if it arrived in-response, when
the matching `output_item.done` lands for the output (phase transitions
naturally via the next `output_item.added`).

Claude and Codex converge on the same vocabulary. The adapter builds
its own `publishPhase` helper with the same shape; the
`SemanticChannel` on the Codex side gains the identical
`publishStreamPhase` API. Since the two headless packages each have
their own copy of `SemanticChannel`, this is a parallel edit — the
duplication is already baked into the package split and should not be
collapsed here.

### 3a. Codex rollout-source phase (proxy disabled)

**File:** `codex-headless/src/CodexHeadless.ts` —
`ingestRolloutIntoSemantic` at `:825`.

Codex is the one provider where the rollout tailer is a legitimate
live producer: `agent_message_delta` / `task_started` / `task_complete`
/ `exec_command_begin` / `exec_command_end` / `mcp_tool_call_begin` /
`mcp_tool_call_end` arrive as the session runs. When the proxy is off
this is the sole authoritative source. Extend this method to also
publish `stream_phase`, so proxy-off Codex sessions still get a
populated field instead of defaulting to `idle` forever.

Per-event mapping. `this.liveSemanticTurnId` identifies the active
rollout-sourced turn; the phase helper reads it directly.

| Rollout event (in `CodexEventMsg.type`) | Phase action |
|---|---|
| `task_started` / `turn_started` (`:836`) | `thinking` with `turnId = e.turn_id`. Rollout gives us no structural difference between reasoning and text; we pick `thinking` because that's the generic pre-output state and the model almost always reasons before text. |
| `agent_message_delta` (`:871`) | `responding`. First delta is the earliest reliable "model is emitting text" signal on the rollout path. |
| `agent_message` (`:896`) | no emit. Final snapshot; phase already reflects the stream state. |
| `exec_command_begin` (`:926`) / `mcp_tool_call_begin` (`:959`) | `tool-use` with `toolName = e.command[0] ?? "exec"` / `${server}.${tool}`, `callId = e.call_id`. Rollout doesn't stream `input_json_delta`, so we skip `tool-input` and go straight to `tool-use`. |
| `exec_command_output_delta` (`:938`) | no emit. The tool is still running; phase stays `tool-use`. |
| `exec_command_end` (`:949`) / `mcp_tool_call_end` (`:974`) | revert to the phase that was active before the tool started. In practice, if the turn is still live, that's `thinking` (Codex typically emits more reasoning / text after a tool result); if the turn ended, `task_complete` below will drive `idle`. Simplest correct implementation: emit `thinking` here and let the next `agent_message_delta` (if any) re-emit `responding`. |
| `task_complete` / `turn_complete` (`:913`) | `idle`. |

The rollout path does NOT publish `awaiting-tool`. Rollout is
retrospective — by the time it sees the event, the tool has already
run. The proxy path is the only place `awaiting-tool` is meaningful,
because only the proxy sees the `response.completed` → agent loop → next
`request` gap where the tool actually blocks.

### 3b. Codex live-owner interaction

`CodexHeadless` has a formal live-owner model at `:252-628`: proxy /
rollout / screen compete for authority over the main semantic channel.
Transitions already call `transitionLiveOwner` (`:585`) which finalizes
the outgoing source. The phase publisher needs one small rule to
harmonize with that:

- Whenever `liveOwner.kind` transitions to `null` (via `clearLiveOwner`
  at `:557`), emit `stream_phase: idle` with the previous owner's
  source. This is the single "session went quiet" signal. Without it,
  a turn that ends via an exceptional path (e.g. `response-end` without
  `response.completed` followed by a rollout `task_complete` seconds
  later) could leave `streamPhase` stale for the gap.

Screen ownership (`:353`) never publishes phase on the main channel —
it publishes to `semanticShadow` which the renderer does not subscribe
to. That's consistent with the file-header design rule in
`channels/SemanticChannel.ts:41-60`: the main semantic channel is
strict, screen is overlay/bootstrap only. For the renderer, screen
ownership looks like `streamPhase: idle` until rollout or proxy claim
the slot — which is the correct degraded-mode behaviour (proxy off,
rollout hasn't caught up, screen is just for TUI fidelity).

### 4. Screen fallback (useProxy=false)

**File:** `claude-code-headless/src/ClaudeCodeHeadless.ts` around
`:377-432`.

The screen-spinner detector stays. Extend its branch:

- On the idle → active transition, AFTER `publishActivity` and
  `startTurn`, emit `publishStreamPhase({ phase: 'thinking', source: 'screen',
  confidence: 'fallback' })`. We use `'thinking'` as the bucket because
  the screen path cannot distinguish thinking from responding (the
  spinner verb is the same for both). That is the right conservative
  default — renderers that want finer detail should keep the proxy on.
- On the active → idle transition (post-debounce), emit
  `publishStreamPhase({ phase: 'idle', … })`.

This is the one place phase is approximated. It happens inside the
headless package, never crosses the renderer boundary as a screen-vs-
proxy toggle, and only fires when the proxy is off (the existing
`if (!this.proxy)` guard at `:411` already gates screen-derived
`startTurn`; we add the same guard to the phase publish).

Codex-headless has a parallel TUI detector
(`codex-headless/src/CodexHeadless.ts:237+`) — same treatment there.

### 5. Renderer: consume the event, stop deriving

**File:** `src/renderer/src/tiles/workspaceState.ts`.

Add to `SessionRuntime`:

```ts
streamPhase: StreamPhase
streamPhasePendingToolName: string | null
streamPhasePendingToolUseId: string | null
turnStartedAt: number | null
phaseChangedAt: number | null
submittedAt: number | null
```

Re-export `StreamPhase` from `workspaceState.ts` so consumers don't
reach into the headless package.

**File:** `src/renderer/src/tiles/workspaceStore.ts`.

Add one reducer case inside the existing semantic-event switch near
`:697+`:

```ts
case 'stream_phase': {
  const phase = String(ev.phase ?? 'idle') as StreamPhase
  // Phase transitions are idempotent — ignore duplicates so the
  // reducer doesn't churn timestamps.
  if (phase === runtimeState.streamPhase) break
  const now = Date.now()
  runtimeState.streamPhase = phase
  runtimeState.streamPhasePendingToolName =
    typeof ev.toolName === 'string' ? ev.toolName : null
  runtimeState.streamPhasePendingToolUseId =
    typeof ev.toolUseId === 'string' ? ev.toolUseId : null
  runtimeState.phaseChangedAt = now
  if (phase === 'idle' || phase === 'exited') {
    runtimeState.turnStartedAt = null
    runtimeState.submittedAt = null
  } else if (runtimeState.turnStartedAt === null) {
    runtimeState.turnStartedAt = now
  }
  break
}
```

Add a second reducer case for `tool_result` events: if
`streamPhasePendingToolUseId === ev.toolUseId` and
`streamPhase === 'awaiting-tool'`, flip phase back to whatever comes
next; the next `stream_phase` emit from the adapter will overwrite. In
practice the adapter's next event after a tool_result is usually a
`message_start` for the continuation turn (phase → `requesting`), so
the "flip back" window is short. Correct default for the gap:
`streamPhase = 'requesting'` the moment a pending tool resolves, so the
indicator doesn't stay amber on a cleared tool.

On the optimistic-submit path
(`workspaceStore.ts:3493` `setStreamingBaseline`): set
`submittedAt = Date.now()` and `streamPhase = 'submitting'`. Clear on
the next phase event.

**Delete** the old renderer-side phase-derivation files when they land
— `workPhase.ts` is not built yet, so nothing to delete; the legacy
`activityStatus` field stays only for the DebugPanel diagnostic row,
wired directly off the `activity`/`idle` IPC as today.

### 6. UI: `<WorkIndicator phase={runtime.streamPhase} .../>`

Unchanged from the previous plan's `WorkIndicator` component and its
three variants (`header` / `footer` / `strip`). The only change is the
prop wiring — it reads `runtime.streamPhase` directly instead of
calling `deriveWorkPhase(runtime)`. The elapsed-time hook stays; it
takes `runtime.turnStartedAt` as the since-timestamp.

Live-thinking collapse (Pass 3 in the old plan) and pane-chrome /
tab-dot tone-down (Pass 4) are unchanged. They read `streamPhase`,
they don't care how it was derived.

## Order of implementation

Each step is independently deployable.

| # | Step | Files | Risk | User-visible change |
|---|---|---|---|---|
| 1 | Add `SemanticStreamPhaseEvent` type + channel publisher (Claude side) | `claude-code-headless/src/channels/types.ts`, `SemanticChannel.ts` | low — pure additive type + publisher | none |
| 2 | Derive phase in `ClaudeProxyAdapter.applyAnthropicEvent` | `ClaudeProxyAdapter.ts` | medium — touches the hot event loop; covered by existing adapter tests | none yet (renderer not consuming) |
| 3 | Same for Codex adapter | `codex-headless/src/proxy/CodexResponsesAdapter.ts`, Codex's `SemanticChannel.ts` / `types.ts` | medium — identical pattern but in parallel package | none yet |
| 3a | Codex rollout-source phase (`ingestRolloutIntoSemantic`) | `codex-headless/src/CodexHeadless.ts` | low — additive on an existing fold | none yet (covers proxy-off Codex) |
| 3b | Emit `idle` on `clearLiveOwner` | `codex-headless/src/CodexHeadless.ts` | trivial | none yet |
| 4 | Screen-fallback phase publish (Claude only; Codex screen is shadow-only and publishes no phase) | `ClaudeCodeHeadless.ts` | low — only active when `useProxy=false` | none yet |
| 5 | Renderer reducer case + `SessionRuntime` fields | `workspaceState.ts`, `workspaceStore.ts`, `DebugPanel.tsx` | low | DebugPanel shows `streamPhase` |
| 6 | `WorkIndicator` component, pass through `runtime.streamPhase` | `components/WorkIndicator.tsx`, `Feed.tsx`, `TileLeaf.tsx`, `TabBar.tsx`, `styles.css` | medium | single coherent indicator visible across surfaces |
| 7 | Collapse live thinking; tone down pane header and tab badge | `Feed.tsx`, `TileLeaf.tsx`, `TabBar.tsx` | low | final polish |

Steps 1–4 are invisible to the user. Step 5 only changes DebugPanel.
Steps 6–7 are the visible rework and were already scoped in the
previous plan.

## Verification

Headless-package unit tests (without a PTY, already an established
pattern — see `claude-code-headless/src/testing/proxy-testing/`):

- **Fixture:** a captured mitmproxy transcript for a representative
  turn that exercises `thinking → tool_use → tool_result →
  responding → message_stop`. Play it through the adapter; assert the
  sequence of `stream_phase` events is exactly
  `requesting → thinking → tool-input → awaiting-tool → requesting →
  responding → idle`.
- **Fixture:** a multi-flow race (warmup POST + real turn). Assert
  only the real turn publishes `stream_phase`; the warmup flow stays
  silent.
- **Codex:** same shape, different fixture.

Manual, in the app:

- Submit a Claude prompt with a tool call. DebugPanel phase transitions
  should match the table above.
- Disable proxy (`useProxy=false`). DebugPanel should show the
  fallback phases (`thinking` / `idle`) driven by the screen spinner.
  No `requesting` / `responding` / `tool-input` — that's the
  documented degradation.
- Submit a Codex prompt. Same vocabulary, same transitions.

## Risks

- **Adapter hot-loop perf.** `applyAnthropicEvent` runs once per SSE
  record. Adding a `publishStreamPhase` call on ~5 branches adds a few
  property writes + an `emit` per call. The channel already dedupes
  (`lastPhase` guard), so in steady state (long `text_delta` runs) we
  emit zero extra events. Profile a 2K-token turn to confirm no
  regression.

- **Duplicate emits on re-entry.** `content_block_start: text`
  followed by `text_delta` followed by another `content_block_start:
  text` (second text block after a tool call) would emit `responding`
  twice. The channel's `lastPhase` dedupe fixes the first one; the
  second is actually new so it should emit. Verify with the fixture.

- **Claude vs Codex channel divergence.** Two separate
  `SemanticChannel.ts` files each gain the same publisher. Keep them
  byte-identical where possible — the parallel structure is already
  documented
  (`codex-headless/src/proxy/CodexResponsesAdapter.ts:13`). Copy-paste
  is correct here; collapsing the packages is out of scope for this
  plan.

- **Screen fallback over-reports 'thinking'.** A screen-only session
  shows `thinking` for the entire turn because the spinner can't
  distinguish. Acceptable — the whole point of this plan is that
  screen fallback is degraded by design. Users who want finer phase
  detail keep the proxy on.

- **`awaiting-tool` sticks when a tool_result is produced outside
  the adapter path.** If the tool_result gets published by the
  committed (JSONL) channel before the renderer reducer clears the
  pending state, the indicator sits in amber. The renderer reducer's
  `tool_result` case clears it; verify the timing for both
  providers with a fixture.

## Rollback

- Steps 1–4 are pure additions. Revert the file diffs; renderer never
  started consuming the event, so no state is stranded.
- Step 5 adds optional fields to `SessionRuntime`. Remove them; nothing
  downstream yet.
- Step 6 swaps a component. Revert to the legacy `ActivityIndicator`.
- Step 7 is pure UI polish.

No headless-package ABI breakage: the new event is additive on the
union, all new fields are optional.

## Out of scope

- **Collapsing the two `SemanticChannel` implementations** across
  packages. Parallel structure is already the intentional design.
- **Changing proxy attribution policy.** Covered by
  `2026-04-17-codex-semantic-flicker-fix.md`. Orthogonal.
- **Renderer redesign of the indicator visuals.** Covered by
  `2026-04-18-thinking-indicator-rework.md`. This plan replaces that
  doc's derivation section only.
- **Tokens/s / elapsed rate in the adapter.** Usage is already
  published via `SemanticUsageEvent`. Token-rate computation happens
  renderer-side off that event and turnStartedAt; not in the adapter.
- **Mapping `streamMode` to a user-visible label.** That is a
  `WorkIndicator` concern. The adapter emits machine-readable phase
  names, not labels.
