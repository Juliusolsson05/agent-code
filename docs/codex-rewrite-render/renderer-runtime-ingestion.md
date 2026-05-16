# Renderer Runtime Ingestion

This note maps the current renderer ingestion path from IPC events into `SessionRuntime`, then lists the invariants a new render/ownership selector must preserve. The relevant code is:

- `src/renderer/src/workspace/hook/ipc/useIpcSubscriptions.ts`
- `src/renderer/src/workspace/semantic/foldEvent.ts`
- `src/renderer/src/workspace/semantic/helpers.ts`
- `src/renderer/src/workspace/workspaceState.ts`
- `src/renderer/src/workspace/hook/actions/initialHistory.ts`
- `src/renderer/src/workspace/hook/actions/session.ts`
- `src/renderer/src/workspace/hook/actions/history.ts`
- `src/renderer/src/workspace/mergedEntries.ts`
- `src/renderer/src/workspace/ghosts.ts`
- `src/renderer/src/workspace/codex/rollout.ts`
- `src/renderer/src/workspace/codex/eventCursor.ts`

## Runtime Shape

`SessionRuntime` is the renderer's per-session state object. For rendering ownership, the load-bearing fields are:

- `entries`: committed, Claude-shaped transcript entries after provider-specific mapping.
- `semantic.currentTurn`: the one active live semantic turn, if any.
- `semantic.history`: a bounded bridge of completed semantic turns that JSONL has not fully replaced yet.
- `ghosts`: provisional assistant entries minted from semantic blocks and persisted through the ghost journal.
- `lastJsonlEntryAt`: newest committed-entry timestamp observed for this session.
- `toolUseIndex` / `toolResultIndex`: committed-entry indices used to suppress live duplicate tool rows.
- `bootstrapping`: bulk replay quiet-window flag; render code treats replay differently from live tailing.

The core model is deliberately multi-owner: committed JSONL owns durable rows, semantic owns the live current turn, semantic history temporarily owns completed-but-not-yet-committed turns, and ghosts own only the fallback case where semantic evidence outlives JSONL.

## IPC Event Flow

`useIpcSubscriptions` installs one effect with all `window.api.onSession*` listeners. Most handlers patch one session runtime by `sessionId`.

### Screen Frames

`onSessionScreen` updates `screen`, `screenMarkdown`, `recentScreen`, `recentScreenMarkdown`, and `picker`. It also mirrors `recent` into `latestScreenRef` for synchronous baseline capture. It is not the source of live assistant rendering anymore. Screen-derived live text must arrive as semantic events tagged with `source: 'screen'`.

The handler aggressively bails out when frame strings and picker state are unchanged. A selector should not infer activity from screen churn; `activityStatus`, `streamPhase`, and semantic/process state are the intended signals.

### Process/Exit/Conditions

`onSessionProcessState` updates `processActive`, `processStatus`, `inputReady`, `activityStatus`, clears optimistic `awaitingAssistant`, and re-derives `sessionStatus`.

`onSessionExit` clears live state: process flags, pending phase, queued messages, `awaitingAssistant`, and `semantic.currentTurn`. It also deletes the Codex rolling turn cursor.

`onSessionConditions` projects provider condition snapshots into prompt state (`pendingApproval`, `pendingTrustDialog`, etc.) and marks attention unread when a prompt appears.

### Semantic Events

`onSessionSemanticEvent` is the live path:

1. Normalize the unknown IPC payload to a record.
2. Look up session kind, defaulting to Claude on missing metadata.
3. Call `foldSemanticEvent(current.semantic, event, sessionKind)`.
4. Update runtime-level stream phase fields for `stream_phase` and matching `tool_result`.
5. Mint/update ghosts from `nextSemantic.currentTurn` via `ghostsFromSemanticTurn`.
6. Persist changed ghosts with `ghostAppend`.
7. Clear optimistic `awaitingAssistant` once semantic activity or terminal semantic errors arrive.
8. Mark ordinary unread on `turn_completed` / `turn_stopped`.

`foldSemanticEvent` owns the one-session-one-semantic-reducer contract. It should be the only place that mutates `SemanticRuntimeState`. UI selectors should read `runtime.semantic`, not subscribe to proxy streams themselves.

The reducer has provider-specific turn ownership:

- Claude may archive a mismatched current turn and open a new one. This self-heals Claude turns kept alive for late cross-turn tool results.
- Codex drops mismatched events while a current turn is still live. This prevents proxy/rollout/screen producers from replacing each other and causing flicker. Codex can replace an already-ended pending-tool turn, and proxy can claim an empty non-proxy shell turn.

Completed turns move to `semantic.history` through `appendSemanticHistory`. That helper replaces by `turnId` and caps the buffer. It keeps full block maps, not just text, because the feed needs renderable structure while JSONL catches up.

### JSONL Bursts

`onSessionJsonlEntries` is the only committed-entry IPC path. Singular JSONL entry handling was removed; live single entries arrive as one-element bursts. The handler does two passes:

1. Workspace metadata pass captures `providerSessionId` from Claude transcript `sessionId` or Codex `session_meta`.
2. Runtime pass maps/filter/dedupes entries, updates committed indices, reconciles optimistic Codex user rows, updates history cursors, reconciles ghosts, and sets `bootstrapping`.

Claude entries:

- Queue-operation records update `queuedMessages` and `awaitingAssistant` but do not enter `entries`.
- Conversation, compact boundary, and compact summary entries enter `entries`.
- Embedded Claude progress entries are extracted before filtering.
- Compact summaries clear `pendingCompaction`.

Codex rollout entries:

- `mapCodexRolloutToFeedEntries` translates rollout lines into Claude-shaped `Entry` objects.
- Synthetic AGENTS.md and `<environment_context>` user messages are dropped in the mapper.
- Tool calls/results are represented as Claude-shaped `tool_use` / `tool_result` blocks, with Codex metadata on block extensions where needed.
- `turn_context` and payload-level `turn_id` maintain a rolling Codex turn id.
- `stampCodexTurnId` attaches that turn id to every mapped entry so ghost and semantic duplicate suppression can correlate committed entries with live Codex turns.
- Terminal Codex task events clear the rolling cursor.

After mapping, the burst updates `lastJsonlEntryAt` from committed entry `timestamp`, not `Date.now()`. That matters on resume: ghost `updatedAt` and transcript timestamps must be compared in the same historical wall-clock space.

The handler reconciles ghosts synchronously with appended committed entries. If `reconcileUpstream` supersedes a ghost, the ghost disappears from `selectMergedEntries` in the same render where the real entry appears.

The `bootstrapping` quiet timer flips false after roughly 150 ms of no bursts. At that boundary it repairs replay-only stale flags: `awaitingAssistant` with an empty queue, and an open semantic current turn with no live process/phase signal.

## Initial And Older History

`loadInitialHistoryForSession` is the resume bootstrap path when a provider session id exists. It loads a tail chunk, maps it with the same Claude/Codex rules as live JSONL, seeds the `seenUuidsRef`, builds tool indices, derives work context, reconciles existing ghosts, and primes `lastJsonlEntryAt` from the loaded tail.

`session.ts` also bootstraps the ghost journal after spawn. It reads disk ghosts, merges only missing uuid slots into the current runtime, then reconciles those ghosts against `current.entries`. This second reconciliation is important because live/initial JSONL may have landed before ghost bootstrap completed.

`loadOlderHistory` prepends older entries when the feed asks for scrollback. It uses the same Codex rolling turn-id reconstruction, including payload-level `turn_id`, so paged entries carry the same ownership metadata as live/initial entries. It does not update `lastJsonlEntryAt`, because older history predates the current tail and should not move the JSONL freshness cursor.

## Ghosts And Merged Entries

Ghosts are not the normal live rendering path. `SemanticStreamingTurn` renders `runtime.semantic.currentTurn` directly. Ghosts are bookkeeping plus a fallback for JSONL-stalled cases.

Ghost lifecycle:

- Semantic current turn -> `ghostsFromSemanticTurn`.
- Existing block content changes -> `updateGhost`.
- Authoritative committed entry lands -> `reconcileUpstream` supersedes matching ghosts.
- Periodic 1 s sweep -> `orphanStale` marks stale unsuperseded ghosts after 30 s.
- Changed ghost snapshots are appended to disk.

`selectMergedEntries(runtime, currentTurnId)` renders a ghost only when all of these hold:

- It is not superseded.
- It is orphaned.
- It does not belong to the live current turn.
- Its `_atp.updatedAt` is newer than `lastJsonlEntryAt`, unless no JSONL has ever been observed.
- It is not sidecar-shaped: assistant, single text block, <= 200 chars.

If no ghost survives, `selectMergedEntries` returns `runtime.entries` by identity. That reference stability is part of the selector contract; many feed memos rely on it.

## Ownership Selector Invariants

A new ownership selector should consume these ownership layers in this order:

1. Committed entries are the durable baseline.
2. Semantic history may add completed turns that have not been fully committed yet.
3. Semantic current turn owns the one live turn.
4. Ghosts may add only stalled/orphan fallback rows after the five-rule predicate.

Do not flatten these layers by "latest source wins". The same visible action can appear in multiple layers during normal operation.

Specific invariants:

- Live current turn identity is `runtime.semantic.currentTurn?.turnId`; ghosts with that turn id must be hidden.
- Claude committed assistant entries suppress whole semantic history turns by `message.id`.
- Codex committed entries must not suppress a whole semantic history turn by `codexTurnId`; Codex commits one response item at a time. Suppression is per block/tool/text.
- Committed tool ownership is keyed by tool id in `toolUseIndex`. If a live semantic block's `toolUseId` or `callId` is committed, skip the live copy and any associated output block.
- Committed assistant text suppression needs both turn-scoped keys and exact committed text. Codex can expose proxy `resp_*` live ids while committed rollout rows are stamped with task/turn ids, so turn-id-only suppression misses duplicates.
- `lastJsonlEntryAt` is a freshness cursor, not a row id. Do not derive it from array order or `Date.now()`.
- Older-history pagination must not advance freshness or total-entry count.
- `entries` identity should survive when no ghost or history-visible row changes. Avoid selectors that allocate fresh arrays on every render.
- `semantic.history` is a bounded bridge, not durable transcript state. Once committed rows own a turn/block, semantic history should be suppressed rather than reordered into the transcript.
- `bootstrapping` means replay is still settling. Selectors should avoid treating every replay append as live output readiness.
- `dispatchMode.focusedSessionId` is not session ownership. For lifecycle ownership, use visible tab leaves, detached sessions, and buried panes only.

## Known Pitfalls

- Reintroducing a singular JSONL IPC handler will race the bulk handler and recreate bootstrap replay cascades.
- Dropping Codex payload-level `turn_id` handling breaks chunks that start after `turn_context`; ghost reconciliation and duplicate suppression then depend on scroll/replay boundaries.
- Treating Codex `codexTurnId` as a whole-turn committed owner hides still-live blocks because rollout commits item by item.
- Using `Date.now()` for JSONL freshness makes resume-after-crash comparisons wrong.
- Rendering ghosts for the current semantic turn double-renders with `SemanticStreamingTurn`.
- Removing the sidecar shape filter makes Claude sidecar leaks, like title generation or predict-next-prompt, appear at the feed tail.
- Always cloning ghost maps or merged entries busts feed memoization and turns harmless IPC ticks into full render work.
- Queue-operation replay can leave `awaitingAssistant=true`; the bootstrap quiet-window reconciliation is part of the runtime contract.
- Codex optimistic user rows cannot be reconciled by tail position; committed user prompts can arrive after tool-result user rows.
- Screen snapshots are debug/baseline state, not live transcript authority.

## Existing Test Scripts

Relevant scripts in `package.json`:

- `npm run test:ghost-fallback` checks the five-rule ghost render predicate, sidecar filtering, null `lastJsonlEntryAt`, and `orphanStale` reference-stable no-ops.
- `npm run test:semantic-committed-text` checks committed assistant text suppression across the Codex proxy id vs rollout turn-id split.
- `npm run test:session-ownership` checks visible/detached/buried session ownership and proves dispatch focus alone does not keep stale sessions alive.
- `npm run test:work-context` and `npm run test:worktree-activity` cover adjacent work-context ingestion.
- `npm run test:review-fixes` currently runs settings, prompt-template, and session-ownership tests only; it does not include the ghost or semantic committed-text tests.

Useful harnesses:

- `scripts/proxy-harness-semantic.mts`
- `scripts/proxy-harness-real.mts`
- `scripts/proxy-harness.mts`

