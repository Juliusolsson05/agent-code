# Headless Channel Model for a First-Principles Feed

This note is based on the pinned submodule commits in this worktree:

- `packages/codex-headless` at `fc9bb1f1c47c2a4df7e350d4fd89110e97f42fe2`
- `packages/claude-code-headless` at `df670b4cb3a3d8ee04750187a68242d67ce9c03d`

The renderer should treat headless as three separate input planes, not as one blended event stream:

- `semantic`: live model meaning. This is the only plane that may create a live assistant row.
- `screen`: terminal paint and overlays. This may drive modals, mirror panes, activity diagnostics, and coarse work state, but not assistant text.
- `committed`: durable transcript / rollout history. This is the only plane that may create persisted Feed entries.

That split is the core invariant. Feed should not be the place where we decide whether text came from a provider stream, a terminal scrape, or a committed JSONL line. Headless must normalize that before the data reaches Feed, because only headless can see proxy state, rollout state, screen state, tail ownership, and terminal lifecycle at the same time.

## Current Shape

Claude's renderer-facing semantic path is proxy-first. When `ClaudeCodeHeadless` is constructed with `proxy`, `ClaudeProxyAdapter` publishes directly to `headless.semantic`; screen-derived assistant text is routed to `semanticShadow`. Without proxy, screen text still lives on `semanticShadow`, while only coarse `stream_phase` events may reach the authoritative semantic channel. That means a first-principles renderer should expect degraded Claude-without-proxy live text by design, not resurrect the old screen extractor in Feed.

Codex has two authoritative live semantic sources: rollout and proxy. Rollout is a live owner because Codex writes `event_msg` deltas such as `task_started`, `agent_message_delta`, `turn_complete`, exec events, and MCP events to `rollout-*.jsonl`. Proxy is a live owner when `CodexResponsesAdapter` observes `/responses` SSE. Screen fallback is explicitly shadow-only for assistant content.

Both packages expose strict `SemanticChannel` implementations. `startTurn` while another turn is active, `applyDelta` without the active turn, and mismatched `finishTurn` are dropped and emitted as `lifecycle_violation` diagnostics. This is the right boundary: the channel is a transport, not a healer. Producer coherence belongs in the headless orchestrator.

## Ownership Invariants

At most one renderer-facing live semantic owner may exist per session:

- Claude owners: `proxy` or `screen`, where `screen` is a shadow/debug owner and must not publish assistant content to `semantic`.
- Codex owners: `proxy`, `rollout`, or `screen`, where `screen` is again shadow/debug for assistant content.
- `jsonl` / committed transcript is not a live owner. It reconciles and persists history.

Owner transitions must be explicit:

- `screen -> proxy` and `screen -> rollout` must finalize the shadow turn and clear screen-specific baseline state.
- Claude `proxy turn_completed` enters `reconciling`, because SSE completion precedes JSONL durability. A later new owner may evict that reconciling owner.
- Codex `proxy` and `rollout` currently clear owner on `turn_completed`; per-message `response_item` commits may clear live text before the full rollout turn closes.
- No Feed path should infer owner transitions from text equality, scroll position, or terminal idle.

## Proxy Flow Selection

Claude flow attribution is first-chunk based. Requests start as candidates; the first SSE chunk promotes a flow to active and emits `flow_selected`. Concurrent chunking flows become secondary and emit `flow_ignored`. Sidecar calls can be demoted at `message_start` once the model/request shape identifies them as auxiliary; that demotion clears the brief `requesting` phase before switching attribution to secondary.

Codex mirrors the same active-flow lock using proxy `requestId`. `ResponsesProxy` mints a monotonic `requestId` for every forwarded request, and `CodexResponsesAdapter` routes chunks by that id instead of by path. This avoids merging retry streams and overlapping `/responses` calls. `response.completed` releases the active slot before socket `response-end`, which is necessary because follow-up tool-output requests can begin before the old socket closes.

Feed should consume `flow_selected` / `flow_ignored` only as diagnostics. They are not render rows. The renderable unit begins at `turn_started` plus block/turn deltas.

## Stream Phase

`stream_phase` is the only model-work affordance Feed should use. It can represent `submitting`, `requesting`, `thinking`, `responding`, `tool-input`, `tool-use`, `awaiting-tool`, and `idle` depending on provider support.

The phase stream is not equivalent to a semantic live turn. A session can be `requesting` before a turn id exists, `awaiting-tool` after a turn completed, or `thinking` from a coarse screen fallback with no renderable assistant text. WorkIndicator should remain phase-driven and independent of whether `SemanticStreamingTurn` is mounted.

One caveat: Codex screen activity still publishes coarse `thinking` / `idle` phase events to the authoritative semantic channel whenever the live owner is not `proxy`. That is useful because rollout does not derive fine-grained phase today, but it means screen may still overwrite phase while rollout owns live content. Treat screen-sourced phase as fallback status only; do not let it mutate semantic text or block state.

## Committed Channel

Committed data is Feed history, not live semantics.

Claude `CommittedChannel` emits raw `entry`, `turn_committed`, `compact_boundary`, and committed `tool_result`. Moving `tool_result` off the semantic channel is important: Anthropic SSE does not carry tool results; they arrive later in a user-role JSONL entry. Feeding them back into live semantics forced the renderer to keep ended assistant turns alive.

Codex `CommittedChannel` emits every rollout line as `rollout_line`, emits `session_meta`, emits every `response_item`, and promotes message response items to `turn_committed`. Codex can commit multiple response items inside one rollout turn. The committed feed may therefore own individual assistant/tool fragments before the live rollout/proxy turn has fully ended.

Before data reaches Feed, committed ownership must be expressed structurally:

- A committed assistant text block must suppress the matching finalized live text.
- A committed tool-use id must suppress all matching live tool/input/output blocks.
- A committed row must never be represented as a semantic mutation of the current live turn.

Today Feed still contains exact-text and tool-id duplicate filters inside `SemanticStreamingTurn`. Those filters are useful guardrails, but a first-principles renderer should treat them as upstream invariants to enforce earlier: live render units handed to Feed should already be filtered against committed ownership.

## Rollout Tail Ownership

Codex resume tailing has special ownership rules because Codex can append to the old rollout or fork into a new rollout. `tailResumeRolloutFile` tails the found file, fingerprints prior item ids, and watches for a bounded window for a same-cwd rollout with lineage overlap. When a fork is accepted it opens the new tail before closing the stale one, so no write window is missed. This may replay copied history, but downstream dedupes by deterministic entry identity.

The renderer should not care which file owns the tail. Headless must guarantee that exactly one committed lineage is current, that stale resume files do not permanently starve committed entries, and that a successful switch is not surfaced as a transcript error.

Claude resume is simpler: it tails the requested JSONL with a bounded bootstrap tail and then follows appends. Bootstrap entries are committed history, not live semantics.

## Lifecycle Violations Found

The strict semantic channels are correct, but Codex has a real rollout soft-open bug in `ingestRolloutIntoSemantic`. The `agent_message_delta` branch says that if no live turn exists it opens a rollout-sourced turn on the fly, but the implementation only sets local fields and then calls `semantic.applyDelta`. Because `SemanticChannel.applyDelta` is strict, this delta is dropped as `delta_mismatched_turn` when no `task_started` / `turn_started` preceded it. The renderer reducer has a soft-open branch for `turn_delta`, but it never sees the event if headless drops it first. The invariant should be: every rollout delta without an active channel turn must first call `semantic.startTurn({ source: 'rollout' })`, or the comment should be removed and the delta intentionally dropped.

Codex `response_item` fallback correctly opens, publishes, and seals when no live turn exists. That makes the `agent_message_delta` branch the outlier.

Block-level publishers are intentionally stateless in both semantic channels. That is acceptable only if adapters never publish block events outside an owned turn. The renderer reducer defensively rejects cross-turn block events, but Feed should not rely on reducer rejection as normal control flow. Lifecycle violations should be considered headless bugs or adapter attribution misses.

## Feed Invariants

Before anything reaches Feed, the session runtime should be able to assert:

1. There is at most one `semantic.currentTurn` for the session.
2. Every live text/block event has an explicit `turnId`, `source`, and `confidence`.
3. `source: 'screen'` assistant content is not on the renderer-facing semantic channel.
4. `screen` events are visual state only: snapshots, activity, trust dialogs, approvals, resume prompts, slash picker, compaction UI.
5. `committed` events are append-only durable history and are safe to persist.
6. Committed data never mutates a live semantic turn.
7. A live turn that has completed but is waiting for tools may remain mounted, but only until matching tool results/completions resolve or a valid sequential next turn replaces it.
8. `stream_phase` may be turnless, and Feed must not require a live semantic turn to show work.
9. `flow_selected`, `flow_ignored`, `live-owner-change`, and `lifecycle_violation` are diagnostics. They may inform debug UI and tests, but not normal Feed rows.
10. Any duplicate suppression needed because committed history caught up must be deterministic by provider ids or exact committed text, never by prefix/fuzzy matching in Feed.

The first-principles renderer should therefore consume a single normalized model:

- `entries`: durable committed rows.
- `semanticHistory`: short-lived archived semantic turns that committed history has not fully superseded.
- `semanticTurn`: the one current live turn, if any.
- `streamPhase`: current work state, independent of rows.
- `screenOverlays`: visual terminal UI state.

Feed should render that model directly. It should not subscribe to raw terminal snapshots, parse assistant text from screen, select proxy flows, choose rollout tails, or decide which producer owns the live turn. Those are headless/runtime responsibilities.
