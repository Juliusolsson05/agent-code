# Submit / Queue / Debug Pipeline Notes

This note is scoped to the current Agent Code renderer as inspected in the `codex-render-first-principles` worktree. It answers one question for the rewrite: when a prompt is typed, submitted, queued, committed, or only visible through debug streams, which layer should own rendering it, and what evidence must the ownership selector emit when it chooses that owner?

## Current ingress paths

`TileLeaf` is the pane-level boundary. It owns the composer, passes committed and semantic state into `Feed`, renders `QueueStrip`, wires debug capture, and writes the draft through `workspace.setDraftInput`. The controlled composer value is `runtime.draftInput`; typing and paste mutate that draft, not feed rows.

`ComposerInput` handles ordinary textarea edits. Its `onChange` calls `setInputText(e.target.value)` unless slash mode is active. That means typed-but-not-submitted text currently exists only as composer draft state. It should not enter the feed renderer as a row, because it is still editable local intent.

`useTypeToFocus` and `usePasteToFocus` are alternate draft ingress routes. They exist for focus drift: printable keys or paste events aimed at the focused pane but not at the textarea are redirected into the same `runtime.draftInput` source of truth. Plain text paste-to-focus appends synchronously from the ClipboardEvent snapshot; image-ish paste routes through the same `useClaudeImagePaste` handler as textarea paste, then falls back to text append if no image was consumed. This is still draft ownership.

`useComposerKeybinds` is the submit boundary. On bare Enter, it records a paste-debug `keydown:enter`, captures a screen baseline, calls `workspace.setStreamingBaseline`, and then provider-routes the PTY write. Codex additionally calls `workspace.addOptimisticCodexUserEntry(sessionId, input)` before sending to the backend. Claude does not synthesize a user row here; it relies on Claude JSONL and queue-operation state.

`QueueStrip` renders `runtime.queuedMessages`, which comes from Claude `queue-operation` JSONL entries. These queued messages are intentionally outside `Feed`: they are future prompts that Claude has accepted into its internal queue but has not yet committed as transcript user entries. Rendering them inside the feed would either create phantom future rows or duplicate the real rows when Claude later logs them.

`Feed` currently receives three owner classes:

- Committed entries plus orphan fallback from `selectMergedEntries(runtime, runtime.semantic.currentTurn?.turnId ?? null)`.
- Archived and current semantic turns from `runtime.semantic.history` and `runtime.semantic.currentTurn`.
- Work indicator state from `runtime.streamPhase`.

`Feed` then computes one ordered transcript item list plus `visibleDecisions`, derives `renderedRows`, and emits RENDER feed-debug entries of kind `visible_rows`. `QueueStrip` is intentionally outside that transcript model; debug bundles should report it as pane-level pending input, not as a Feed row.

## How prompts should enter the new renderer

The new renderer should treat prompt ingress as a state machine with explicit ownership rather than a single append-only feed.

`typed` belongs to the composer owner only.

Typed text, textarea paste, type-to-focus paste, dictation text before commit, and history recall are drafts. They should enter the renderer as a composer/draft surface keyed by `sessionId`, not as conversation rows. The feed ownership selector should see the draft only as context, for example to explain why no feed row exists yet, but it should not select a feed owner for it.

`submitted` belongs to an optimistic local owner only when the durable provider has no immediate user-row guarantee.

Codex currently needs this. `addOptimisticCodexUserEntry` appends a synthetic Claude-shaped user entry with `uuid: optimistic-codex-user:<Date.now()>`, records a STATE `optimistic_user_add`, and later JSONL reconciliation removes that synthetic row when the real rollout user entry lands. The new renderer should preserve that behavior, but model it as an owner candidate named something like `optimistic-submit`, not as an indistinguishable committed entry.

Claude normal submit should not create an optimistic feed row by default. Claude's queued path already has a stronger provider-owned signal (`queue-operation`), and Claude transcript JSONL is the committed source once it lands. If a future Claude optimistic row is added, it must be separately identifiable and reconcile against committed Claude user entries by provider identity or exact text with a bounded time window.

`queued` belongs to a queue owner, not the transcript owner.

Claude queue-operation `enqueue` should produce queue-strip items. `dequeue` / `remove` should remove from that queue. The new renderer can include the queue strip in the renderer tree, but the ownership selector must not classify queued prompts as committed conversation rows. They are accepted future work, not transcript history.

`committed` belongs to JSONL / rollout transcript ownership.

Claude conversation entries and compact entries enter through the JSONL branch after filtering. Codex rollout entries enter through `mapCodexRolloutToFeedEntries`, are stamped with the current Codex turn id where available, deduped by uuid, and indexed for tool pairing. Once a committed user prompt matching an optimistic Codex row arrives, committed ownership supersedes optimistic ownership.

`live assistant output` belongs to semantic ownership.

The live current turn should render through `SemanticStreamingTurn`, not screen scraping and not ghosts. The current selector hides ghosts for semantic current/history turn ids, and the caller now passes `runtime.semantic.currentTurn` directly. The new renderer should keep that split: committed transcript rows own durable history, semantic owns current live output/history catch-up, and work indicator owns non-row activity.

`ghost` belongs only to orphan recovery.

`selectMergedEntries` allows ghost rows only when they are not superseded, orphaned, not already owned by semantic current/history, newer than the JSONL tail, and not sidecar-shaped. The rewrite should not use ghosts as the normal live path. Ghosts are a forensic fallback for proxy-past-JSONL stalls or crash recovery.

## Current debug evidence

The current stack already emits useful evidence, but it is spread across several channels.

Submit and paste debug:

- `useComposerKeybinds` records `keydown:enter` with composer length, head text, paste-like flag, draft-image flag, modifiers, backend readiness, and session id.
- It records provider route events such as `route:codex-bracketed-paste`, `route:claude-images`, `route:claude-paste-like`, and `route:claude-plain-text`.
- It records `submit:returned` or `submit:throw`.

State/feed debug:

- `setStreamingBaseline` records STATE `submit` with baseline presence and length.
- `addOptimisticCodexUserEntry` records STATE `optimistic_user_add` with text, before/after entry counts, and synthetic uuid.
- The JSONL ingest path records JSONL `jsonl_entries` with burst size, appended count, optimistic reconciliation status, before/base/after entry counts, appended summaries, queue length, work context, and conditions.
- `Feed` records RENDER `visible_rows` whenever rendered row identity/count changes, including rows, added, removed, hidden decisions, entry counts, semantic turn ids, and stream phase.

Trace/bundle evidence:

- `renderTrace` stores sanitized HTML commit snapshots when the HTML debug panel is open, and screen tail samples on screen updates/manual bundle capture.
- `saveDebugBundle` writes manifest, state snapshot, feed-debug JSONL, work context, semantic state, raw/clean pane HTML, optional proxy wire logs, trace files, and performance files.
- `FeedDebugPanel` displays the in-memory capped feed-debug log by layer and can copy visible entries.
- `useFeedDebugPersist` ships feed-debug entries to disk outside the in-memory cap.

Rendering harness evidence:

- The harness has its own FAT debug stream with JSONL, MAP, SEM, STATE, and RENDER layers.
- Its RENDER layer logs per-appended-entry dispatch decisions (`renderKindForEntry`, `describeRenderForEntry`), while Agent Code's main `Feed` logs visible row ownership/count transitions.
- The harness deliberately subscribes before spawn to catch bootstrap bursts, folds semantic events into the same semantic runtime, and captures submit baseline before writing to the backend.

## Evidence the ownership selector must emit

The new ownership selector should emit one structured decision record per candidate prompt/turn whenever its selected owner changes, whenever a candidate is suppressed, and on first observation. The record must be enough to prove why the renderer did or did not paint a prompt without replaying React in a debugger.

Required identity fields:

- `sessionId`
- `provider`
- `candidateId`
- `candidateKind`: `draft`, `submitted`, `queued`, `committed`, `semantic-current`, `semantic-history`, `ghost`, `work`
- `turnId`, `messageId`, `uuid`, `codexTurnId`, `toolUseId` when present
- `textHash`, `textHead`, `textLength`
- `source`: `composer`, `paste-to-focus`, `textarea-paste`, `dictation`, `queue-operation`, `claude-jsonl`, `codex-rollout`, `semantic`, `ghost`, `screen`

Required owner decision fields:

- `selectedOwner`: `composer`, `optimistic-submit`, `queue-strip`, `committed-feed`, `semantic-live`, `semantic-history`, `ghost-fallback`, `work-indicator`, `hidden`
- `previousOwner`
- `reason`: stable enum, not prose only
- `visible`: boolean
- `slot`: where it will render (`composer`, `queue-strip`, `feed-entry`, `semantic-tail`, `work-tail`, `none`)
- `supersededBy`: id of the committed/semantic owner that displaced it
- `blockedBy`: id or rule that prevented rendering

Required reconciliation evidence:

- For Codex optimistic rows: synthetic uuid, submit timestamp, committed matching uuid/message id, exact text match/hash, entry counts before/base/after, and whether the optimistic row was removed.
- For queued messages: queue operation, content hash/head, queue length before/after, rendered strip index, and whether `awaitingAssistant` was forced by non-empty queue.
- For committed entries: raw event type, mapper output count, dedup reason when dropped, entry uuid, feed key, visible decision reason, and row label.
- For semantic rows: current/history turn id, source, block count, text length/hash, committed text/tool ids used for suppression, and whether it rendered as live, archived, or null.
- For ghosts: orphaned/superseded/current-turn/timestamp/sidecar predicates individually, not just final visible/hidden.

Required timing evidence:

- Wall-clock `ts` and relative `tMs`.
- `submittedAt`, `phaseChangedAt`, `turnStartedAt` when available.
- JSONL entry timestamp and `lastJsonlEntryAt`.
- Queue operation timestamp.
- Semantic event timestamp or fold timestamp.

Required render evidence:

- Final ordered row list after ownership selection, not only diff counts.
- Added/removed rows by key.
- Hidden/suppressed candidates with rule names.
- DOM trace hash or HTML commit id when an HTML snapshot exists.
- Screen tail sample id/hash when screen-derived state influenced the decision.

## Practical shape for the rewrite

Add a selector-level debug event, separate from low-level STATE/JSONL logs:

```ts
type RenderOwnershipDebug = {
  layer: 'RENDER'
  kind: 'ownership_decision'
  sessionId: string
  provider: 'claude' | 'codex'
  candidate: {
    id: string
    kind: 'draft' | 'submitted' | 'queued' | 'committed' | 'semantic-current' | 'semantic-history' | 'ghost' | 'work'
    source: string
    turnId?: string | null
    uuid?: string | null
    textHash?: string
    textHead?: string
    textLength?: number
  }
  decision: {
    selectedOwner: 'composer' | 'optimistic-submit' | 'queue-strip' | 'committed-feed' | 'semantic-live' | 'semantic-history' | 'ghost-fallback' | 'work-indicator' | 'hidden'
    previousOwner?: string | null
    reason: string
    visible: boolean
    slot: 'composer' | 'queue-strip' | 'feed-entry' | 'semantic-tail' | 'work-tail' | 'none'
    supersededBy?: string | null
    blockedBy?: string | null
  }
  evidence: Record<string, unknown>
}
```

Keep the existing `visible_rows` event, but make it the aggregate output of ownership selection. The selector-level `ownership_decision` event explains individual ownership; `visible_rows` proves the final order React received. Debug bundles need both.

The important invariant for the rewrite: a user prompt must have exactly one visible owner at a time. Draft text is composer-only. Queued Claude text is queue-strip-only. Codex submitted text is optimistic-feed-only until committed rollout supersedes it. Committed transcript text is feed-only. Live assistant output is semantic-only. Ghost text is fallback-only after the normal owners fail their predicates.
