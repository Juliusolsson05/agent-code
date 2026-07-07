# Upstream Codex Rendering Findings

Inspection note: `vendor/codex-src` is an empty submodule in this worktree, so the source below was read from the populated checkout at `/Users/juliusolsson/Desktop/Development/agent-code/vendor/codex-src`. Paths are still written as `vendor/codex-src/...` because that is the intended repository layout.

## High-Level Model

Upstream Codex has three distinct but overlapping streams of truth:

- Model/provider stream: `codex-api::ResponseEvent` in `vendor/codex-src/codex-rs/codex-api/src/common.rs`.
- Core UI/event protocol: `codex_protocol::protocol::Event` and `EventMsg` in `vendor/codex-src/codex-rs/protocol/src/protocol.rs`.
- Durable rollout log: JSONL `RolloutLine` wrapping `RolloutItem` in `vendor/codex-src/codex-rs/protocol/src/protocol.rs`, filtered by `vendor/codex-src/codex-rs/rollout/src/policy.rs`.

The TUI does not render directly from raw provider deltas. Core translates provider events into higher-level item lifecycle events and legacy events, then the TUI keeps transient streaming controllers for live text while separately inserting durable history cells for completed tools, patches, user messages, plans, and final assistant content.

## Event Protocol

Key source files:

- `vendor/codex-src/codex-rs/protocol/src/protocol.rs`
- `vendor/codex-src/codex-rs/protocol/src/models.rs`
- `vendor/codex-src/codex-rs/protocol/src/items.rs`
- `vendor/codex-src/codex-rs/codex-api/src/common.rs`
- `vendor/codex-src/codex-rs/core/src/codex.rs`
- `vendor/codex-src/codex-rs/core/src/stream_events_utils.rs`

Important structs/enums:

- `Op`: client-to-core commands. Relevant variants include `UserInput`, `UserTurn`, `OverrideTurnContext`, `Interrupt`, `ExecApproval`, `PatchApproval`, realtime ops, and approval/input responses.
- `Event { id, msg }`: core-to-client envelope. `id` correlates live events with a submission; replayed TUI events use `None` internally and must not be used for follow-up correlation.
- `EventMsg`: UI-facing event union. It contains both legacy events such as `AgentMessage`, `AgentMessageDelta`, `ExecCommandBegin/OutputDelta/End`, `PatchApplyBegin/End`, `TurnStarted`, `TurnComplete`, `UserMessage`, and newer lifecycle events such as `ItemStarted`, `ItemCompleted`, `AgentMessageContentDelta`, `PlanDelta`, `ReasoningContentDelta`, `ReasoningRawContentDelta`.
- `ResponseItem`: persisted/model-visible item union. Includes `Message { role, content, phase }`, `Reasoning`, tool calls and outputs, web/image calls, compaction, ghost snapshots.
- `MessagePhase`: distinguishes `commentary` from `final_answer` when available. Upstream treats it as optional because not all providers emit it.
- `TurnItem`: UI/domain item union produced from completed response items: `UserMessage`, `HookPrompt`, `AgentMessage`, `Plan`, `Reasoning`, `WebSearch`, `ImageGeneration`, `ContextCompaction`.
- `ResponseEvent`: raw model stream events: `Created`, `OutputItemAdded`, `OutputTextDelta`, `ReasoningSummaryDelta`, `ReasoningContentDelta`, `ReasoningSummaryPartAdded`, `OutputItemDone`, `Completed`, plus metadata events.

Core stream flow:

- `try_run_sampling_request` in `core/src/codex.rs` loops over `ResponseEvent`.
- `OutputItemAdded` converts non-tool response items via `handle_non_tool_response_item`, emits `ItemStarted`, and records `active_item`.
- `OutputTextDelta` only becomes visible assistant text if `active_item` is an `AgentMessage`. It is parsed through `AssistantMessageStreamParsers` and emitted as assistant text or plan deltas.
- `ReasoningSummaryDelta` and `ReasoningContentDelta` are emitted as item-scoped reasoning delta events, not as normal assistant rows.
- `OutputItemDone` flushes pending assistant text for the prior active item, then `handle_output_item_done` either records a tool call and queues execution or emits `ItemCompleted`.
- `Completed` flushes all assistant text parser segments, updates token usage, and allows a `TurnDiff` after the stream finishes.

Implication: our render selector should model the provider stream, core protocol stream, and persisted rollout stream as different layers. Rendering from persisted `ResponseItem`s alone is incomplete for live UI, while rendering every delta as a durable row duplicates final/completed items.

## Tool Calls And Follow-Up Turns

Key source files:

- `vendor/codex-src/codex-rs/core/src/stream_events_utils.rs`
- `vendor/codex-src/codex-rs/core/src/codex.rs`
- `vendor/codex-src/codex-rs/protocol/src/models.rs`
- `vendor/codex-src/codex-rs/protocol/src/protocol.rs`

Tool-call handling is centralized in `handle_output_item_done`:

- `ToolRouter::build_tool_call` recognizes tool-call `ResponseItem`s.
- Tool calls are recorded immediately through `record_completed_response_item`.
- A tool future is queued into `in_flight`, and `needs_follow_up = true`.
- Tool outputs are drained after stream completion and converted back into model input for the next sampling request.

This means a single user turn may contain multiple sampling requests: assistant commentary, one or more tools, tool outputs, then follow-up model calls until no tool requires a follow-up. The UI-facing `TurnStarted`/`TurnComplete` envelope is larger than one provider `response.completed`.

Implication: a first-principles selector should key turn lifecycle off `TurnStarted`/`TurnComplete` and item/tool call ids, not off provider response ids or a naive final message heuristic.

## Rollout Persistence

Key source files:

- `vendor/codex-src/codex-rs/protocol/src/protocol.rs`
- `vendor/codex-src/codex-rs/rollout/src/policy.rs`
- `vendor/codex-src/codex-rs/rollout/src/recorder.rs`

Durable format:

- `RolloutLine { timestamp, #[flatten] item }`
- `RolloutItem::SessionMeta`
- `RolloutItem::TurnContext`
- `RolloutItem::ResponseItem`
- `RolloutItem::Compacted`
- `RolloutItem::EventMsg`

Persistence policy:

- All meaningful `ResponseItem`s persist except `Other`.
- `SessionMeta`, `TurnContext`, and `Compacted` always persist.
- Limited event persistence includes `UserMessage`, final `AgentMessage`, final reasoning, `TokenCount`, thread metadata, context compaction, review enter/exit, rollback, undo completion, `TurnStarted`, `TurnComplete`, `TurnAborted`, and image generation end.
- Extended event persistence additionally includes final/error-ish tool events such as `Error`, `ExecCommandEnd`, `PatchApplyEnd`, `McpToolCallEnd`, `WebSearchEnd`, guardian assessment, dynamic tool request/response, collab end events.
- Streaming deltas, begin events, approval prompts, `StreamError`, `TurnDiff`, `ItemStarted`, most item deltas, and hook lifecycle events do not persist.

`RolloutRecorder::record_items` filters and sanitizes before sending `RolloutCmd::AddItems`. The writer keeps `pending_items` until successful JSONL write, flushes on barriers, and retries once after reopening the file. `load_rollout_items` parses line-by-line, keeps parse errors non-fatal, and uses the first `SessionMeta` as canonical thread id.

Implication: rollout replay is intentionally a completed/history reconstruction, not a byte-for-byte live event replay. The render selector should not require persisted begin/delta events to rebuild stable history; it should derive stable rows from completed `ResponseItem` and persisted completion events.

## TUI Rendering Model

Key source files:

- `vendor/codex-src/codex-rs/tui/src/chatwidget.rs`
- `vendor/codex-src/codex-rs/tui/src/streaming/controller.rs`
- `vendor/codex-src/codex-rs/tui/src/streaming/commit_tick.rs`
- `vendor/codex-src/codex-rs/tui/src/streaming/chunking.rs`
- `vendor/codex-src/codex-rs/tui/src/insert_history.rs`
- `vendor/codex-src/codex-rs/tui/src/history_cell.rs`
- `vendor/codex-src/codex-rs/tui/src/exec_cell/model.rs`
- `vendor/codex-src/codex-rs/tui/src/exec_cell/render.rs`

`ChatWidget` owns render state derived from `EventMsg`:

- `active_cell`: in-place mutable current history cell for active tool/exec groups.
- `stream_controller`: live assistant markdown stream.
- `plan_stream_controller`: live proposed-plan markdown stream.
- `running_commands`, `unified_exec_wait_streak`, `last_unified_wait`: active command/progress state.
- `agent_turn_running`, `task_complete_pending`, `current_status`: status/progress state.
- `needs_final_message_separator`, `had_work_activity`: separator state between work and final message.
- `pending_status_indicator_restore`: commentary/final-answer status restoration state.
- `last_rendered_user_message_event`, `pending_steers`: user-message dedupe/steer state.

Live assistant text:

- `on_agent_message_delta` calls `handle_streaming_delta`.
- `handle_streaming_delta` flushes active exec/wait cells first, creates `StreamController` if absent, queues deltas, and starts commit animation only when complete lines are available.
- `StreamController` buffers markdown until newline boundaries, emits `AgentMessageCell`s, and marks only the first emitted chunk as first/header-bearing.
- `finalize_completed_assistant_message` ignores final payload if a stream controller already exists because the visible content was accumulated through deltas. If no stream controller exists, it renders the completed message through the same streaming path before finalizing.

Plan streaming:

- `PlanDelta` is only honored in plan mode.
- `PlanStreamController` emits a proposed-plan header once, prefixes/stylizes plan lines, and finalizes with bottom padding.
- `ItemCompleted(TurnItem::Plan)` records/copies the final plan text and either accepts the streamed cell or renders a non-streamed proposed plan.

Status/progress:

- Reasoning deltas do not become history rows. `on_agent_reasoning_delta` extracts a bold header from reasoning text and uses it as a shimmer/status header.
- During stream commit ticks, status is hidden while lines are inserted to avoid duplicate "in progress" affordances.
- Commentary completion sets `pending_status_indicator_restore = true`; final-answer completion or legacy no-phase completion clears it.
- `maybe_restore_status_indicator_after_stream_idle` restores status only after turn still running and stream queues are idle.

Command/tool rows:

- Exec begin/output/end and patch begin/end flush answer streams before inserting tool/progress rows.
- Interruptive UI events are deferred while a stream is active through `InterruptManager`; once anything is queued, subsequent interrupts remain queued to preserve FIFO ordering.
- `handle_exec_end_now` protects against unknown end events mutating the wrong active exec cell.

Terminal insertion:

- `insert_history_lines_with_mode` inserts completed history above the viewport using terminal scroll regions in standard terminals and a Zellij fallback path.
- It pre-wraps lines, treats URL-only lines specially to keep clickable links intact, updates `viewport_area`, and notes inserted scrollback rows.

Implication: upstream avoids duplicate/missing rows by separating "live stream chunk cells" from "final item completion", then suppressing final payload rendering when live deltas already produced the content. Our selector needs the same stateful reconciliation: deltas create/extend a live row; completion either finalizes that row or creates one only when no live row exists.

## Queued And Follow-Up User Input

Key source files:

- `vendor/codex-src/codex-rs/tui/src/chatwidget.rs`
- `vendor/codex-src/codex-rs/tui/src/bottom_pane/chat_composer.rs`
- `vendor/codex-src/codex-rs/tui/src/bottom_pane/pending_input_preview.rs`
- `vendor/codex-src/codex-rs/tui/src/bottom_pane/mod.rs`

Queues:

- `queued_user_messages`: normal follow-up messages held while a turn is running.
- `pending_steers`: messages submitted into an active turn but not yet committed into history.
- `rejected_steers_queue`: steers rejected as not steerable and resubmitted at end of turn before ordinary queued drafts.
- `suppress_queue_autosend`: prevents automatic draining when needed.

Composer behavior:

- `Tab` queues while a task is running; if no task is running, it submits like Enter.
- `Enter` submits immediately.
- `Tab` does not submit a `!` shell command.
- `queue_user_message` pushes into `queued_user_messages` if the session is not configured or task is running; otherwise it submits.
- `maybe_send_next_queued_input` runs only when autosend is allowed and task is idle. It submits exactly one queued item, with rejected steers merged and prioritized.

User-message render dedupe:

- On live `ItemCompleted(TurnItem::UserMessage)`, TUI compares against the front pending steer and `last_rendered_user_message_event`.
- If a pending steer matches, it pops the pending steer and renders that pending event.
- If it does not match but the same event was already rendered, it suppresses duplicate rendering.

Bottom pane preview:

- `PendingInputPreview` renders pending steers first, rejected steers second, queued follow-up messages third.
- The hint line for editing queued messages is shown only when there are ordinary queued messages.

Implication: input queue state is part of rendering correctness. A render selector that only consumes transcript JSONL will miss pending/queued UI surfaces and may duplicate user rows when a steer is both optimistically shown and later committed.

## Duplicate/Missing Streaming Row Invariants

Upstream's practical invariants:

- Only one live assistant stream controller exists for ordinary assistant text.
- Final `AgentMessage` / `ItemCompleted(AgentMessage)` is a reconciliation point, not always a new row.
- If deltas existed, final payload is redundant and should not be rendered again.
- If no deltas existed, final payload must be rendered so non-streaming responses appear.
- Tool/patch/exec rows flush assistant streams first so rows do not interleave ambiguously.
- Begin/delta events are mostly non-durable; completed events and response items carry the stable replay surface.
- Status is hidden while stream chunks are being inserted, then restored only when commentary is done and queues are idle.
- Replayed events are handled differently from live events; replay should not trigger correlation side effects or active-turn status transitions.
- User-message commits are deduped against pending steers and the last rendered user message.

## Implications For Our First-Principles Render Selector

Recommended selector shape:

- Use `turn_id` / submission id / item id / call id as primary identity when available; fall back conservatively only for legacy events.
- Treat live deltas as ephemeral row mutations, not durable transcript facts.
- Treat `ItemCompleted` and persisted `ResponseItem` as durable completion facts.
- Maintain per-turn stream state: `assistant_stream_open`, `plan_stream_open`, `saw_delta_for_item`, `completed_item_by_id`.
- Render final assistant text only when no matching live stream content was emitted for that item.
- Separate progress/status surfaces from transcript rows. Reasoning deltas should drive status unless raw reasoning display is explicitly enabled.
- Flush or close active assistant stream before rendering tool/patch/exec completion rows.
- Reconstruct replay from rollout with "completed history" semantics; do not expect begin/delta rows to exist.
- Model queued input as UI state, not transcript state. Pending steers and queued follow-ups need separate render lanes from committed user messages.
- Preserve commentary vs final-answer phase when present; when absent, use legacy behavior where assistant completion is treated as final.

Most important upstream lesson: Codex does not have a single append-only "row stream". It has a protocol event stream plus transient live render controllers plus a filtered durable rollout. The selector should choose rows by lifecycle state and identity, not by "latest text event wins" or by replaying every event as a visible row.
