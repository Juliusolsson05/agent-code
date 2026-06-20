# Agent Code Rendering Knowledge Dump

Status: source-of-truth research dump, written 2026-05-22 after the Vitest test-stack reset.

This file is intentionally long. It is not a changelog and it is not a polished product spec. It is the place where future agents should start before touching feed rendering, semantic rendering, ghosts, provider screen/proxy behavior, prompt queueing, or the rewrite under `src/renderer/src/render-pipeline/`.

The goal is simple:

> A future agent should be able to read this file and understand the rendering bug class we have been fighting for weeks, the architecture that exists today, the incidents that shaped it, the traps hidden in comments, and the next rewrite direction.

The short version:

- The feed renderer has not been broken because React cannot render arrays.
- It has been broken because multiple data planes have been allowed to believe they own the same visible thing.
- The fix is not another local duplicate guard.
- Rendering must become a tested compiler from provider observations to owned render items.
- Unknown provider, proxy, screen, semantic, ghost, queue, and committed behavior must be logged as diagnostics rather than silently guessed into the feed.

## Reading Sources

This dump was assembled from:

- GitHub issues and issue comments, especially #90, #98, #99, #100, #115, #118, #138, #159, #168, #171, #172, #173, #174, #178, #179, #180, #181, #183, #185, #191, #193, #206, #211, #239, #241, #253, and #259.
- GitHub PR bodies and review context, especially #1, #2, #3, #7, #25, #35, #47, #54, #66, #134, #160, #165, #167, #170, #175, #176, #184, #186, #194, #197, #215, #252, #256, #262, and #263.
- Local rendering docs under `docs/codex-rewrite-render/`.
- Local design docs, especially `docs/design/ghost-system.md`.
- Local investigation plans under `docs/superpowers/plans/`.
- Current code comments in feed, semantic, ghost, provider, ingestion, debug, markdown, queue, and condition subsystems.
- Deleted script tests as of the pre-PR #263 tree, via git history and the salvage inventory.

Important: line numbers drift. File paths and function/type names are more durable than specific line references.

## The One Invariant

Every visible feed artifact must have exactly one owner at a time.

An "artifact" means any thing the user can see in the feed or adjacent feed surface:

- committed user row
- committed assistant row
- compact boundary
- compact summary
- live semantic text
- live semantic tool call
- live semantic tool output
- archived semantic history bridge
- ghost fallback row
- optimistic submitted Codex prompt
- queued follow-up prompt
- work indicator
- empty placeholder
- permission/trust/slash/model prompt overlay
- rendered markdown link/code/table/tool affordance

An "owner" is the subsystem whose evidence is allowed to paint that artifact:

- `committed`: durable JSONL or Codex rollout history
- `semantic-current`: current live provider/model turn
- `semantic-history`: completed live turn still bridging JSONL lag
- `ghost-fallback`: orphaned provisional record after normal owners failed
- `optimistic-submit`: local submitted prompt before Codex rollout catches up
- `queue`: provider/local queued prompt, not transcript history
- `work`: phase-only activity
- `screen`: terminal UI or overlay state, not assistant text authority
- `conditions`: parsed provider prompt/overlay UI
- `empty`: placeholder when no content owner exists

The bug class happens whenever two of these owners can render the same thing, or when one owner suppresses another before the replacement is actually visible.

## Why This Haunted Us

The repeated failure pattern:

1. A provider emits some live content through proxy/semantic/screen.
2. The renderer paints it to avoid waiting for JSONL.
3. Durable JSONL or rollout catches up later.
4. The old live copy is not suppressed, or is suppressed too broadly, or is suppressed at the wrong lifecycle boundary.
5. The same visible thing duplicates, disappears, gets buried under another plane, or sticks at the feed tail.
6. A focused patch fixes that exact case.
7. A neighboring plane regresses because the underlying ownership model is still distributed.

Examples:

- Claude title generation leaked into ghosts because auxiliary provider calls looked like real assistant turns.
- Codex bootstrap `<environment_context>` leaked as a user bubble because the mapper only filtered one-block bootstrap messages.
- Codex proxy `resp_*` live text and rollout committed text used different ids, so turn-id-only suppression missed duplicates.
- Codex committed tool items shared broad turn ids with still-live assistant text, so whole-turn suppression would hide valid live content.
- Semantic history stayed visible after committed rows owned it, causing stale rows at the bottom.
- Optimistic Codex prompts were present in the DOM but rendered above semantic/work rows, so they looked missing.
- Queued prompts stayed visible after idle because rollout ingestion did not clear them.
- Ghosts rendered sidecar/title/predict-next-prompt fragments because TTL alone cannot distinguish "JSONL stalled" from "provider never writes auxiliary flow to JSONL."

The important conclusion: there is no safe universal rule like "latest source wins", "committed always wins", "semantic always wins until idle", or "hide ghosts after N seconds." Each owner transfer needs source evidence.

## The Target Shape

Rendering becomes a compiler:

```text
raw provider input
  -> normalized observations
  -> known-pattern detectors
  -> unknown-behavior diagnostics
  -> ownership ledger
  -> FeedRenderItem[]
  -> dumb React rows
```

The proposed module boundary from the rewrite plan:

```text
src/renderer/src/render-pipeline/
  observations.ts
  normalizeClaude.ts
  normalizeCodex.ts
  detectors.ts
  ownershipLedger.ts
  deriveRenderItems.ts
  diagnostics.ts
  fixtures/
  __tests__/
```

The core idea:

- React should not decide ownership.
- Provider row components should not silently decide ownership.
- Ghost merging should not be the normal live path.
- Screen parsing should not become assistant text authority.
- Queue display should not be confused with transcript history.
- Debug rows must be derived from the same item list React paints.
- Unknown behavior must be logged, counted, and fixture-able.

## Current Top-Level Feed Model

The current source of truth for feed paint ownership is:

- `src/renderer/src/features/feed/model/renderModel.ts`
- `src/renderer/src/features/feed/ui/Feed.tsx`

The current `FeedRenderItem` union has these item types:

- `entry`
- `semantic-history`
- `semantic-current`
- `work`
- `empty`

`deriveFeedRenderModel` returns:

- `items`: one ordered `FeedRenderItem[]`
- `visibleDecisions`: per-entry committed visibility reasons
- `debugRows`: debug rows derived from the same `items`

This is the result of PR #256 and PR #262:

- PR #256 unified committed entries, semantic history/current, work, empty state, and queued prompts into one ordered model.
- PR #262 removed compatibility fields such as `visibleEntries`, `renderedSemanticHistory`, `renderedSemanticTurn`, `hasSemanticStreaming`, and `shouldShowWorkIndicator` from `FeedRenderModel`.

Current caveat:

- Queued prompts were later kept composer-adjacent rather than durable feed rows in docs after PR #263. Queue ownership still needs a first-class render-pipeline model.

## Current Feed Sort Rules

`deriveFeedRenderModel` first decides which owners survive, then sorts.

That order matters. The old renderer made correct per-plane decisions and then mounted fixed JSX buckets:

```text
entries
semantic history
semantic current
work
```

That fixed bucket order caused #239: a newer optimistic user prompt could be present in the committed/optimistic entry plane, but stale semantic history/work still mounted after it. The prompt existed, but visually it was not the latest user action.

Current sort:

- phase rank: `empty < content < work`
- content timestamp sort
- content source rank: `entry < semantic-history < semantic-current`
- sequence fallback

Null timestamps sort after timestamped content, not as "now." A missing timestamp is lossy evidence, not proof that the row happened last.

## Current Committed Projection

`deriveFeedCommittedProjection(entries)` computes:

- `visibleDecisions`
- `visibleEntries`
- `committedClaudeMessageTurnIds`
- `committedAssistantText`

Committed entry visibility:

- compact boundary: visible
- compact summary: visible
- non-conversation entry: hidden
- conversation entry with `isMeta === true`: hidden
- ordinary conversation entry: visible

The visible decision is not only for rendering. It is debugging evidence. It answers "was the committed row hidden because it was meta/system/non-conversation, or was it never ingested?"

## Current Debug Rows

Debug rows are derived from the same `FeedRenderItem[]` React paints.

This matters because before the semantic-first work, debug could claim a semantic row existed while `SemanticStreamingTurn` later returned `null`. That made the debug evidence lie about the rendered UI.

Current debug slots:

- `entry`
- `semantic`
- `work`
- `empty`

`Feed.tsx` emits RENDER `visible_rows` when row identity/count/order changes. The debug payload includes:

- final row list
- added rows
- removed rows
- hidden decisions
- entry counts
- semantic turn ids
- stream phase

This is useful, but the rewrite needs more: selector-level `ownership_decision` records for each candidate, including hidden/suppressed candidates.

## Work Is Not Text

`streamPhase` is lifecycle state, not proof that text exists.

The work indicator must render independently from semantic/entry rows because:

- submit can be in-flight before a turn id exists
- provider can be requesting before any assistant text exists
- a tool can be running while the semantic turn has no renderable content
- semantic content can be suppressed as duplicate while the agent is still busy
- a queued follow-up can exist while the current assistant/tool turn owns the feed

This is why `deriveFeedRenderModel` can produce:

```text
empty + work
```

No content owner exists yet, but the agent is still doing work.

## Semantic Runtime Model

Rendering-critical files:

- `src/renderer/src/workspace/semantic/foldEvent.ts`
- `src/renderer/src/workspace/semantic/helpers.ts`
- `src/renderer/src/workspace/workspaceState.ts`
- `src/renderer/src/features/feed/ui/semantic/renderUnits.ts`
- `src/renderer/src/features/feed/ui/semantic/StreamingTurn.tsx`
- `src/renderer/src/features/feed/ui/semantic/BlockRow.tsx`

Semantic runtime has:

- `currentTurn`: exactly one live semantic turn
- `history`: bounded bridge of completed semantic turns
- `flows`
- `errors`
- debug/lifecycle metadata

The key rule:

> All semantic events for a session must fold through the single semantic reducer. UI surfaces should select from `runtime.semantic`, not subscribe to proxy/screen/rollout streams independently.

## Why Semantic History Exists

Semantic history is not durable history.

It exists because the semantic/proxy/rollout live stream can complete before committed JSONL/rollout rows have caught up. If the app drops the completed live turn immediately, the feed flickers or loses output during the gap.

Semantic history keeps a renderable snapshot of a completed turn until committed rows own the same content.

Important details:

- It keeps full block maps, not only `turn.text`.
- It is bounded.
- It replaces prior snapshots with the same `turnId`.
- It is "latest renderable snapshot per turn", not an event log.
- Once committed rows own the content, semantic history should suppress rather than become transcript history.

## Semantic Provider Differences

Claude and Codex cannot share all folding rules.

Claude:

- Committed assistant JSONL rows usually carry `message.id` equal to the semantic `turnId`.
- Whole-turn history suppression is safe once that committed id exists.
- Claude can archive/replace mismatched current turns more liberally because pending-tool behavior can otherwise keep an ended turn pinned and hide subsequent turns.

Codex:

- Live proxy turns can use `resp_*`.
- Rollout committed rows can be stamped with task/turn ids.
- Response items can commit one at a time.
- A committed tool item may share a broad `codexTurnId` with later still-live assistant text.
- Whole-turn suppression by `codexTurnId` is unsafe.
- Codex must suppress at semantic unit/block level.
- Codex is strict about mismatched live turn ids to avoid proxy/rollout/screen producers replacing each other and causing flicker.

Codex replacement exceptions are deliberately narrow:

- ended pending-tool turn may yield
- terminal proxy turn missing `turn_completed` may yield
- empty non-proxy shell may yield to proxy

These are exceptions, not a general "new source wins" policy.

## Semantic Block Identity

Primary block identity:

- `blockIndex` inside a turn

Additional correlation:

- Claude `toolUseId`
- Codex `callId`
- Codex response item id
- provider-native ids where available

Blocks are stored as a map keyed by block index, plus order metadata. Deltas mutate by block index.

Tool results do not create a separate assistant block. They stamp result fields onto the originating tool block:

- `resultContent`
- `resultIsError`
- `resultAt`

Why: tool result pairing is a model-structure relation. Rendering tool outputs as standalone pseudo-blocks creates ordering and ownership ambiguity.

## Semantic Render Units

Feed does not render raw semantic blocks directly.

`buildSemanticRenderUnits` creates semantic render units:

- block rows
- collapsed activity rows
- filtered-out `null` rows

It handles:

- sorting blocks by `blockIndex`
- suppressing committed duplicate text
- suppressing committed duplicate tool blocks
- suppressing committed duplicate output blocks
- dropping empty write_stdin
- dropping empty reasoning/thinking
- collapsing low-signal activity groups

This matters because render-model ownership must match actual DOM output. If a semantic block renderer returns `null`, the selector must not claim semantic content exists.

## Committed Assistant Text Suppression

`buildCommittedAssistantText(entries)` builds three ownership sets:

- turn-text keys: `${turnId}\0${text}`
- exact text
- normalized text

Normalized text uses Unicode normalization and whitespace collapse.

Why all three:

- Claude can correlate by `message.id`.
- Codex proxy live ids can be `resp_*` while committed rollout rows carry task/turn ids.
- Some committed rows lack a usable message id.
- Text may differ by whitespace while visually identical.

The suppression is intentionally conservative:

- exact or normalized equality
- finalized/completed semantic text only
- no prefix matching
- no fuzzy matching

Fuzzy matching would hide legitimate live text that happens to repeat a sentence or share a prefix.

## Tool Suppression Rules

Committed tool ownership is not one rule.

Tool use suppression:

- If committed `ToolUseIndex` has a matching `toolUseId` or `callId`, the live semantic tool-use block yields.

Tool output suppression:

- Live output yields only when committed `ToolResultIndex` has the paired result.

Why separate:

- A command card/tool use can commit before stdout/stderr/tool output.
- If output yielded to tool-use ownership, live output would disappear before committed output arrived.

This exact gap was a prior regression and is now tested in the old script suite.

## Semantic UI Rules

`SemanticStreamingTurn`:

- Does not dump `turn.text` when blocks exist.
- Sorts blocks.
- Builds render units.
- Renders `SemanticCollapsedActivityRow` or `SemanticLiveBlockRow`.
- If no blocks exist and text is empty, returns `null`.
- If no blocks exist and text duplicates committed assistant text, returns `null`.
- Otherwise renders live assistant text through `StreamingProse`.

Special cases:

- `/compact` synthesis renders a placeholder instead of raw `<analysis>/<summary>` internals.
- Empty Codex live turns return `null`.
- Live Codex function calls are converted into committed `ToolUseBlock` shape and rendered by the same Codex row components used for committed rows.
- Live Write preview parses partial input and disables syntax highlighting for streaming performance.

## Committed Row Dispatch

Committed feed rows go through:

- `EntryRow`
- `ConversationRow`
- `Block`
- provider-specific row renderers

Dispatch:

- compact boundary -> compact boundary row
- compact summary -> compact summary row
- conversation string content -> text row
- conversation array content -> block rows
- unknown/non-conversation -> system row, usually hidden by projection

Important Anthropic gotcha:

> Never wrap a whole user-role multi-block message in `UserBand`.

Why:

- Anthropic tool results arrive in user-role messages.
- Tool result blocks are not user prompts.
- Only user text/image blocks get the user prompt band.

## Committed Tool Rows

Tool-use rendering:

- Codex `apply_patch` -> `CodexApplyPatchRow`
- Codex exec/write_stdin/custom tools -> Codex rows
- Claude Edit/MultiEdit/Write/TodoWrite -> rich rows
- Git custom rendering -> `GitCardRow`
- fallback -> generic `ToolUseRow`

Tool-result rendering:

- Edit/MultiEdit/Write/TodoWrite success stubs suppress
- Read output becomes summary plus lazy expandable `CodeBlock`
- Grep uses `CodeBlock`
- Git paired tool result suppresses when Git card already owns output
- fallback truncates like Claude Code style

Git custom rendering is single-surface: if the tool-use row renders command plus output, the paired tool-result row must suppress.

## Markdown Rendering

Files:

- `src/renderer/src/features/feed/ui/markdown/Prose.tsx`
- `src/renderer/src/features/feed/ui/markdown/MarkdownComponents.tsx`
- `src/renderer/src/features/feed/lib/remark-plugins.ts`
- `src/renderer/src/features/rendered-content/SafeMarkdownLink.tsx`
- `src/renderer/src/features/rendered-content/SafeInlineCode.tsx`
- `src/shared/renderedContent/targets.ts`

Two prose surfaces:

- `TextProse`: committed JSONL text, `remark-gfm`
- `StreamingProse`: live text, `remark-gfm + remark-breaks`

Why split:

- committed transcript text is real markdown
- streaming text may be ANSI-stripped terminal/screen-ish text where single newlines are visual layout

Plugin arrays are module-scoped because `react-markdown` caches by identity. Fresh arrays would bust parse caching.

Markdown component object is also module-scoped for the same reason.

## Code Blocks

Feed markdown code fences use static `CodeBlock`, not Monaco.

Why:

- Monaco inside prose produced zero-width black block failures in narrow flex cells.
- `automaticLayout` did not always recover.
- Monaco is heavy for common fenced snippets.

Monaco is reserved for larger explicit code surfaces such as Read/Grep result displays.

Streaming code with an open triple-backtick fence is special:

- closed fences go through markdown
- open fence is split and rendered as partial code so live code is visible while streaming

## Safe Rendered Content

Rendered markdown is model/provider-controlled input.

Rules:

- Native anchor navigation is never trusted.
- Link clicks call `preventDefault()` and `stopPropagation()`.
- External links are http/https only.
- External open goes through preload/main IPC.
- File links resolve against workspace root and open in Global Editor.
- Unsupported protocols become inert text.
- Inline code activation is stricter than links because agents wrap arbitrary tokens in backticks.

This is the lesson from #180 and #181:

- renderer classification is UX
- main IPC and Electron navigation guards are the trust boundary

## Feed Performance Rules

Markdown parse/highlight is expensive.

`Feed` uses two memo layers:

1. `Feed` itself is memoized so composer typing does not re-render the whole feed.
2. Row/prose components are memoized so appending one entry does not reparse all old markdown.

Lazy mounting:

- last `EAGER_TAIL = 30` committed entries mount immediately
- older entries mount through IntersectionObserver
- mounted entries never unmount
- during bootstrap, observer attachment is suspended

Scroll state:

- stored module-level per session
- not runtime state, because scroll changes on every scroll tick would defeat memoization
- restore happens in layout effect
- bootstrap avoids per-append auto-scroll and pins once after replay quiets

## Runtime Ingestion Model

Render-facing runtime state lives in `SessionRuntime`:

- `entries`
- `semantic`
- `ghosts`
- `queuedMessages`
- `streamPhase`
- `processActive`
- `inputReady`
- `awaitingAssistant`
- `lastJsonlEntryAt`
- `toolUseIndex`
- `toolResultIndex`
- `bootstrapping`
- `sessionStatus`

`sessionStatus` is derived, not authoritative.

Priority:

```text
exited > semantic currentTurn > processActive > awaitingAssistant > idle
```

Any mutation touching exited/process/semantic/awaiting must run through status derivation or the UI can keep saying running after the actual owner signal is gone.

## Submit Ingestion

On submit:

- set streaming baseline
- set `awaitingAssistant = true`
- set `streamPhase = 'submitting'`
- set timestamps
- clear rewind undo

This creates visible work before the provider emits semantic events.

Codex then:

- appends optimistic user entry, or
- queues placeholder in `queuedMessages`

The key function is `shouldQueueOptimisticCodexUserEntry`.

It intentionally ignores `streamPhase`.

Why:

- `setStreamingBaseline()` runs before `addOptimisticCodexUserEntry()` in the same submit handler.
- That means `streamPhase` is already `submitting`.
- Treating non-idle phase as "previous turn is live" queues the first prompt of an idle Codex session.

The real question is:

> Is there older semantic current/history content still visibly owning the feed tail?

If yes, queue. If no, append optimistic entry.

## Optimistic Codex Prompt Ownership

Codex needs optimistic user rows because rollout JSONL can lag or fail to attach.

Optimistic entry:

- type `user`
- uuid `optimistic-codex-user:<Date.now()>`
- content is trimmed prompt text

It is reconciled away when committed rollout user row arrives.

Matching uses normalized prompt text:

- Unicode NFKC
- whitespace collapse
- trim

Tail-position matching is unsafe because committed user prompts can arrive after tool-result user rows.

## Queue Ownership

`queuedMessages` is not transcript history.

It represents accepted or locally held future prompt text that should not be rendered as a committed conversation row yet.

Claude queue-operation JSONL updates queue state but does not enter `entries`.

Codex mid-turn optimistic submits can queue locally when semantic current/history still owns visible content.

Idle invariant:

> A Codex pane should not retain stale local queued messages when process, stream, and awaiting signals are all idle unless there is a real provider queue signal.

This was #241.

## JSONL Ingestion

Durable entries arrive through bulk `onSessionJsonlEntries`.

The singular JSONL handler was removed because it raced bootstrap and caused per-entry render cascades.

Bulk handler responsibilities:

1. Capture provider session identity.
2. Map provider entries to feed entries.
3. Process queue-operation records.
4. Deduplicate by UUID.
5. Append entries.
6. Update tool indices.
7. Update `lastJsonlEntryAt`.
8. Reconcile optimistic Codex prompt rows.
9. Reconcile queued Codex prompts.
10. Reconcile ghosts.
11. Update work context.
12. Update bootstrap quiet timer.

Codex mapping:

- `mapCodexRolloutToFeedEntries`
- `stampCodexTurnId`
- drops AGENTS.md and `<environment_context>` bootstrap messages
- maps tool calls/results to Claude-shaped blocks with Codex metadata
- reconstructs rolling `codexTurnId`

Claude mapping:

- conversation entries enter feed
- compact boundary/summary enter feed
- queue-operation records update queue only
- embedded progress entries are extracted before filtering

## Codex Turn Id Cursor

Codex `turn_context` is sparse.

Later `response_item` bursts can arrive without nearby `turn_context`, but still belong to the same task/turn.

The renderer keeps `codexCurrentTurnIdBySession` outside React runtime.

Why outside runtime:

- it is ingestion bookkeeping
- rendering should react to stamped feed entries, not parser cursor state

The cursor is cleared by terminal Codex events and session exit so a new task cannot inherit the previous task id.

Do not move this cursor into UI state. Do not make mapping positional.

## Bootstrap and Rehydrate

Rehydrate separates:

- renderer `SessionId`: routing identity
- provider session id: transcript/resume identity

Live tile leaves get fresh renderer ids. Provider session ids are preserved so history can resume.

Detached/buried sessions can be metadata-restored without respawning backend processes.

Initial history:

- loads JSONL tail
- maps Claude/Codex to feed entries
- seeds seen UUIDs
- rebuilds tool indices
- reconciles ghosts
- primes `lastJsonlEntryAt`

After bootstrap quiets, `bootstrap_complete` repairs replay-only false states:

- stale `awaitingAssistant`
- stale Codex queue rows
- open semantic turn with no live process/stream signal

## Ghost System

Files:

- `src/renderer/src/workspace/ghosts.ts`
- `src/renderer/src/workspace/mergedEntries.ts`
- `docs/design/ghost-system.md`
- `docs/superpowers/plans/2026-05-07-ghost-system-findings.md`
- `docs/superpowers/plans/2026-05-07-ghost-rendering-predicate.md`

Ghost is a parallel disk-backed provisional transcript ledger.

The renderer mints ghost `ClaudeEntry` records from semantic events before authoritative JSONL catches up.

Current correction:

> Ghosts are not the normal live render path.

The normal live path is `SemanticStreamingTurn` rendering `runtime.semantic.currentTurn`.

Ghost rendering exists only for:

- JSONL stalled behind proxy
- resume after crash with ghost log entries newer than JSONL tail

## Ghost Five-Rule Render Predicate

`selectMergedEntries` renders a ghost only if all five rules pass:

1. Not superseded.
2. Orphaned.
3. Not owned by semantic current/history.
4. Newer than `lastJsonlEntryAt` when JSONL tail is known.
5. Not sidecar-shaped.

If no ghost survives, return `runtime.entries` by reference.

This identity stability is load-bearing for feed memoization.

## Ghost Rule 1: Not Superseded

Superseded means authoritative JSONL/rollout landed.

Matching:

- Claude assistant `message.id` equals ghost `turnId`
- Codex mapped rollout `codexTurnId` equals ghost `turnId`
- tool-use id matches ghost context `toolUseId` or `callId`

Once superseded, semantic updates leave the ghost alone. Do not resurrect a provisional row after the authoritative row exists.

Superseded ghosts can later be garbage-collected. Rendering is already hidden before GC.

## Ghost Rule 2: Orphaned

`orphanStale` marks unsuperseded ghosts orphaned after TTL.

Current TTL: 30s.

History:

- 3s when orphan rendering was always-on
- 30s after layered predicate landed

Important:

> Orphaned does not mean render.

It only makes the ghost eligible. Rules 3, 4, and 5 still apply.

## Ghost Rule 3: Not Semantic-Owned

If semantic current or semantic history owns the turn id, ghost must not render.

Why:

- current live turn renders through `SemanticStreamingTurn`
- completed turn may still bridge through semantic history
- ghost rendering here would double-render the same provisional content

This rule was expanded from "not current turn" to "not current or semantic history."

## Ghost Rule 4: Newer Than JSONL Tail

`lastJsonlEntryAt` is the newest committed entry timestamp seen for the session.

Ghost can render only if:

```text
lastJsonlEntryAt == null OR ghost.updatedAt > lastJsonlEntryAt
```

This detects:

- proxy continued after JSONL stopped
- resume after crash where ghost log has later partial output than JSONL

This prevents:

- old sidecars from surfacing below newer real JSONL rows

Do not compute `lastJsonlEntryAt` with `Date.now()`. It must be based on entry timestamps so resume comparisons stay in the same wall-clock space.

## Ghost Rule 5: Not Sidecar-Shaped

Renderer backstop:

- assistant role
- exactly one text block
- text length <= 200

This filters title-gen, branch title, predict-next-prompt, and similar auxiliary fragments that escaped proxy-side filtering.

Known trade-off:

- A real crashed-before-JSONL assistant turn like "Done." may be hidden.
- This is accepted to avoid daily sidecar clutter.

Why needed even with timestamp rule:

- a tail sidecar after the last real JSONL entry also has `ghost.updatedAt > lastJsonlEntryAt`
- timestamp alone cannot distinguish real stuck partial output from provider auxiliary flow

## Ghost Minting Rules

Ghosts are minted from semantic current turns.

Selective conversion:

- text/message blocks with non-empty text -> text content
- thinking/reasoning with plaintext -> thinking block
- encrypted/empty Codex reasoning -> skipped
- tool call inputs -> `tool_use`
- raw JSON fallback -> `{ __rawJson }`
- tool outputs/results -> not ghosted
- Codex web/image/local shell variants -> skipped
- compaction synthesis -> skipped

Why not ghost tool outputs:

- Synthesizing provisional `tool_result` would fabricate output the provider/model never produced.

Why skip compaction synthesis:

- raw `<analysis>/<summary>` internals must not land in ghost journal and resurface after TTL.

## Ghost Do-Not-Break List

Do not render all orphan ghosts.

Do not drop rule 3 unless `SemanticStreamingTurn` is removed.

Do not drop rule 4.

Do not drop rule 5 until proxy-side sidecar detection covers predict-next-prompt full-history variants.

Do not call `mergeWithUpstream` when no ghost survives.

Do not make ghost reducers allocate on no-op.

Do not orphan disappeared blocks inside `ghostsFromSemanticTurn`; a block disappearing during active semantic rewrite is not evidence upstream will never write it.

Fresh sessions with `lastJsonlEntryAt === null` can pass rule 4, but still need orphan/current-turn/sidecar gates.

## Headless Channel Model

Both Claude and Codex expose three truth planes:

- `semantic`: live model meaning
- `screen`: terminal/chrome/overlay state
- `committed`: durable transcript or rollout

Feed should never collapse these into one stream.

The channel split:

- semantic may create live assistant rows
- screen may drive overlays, prompt conditions, activity diagnostics, and fallback status
- committed may create persistent feed history

Screen assistant text is not feed authority.

## Claude Headless Model

Claude truths:

- semantic: proxy/model meaning
- screen: terminal UI and overlays
- committed: JSONL transcript

With proxy:

- `ClaudeProxyAdapter` publishes to authoritative semantic channel.
- screen-derived assistant text is routed to `semanticShadow`, not renderer-facing semantic.

Without proxy:

- screen fallback can produce shadow/debug state.
- feed should expect degraded live text and not resurrect old screen extraction.

Committed:

- `CommittedChannel.publishEntry`
- raw entry
- turn_committed
- compact_boundary
- committed tool_result

Tool results belong in committed because Anthropic SSE does not carry them live.

## Claude Sidecar Filtering

Sidecars:

- title generation
- branch-name generation
- compaction summaries
- hook agents
- agent verification
- predict-next-prompt variants

Without filtering:

- auxiliary calls become semantic turns
- renderer mints ghosts
- JSONL never supersedes them
- orphan ghosts render phantom short fragments

Proxy attribution:

- any Anthropic `/v1/messages` request is candidate
- first SSE chunk wins active lock
- concurrent flows become secondary
- sidecar demotion happens at `message_start` when model/request shape is known
- demotion clears brief requesting phase and emits `flow_ignored`

Filtering is opt-in gated by session model and sidecar pattern.

Renderer sidecar ghost filter remains a backstop.

## Claude Permission and Prompt Conditions

Claude permission prompts are screen UI state, not transcript/semantic state.

Parser requires:

- "Do you want to proceed?"
- "Yes"
- "No, and tell Claude"

Approve writes Enter.

Deny writes `3` then Enter.

There is a Claude condition renderer and shared condition types, but current Claude runtime does not appear to emit central `conditions` snapshots the same way Codex does. Some Claude prompt surfaces still arrive as legacy events or runtime fields.

## Claude Paste and Submit Detection

Do not treat activity as "submit succeeded."

Activity/spinner detection has known false negatives.

Preferred signals:

- composer placeholder cleared
- JSONL committed user entry

Claude paste-like submit uses two writes:

1. bracketed paste
2. Enter after `[Pasted text #N]` appears

Threshold:

- 100 chars or any newline

Event-driven timeout:

- 500ms

Fallback delay:

- 125ms

Placeholder polling happens headless-side through synchronous `snapshotPlain()` because `screen` events can stall under synchronized output.

Issue #90 remains open because prompt submit detection can still fall behind under load.

## Claude Screen Parser Pitfalls

Screen is heuristic.

Pitfalls:

- `screen` events can stall under synchronized output.
- current-screen parsers must use viewport, not full scrollback.
- streaming extractors use `recent` because long replies can scroll the `⏺` marker out.
- tool labels also use `⏺`, so extractors must filter tool/spinner chrome before locating assistant marker.
- queued user prompts below assistant text must terminate extraction so prompt queue text does not render as assistant output.
- continuation lines are dedented after stripping marker to avoid markdown lists becoming falsely nested.
- trailing whitespace is stripped because Ink repadding changes frame-to-frame and breaks stale-baseline comparisons.

## Codex Headless Model

Codex truths:

- semantic: live model events from proxy and rollout
- screen: TUI/chrome/fallback state
- committed: rollout JSONL

Codex has two live semantic sources:

- proxy `/responses` SSE
- rollout event stream

Screen assistant fallback is shadow-only.

## Codex Committed Channel

Committed means already written to rollout JSONL.

`CommittedChannel` emits:

- raw `rollout_line`
- `session_meta`
- every `response_item`
- `turn_committed` for message response items

Message turn id preference:

1. `message.id`
2. fallback `committed-${role}-${timestamp}-${text prefix}`

Rollout feed UUIDs are deterministic and timestamp-based:

```text
<timestamp>:<payload.id|call_id|type|entry.type>
```

This allows replay/bootstrap dedupe.

## Codex Provider Session Identity

Provider session id comes only from:

```text
session_meta.payload.id
```

The extractor is intentionally narrow. Other rollout entries are ignored for resume identity.

## Codex Proxy Flow Selection

Proxy flows are keyed by proxy `requestId`, not path.

Why:

- overlapping retries to `/responses` must not merge bytes

Only one proxy flow may publish semantic events.

First chunk wins active flow. Concurrent flows become secondary and are ignored.

The active slot is released on `response.completed`, not only socket end.

Why:

- follow-up tool-output requests can begin before old socket closes.

Parser uses `StringDecoder` to preserve split UTF-8 characters. Chunk-level `Buffer.toString` would corrupt multibyte characters. CRLF is normalized before SSE frame splitting.

## Codex Screen Fallback

Screen content fallback is shadow-only.

`semanticShadow` exists so screen-extracted assistant text cannot race rollout/proxy on renderer-facing `semantic`.

Screen may still own overlays/activity on `screen`.

Screen can claim fallback ownership only when no proxy/rollout owner exists.

Screen baseline suppresses previous-turn leakage. The first extracted text after activity must differ from the assistant text already visible when fallback started.

Codex readiness for orchestration is screen-based because `start()` proves plumbing, not prompt readiness. `awaitReadyForPrompt` looks for composer marker and rejects trust/approval/working screens.

## Codex Tool Rendering

Live Codex tool calls reuse committed Codex row renderers.

Semantic function/custom blocks become `ToolUseBlock` and dispatch to:

- `CodexApplyPatchRow`
- `CodexExecCommandRow`
- `CodexWriteStdinRow`
- `CodexToolRow`

`apply_patch` can be freeform, not JSON.

Live rendering must handle:

- raw patch body
- JSON arguments
- `cmd`
- `patch`
- `input`

Streaming `apply_patch` input must flow through `tool_input_delta`; otherwise live patch rows stay empty while the wire already has the patch.

Successful patch apply results are intentionally invisible. Error results render.

Empty `write_stdin` renders nothing. Codex uses empty stdin as poll/continuation noise.

## Codex Resume and Fork Ownership

Fresh rollout ownership must be proven by prompt, not recency.

Same cwd is necessary but not sufficient.

The first real user message must match a prompt written through this headless instance.

Ambiguity fails closed.

Why:

- same-cwd parallel orchestration agents can otherwise cross-wire
- new empty Codex pane can print another agent's JSONL (#173)

Resume tailing can switch to a forked rollout, but only after evidence:

- candidate cwd matches
- copied lineage ids overlap
- bounded observation window

Open new fork tail before closing stale tail.

Why:

- overlap can duplicate copied history, but deterministic UUIDs dedupe it
- closing stale tail first risks losing entries

Known comment mismatch:

- some comments say empty lineage downgrades matching
- current code fails closed when lineage id set is empty
- code is safer than comment

## Codex Known Pitfalls

`agent_message_delta` can synthesize a rollout turn without calling `semantic.startTurn`; strict semantic channel can drop the delta if no active turn exists. Renderer reducer has soft-open logic, but it never sees the event if headless channel drops it first.

This must be fixed or documented as intentionally dropped.

Do not reintroduce singular JSONL IPC.

Do not treat broad `codexTurnId` as whole-turn committed owner.

Do not make fresh rollout claim by first new global rollout file.

Do not move turn-context cursor into UI state.

## Provider Conditions

Provider conditions are prompt/overlay rendering surfaces, not transcript rows.

Examples:

- permission prompts
- trust dialogs
- approval prompts
- slash pickers
- model selectors
- compaction confirmations
- resume prompts
- add-dir prompts

Current direction from #99:

- conditions should consume semantic events first
- screen parsing is fallback
- each provider condition should be isolated in provider outlet code

Why:

- semantic/proxy events are often earlier and more reliable than screen redraw
- screen oscillation causes flicker
- conditions are provider-specific and should not leak into shared feed code

Current shape:

- shared `ProviderConditionSnapshot`
- `ProviderConditionOutlet`
- Claude/Codex condition outlets
- Codex evaluator exists
- Claude condition centralization is incomplete

## Debug and Diagnostics

Debug is not optional for this subsystem.

Existing evidence channels:

- submit/paste debug
- STATE feed debug
- JSONL feed debug
- SEMANTIC summaries
- RENDER visible rows
- render trace HTML snapshots
- screen tail snapshots
- proxy wire logs
- saved debug bundles
- render-diagnostics.json

`saveDebugBundle` writes:

- manifest
- state snapshot
- feed-debug JSONL
- work context
- semantic state
- raw/clean pane HTML
- proxy wire logs when available
- trace files
- performance files
- render diagnostics

Why render diagnostics were added:

- HTML/feed-debug showed duplicates but not committed text/tool ownership sets
- the 2026-05-16 duplicate/stuck bundles were painful to reason through without ownership evidence

## Debug Evidence the Rewrite Must Emit

Keep existing `visible_rows`, but add selector-level ownership decisions.

Each decision should include:

- session id
- provider
- candidate id
- candidate kind
- source
- turn id
- uuid
- message id
- codex turn id
- tool use id
- call id
- text hash
- text head
- text length
- selected owner
- previous owner
- reason enum
- visible boolean
- slot
- superseded by
- blocked by
- timing evidence
- raw event type
- normalized type
- committed ownership evidence
- semantic suppression evidence
- ghost predicate results
- queue/optimistic reconciliation evidence

Unknowns are not necessarily failures, but they must be visible and counted.

Unknown behavior examples:

- proxy event type has no detector
- semantic block kind has no render policy
- screen condition is visible but not classified
- committed row cannot correlate with semantic/ghost/optimistic candidate
- two owners claim the same visible slot
- queued prompt remains after idle with no provider queue signal
- provider activity lacks item/tool/call ids
- text-hash fallback was used because ids were missing

## Issue Trail

The core rendering issue trail:

- #172: feed render ownership across committed transcript, semantic live/history, ghosts, optimistic input
- #183: comprehensive rendering regression tests
- #168: Codex resume feed broken, proxy turn dropped, duplicate semantic-history keys
- #159: feed clearing and missing user rows during MCP/tool-call turns
- #191: stale semantic web-search rows sticking at bottom
- #239: optimistic submitted user prompts buried behind semantic/work rows
- #241: QueueStrip processed follow-up prompt stuck after idle
- #173: Codex cross-render transcripts
- #174: prompt suggestions leak into feed as raw items
- #138: streaming Write tool calls render raw partial JSON
- #98: interactive question tool calls render raw JSON
- #90: Claude prompt submit inconsistent under load

The broad conclusion:

- #172 names the owner problem.
- #183 names the missing safety net.
- #168 proves local anti-flicker guards can block the real proxy turn.
- #159 shows runtime/provider tailing can clear/miss feed rows.
- #191 shows semantic tool rows can stick after rollout commit.
- #239/#241 show user prompts and queues are part of rendering ownership, not just assistant text.
- #173 shows provider transcript ownership must be proven before display.
- #98/#138/#174 show unknown tool/prompt surfaces must be classified, not dumped as raw JSON.
- #90 shows screen-driven submit detection is not enough.

## PR Trail

Important rendering PRs:

- #1: reshaped app tree and split Feed, but explicitly deferred rendering duplication bugs
- #2: fixed permission prompts and semantic duplicate suppression
- #3: fixed workspace bootstrap and Codex feed turn reconciliation
- #7: rendered orphan ghosts
- #25: filtered Haiku title sidecar leaks
- #35: dropped Codex AGENTS/env_context bootstrap from feed
- #47: filtered Claude title-gen/sidecar by request shape
- #54: suppressed orphan ghosts with title-gen/predict-next-prompt shape
- #66: rendered orphan ghosts only when JSONL stalls past proxy
- #134: live preview for streaming Write tool calls
- #160: corrected Codex rollout tail ownership during MCP turns
- #165: kept semantic history visible while JSONL catches up
- #167: restored Codex live streaming on resume and deduped semantic history
- #170: suppressed committed semantic assistant duplicates
- #175: established Codex rendering foundation
- #176: streamed Codex tool rendering
- #184: shipped semantic-first rendering stack
- #186: tightened semantic render ownership
- #194: suppressed committed semantic web search
- #197: proved fresh rollout ownership
- #215: fixed feed debug append backpressure
- #252: fixed Codex prompt queue rendering ownership
- #256: unified feed render item ordering
- #262: removed render model compatibility fields
- #263: established Vitest testing stack and deleted script tests

The PR trail shows direction:

- move from buckets to item list
- move from screen to semantic/proxy
- move from ghost as live fallback to ghost as orphan recovery
- move from one-off scripts to Vitest
- move from local guards to ownership model

But the full compiler pipeline is not yet built.

## Deleted Script Tests and What To Salvage

PR #263 deleted `scripts/test-*.ts`.

This was correct. They were incident probes, not a maintainable test suite.

But many assertions are gold and must be rewritten in Vitest.

## `test-feed-render-model.ts`

Target:

- `deriveFeedRenderModel`

High-value invariants:

- committed visibility hides meta/system noise but keeps conversation rows
- Claude committed `message.id` suppresses same semantic history turn
- hidden/non-assistant message ids do not suppress semantic history
- Codex current semantic turn disappears when all units are committed duplicates
- semantic history with earlier timestamp renders before newer optimistic prompt
- text-only rollout history suppresses when committed text owns same content
- committed assistant text without message id still suppresses duplicate rollout history
- Codex committed tool item does not suppress whole semantic turn by broad `codexTurnId`
- committed tool use suppresses live tool-use-only semantic turn
- committed tool use alone does not hide live tool output before result lands
- committed tool result suppresses duplicate live output block
- empty write_stdin does not count as renderable semantic content
- non-empty write_stdin renders
- semantic history drops current turn id to avoid double ownership
- current semantic output after user prompt stays below prompt
- late semantic history inserts above newer prompt
- committed web_search tool use plus answer suppresses archived proxy web-search turn
- work state renders independently before content exists

None of this is junk.

Rewrite as focused Vitest cases, not one monolithic 748-line test file.

## `test-ghost-fallback.ts`

Targets:

- `selectMergedEntries`
- `orphanStale`

Invariants:

- empty ghost map returns runtime entries by reference
- unorphaned ghost does not render
- superseded ghost does not render
- current-turn ghost does not render
- semantic-history ghost does not render
- orphan older than JSONL tail does not render
- sidecar-shaped newer orphan does not render
- substantive newer orphan renders
- tool-use ghost can render even when short
- null `lastJsonlEntryAt` allows orphan through if other gates pass
- `orphanStale` is reference-stable on no-op and allocates when threshold elapses

None is junk.

## `test-semantic-committed-text.ts`

Target:

- `buildSemanticRenderUnits`

Invariants:

- committed text suppresses finalized live text across Codex `resp_*` vs rollout id split
- same-turn id suppression still works
- non-identical live text still renders

Must preserve:

- turn-text key set
- exact text set
- normalized text set

## `test-semantic-fold-codex-replace.ts`

Target:

- `foldSemanticEvent`

Invariants:

- completed proxy message turn without `turn_completed` can be archived/replaced by new proxy block
- still-live streaming turn cannot be replaced by stray block
- completed function_call block without turn_completed can be archived on next proxy turn
- in-progress function_call blocks replacement
- first block_started initializes current turn
- provider gate prevents Claude from using Codex-specific fold path

## `test-codex-optimistic-submit.ts`

Targets:

- `shouldQueueOptimisticCodexUserEntry`
- `codexPromptsMatchForOwnership`
- `shouldClearIdleCodexQueuedMessages`

Key bug comment to preserve:

```text
setStreamingBaseline() changes streamPhase to 'submitting' before addOptimisticCodexUserEntry().
If non-idle streamPhase means previous turn is live, every first prompt queues.
Semantic turn/renderable semantic history is the ownership signal; streamPhase is not.
```

Invariants:

- first prompt in idle session with `submitting` phase does not queue
- live current semantic turn queues
- sealed current turn does not queue
- renderable semantic history queues
- committed-owned history does not queue
- prompt matching normalizes unicode/whitespace
- idle Codex queue clears only when no process, no stream, no awaiting

## Other Old Tests To Rewrite

Rendering-adjacent salvage:

- `test-codex-semantic-channel.ts`: headless semantic lifecycle behavior
- `test-claude-proxy-api-error-release.ts`: active flow release after API errors
- `test-session-ownership.ts`: dispatch/grid/buried/detached ownership
- `test-rendered-content-targets.ts`: safe link/path classification
- `test-debug-bundle-storage.ts`: debug bundle route invariants
- `test-provider-switch-duplicate.ts`: provider transcript identity
- `test-codex-ready-for-prompt.ts`: Codex screen readiness

Defer/drop:

- broad orchestration scripts until split by concern
- simple CRUD prompt-template coverage unless actively changing
- dictation import smoke at root

## Unknown Behavior Contract

The rewrite should not silently classify unknowns as visible rows.

Every unknown behavior should produce diagnostic evidence.

Required diagnostic dimensions:

- provider
- surface
- raw type
- normalized type
- session id
- provider session id
- turn id
- item id
- tool id
- call id
- owner candidates
- reason unclassified
- sample hash/head
- first seen
- last seen
- seen count
- rendered/suppressed/ignored

The output should make these questions answerable from a saved bundle:

- Did this prompt exist as draft, queued, optimistic, committed, semantic, ghost, or work?
- Why did it move from one owner to another?
- What suppressed it?
- What owner replaced it?
- What ids proved ownership?
- Did React receive a row for it?
- Did DOM contain it?
- Was it buried by ordering?
- Did JSONL tail stall?
- Did proxy emit an unknown event?
- Did screen show a condition we did not classify?

## Recommended Rewrite Phases

The next rendering PR should not start with production rewrites.

Phase 0: evidence freeze

- Rewrite old high-value script tests as Vitest.
- Add fixtures for debug-bundle shapes.
- Preserve current behavior.
- No behavior changes unless tests expose broken expected behavior.

Phase 1: diagnostics shell

- Add render ownership decision event type.
- Keep current `FeedRenderItem[]`.
- Log owner candidates and decisions.
- Log unknowns.
- Add tests for diagnostics.

Phase 2: committed projection

- Move committed visibility and ownership sets into render-pipeline module.
- Keep `deriveFeedCommittedProjection` behavior equivalent.
- Test meta/system/compact visibility.

Phase 3: semantic ledger

- Convert semantic current/history into explicit candidates.
- Apply committed text/tool ownership before items.
- Test Claude whole-turn vs Codex block-level suppression.

Phase 4: ghost as fallback

- Move five-rule predicate into ownership ledger with reasons.
- Preserve reference stability.
- Log every predicate reason.

Phase 5: optimistic and queue ownership

- Model draft/submitted/queued/committed as different prompt owners.
- Codex optimistic user row and queue logic becomes ledger decisions.
- Add idle queue invariant tests.

Phase 6: provider-native blocks

- Normalize Claude and Codex tool rows into provider block observations.
- Keep provider-specific row renderers, but ownership decisions happen earlier.
- Add unknown tool behavior diagnostics.

Phase 7: React simplification

- Feed renders typed items only.
- Provider row components render, not decide ownership.
- Delete redundant suppression guards only after tests prove ledger owns them.

## Non-Negotiable Rules

Do not render from screen assistant text in Feed.

Do not let ghosts become the normal live path.

Do not suppress Codex semantic turns by broad turn id.

Do not collapse queue state into committed transcript rows.

Do not use `streamPhase` as prompt ownership signal.

Do not use `Date.now()` for JSONL freshness.

Do not reintroduce singular JSONL entry IPC.

Do not let debug rows be derived from a different model than React paint.

Do not add script tests again.

Do not hide unknown provider behavior without diagnostics.

Do not assume same-cwd Codex rollout is owned by the current pane.

Do not assume a committed tool use means live output has committed.

Do not make screen conditions shared-feed concerns.

Do not make provider row components responsible for cross-plane ownership.

## Open Problems

#90 remains open:

- Claude submit detection can still fall behind under load.
- Long paste and screen-parser lag remain risky.
- JSONL should be a stronger submit completion signal than screen activity.

#98 remains open:

- interactive question tool calls render as raw JSON.
- Need structured paused-awaiting-user ownership and provider response path.

#99 remains open:

- provider conditions should consume semantic events first and screen fallback second.

#174 remains open:

- prompt suggestions can leak raw items into feed.

#178/#179 remain open:

- sub-agent rendering and background process/terminal rendering need provider-neutral policies.

#183 remains open:

- comprehensive rendering regression tests still need to be migrated/expanded in Vitest.

#193 remains open:

- Codex resume fork detection still has edge cases around same-cwd rollout with prompt lineage but no shared item ids.

#241 is addressed by PR #252 but remains open:

- stale queue invariant should be ported to Vitest and verified in the new stack.

## Current Practical Next Step

Create a new worktree/branch for rendering TDD.

First PR:

- add Vitest tests for the old rendering script invariants
- no large production rewrite
- only expose pure helpers if needed
- commit fixtures/builders under `testing/support` or colocated test helpers

Second PR:

- add ownership diagnostics shell
- keep current render model behavior
- prove debug output explains ownership

Third PR:

- start extracting `render-pipeline` modules behind existing `deriveFeedRenderModel`

This sequence matters. The previous attempts fixed behavior first and wrote temporary scripts. The new stack lets us do the rewrite the other way around.

## Appendix: Rendering Blast Radius

This section is a line-count map, not an ownership map.

It answers the practical question: how much code is close enough to rendering that a ground-zero rewrite can break it?

The answer is: more than `Feed.tsx`, and much less than the whole app.

The tight renderer/provider surface measured on 2026-05-22:

- `src/renderer/src/features/feed`
- `src/renderer/src/workspace/semantic`
- `src/renderer/src/workspace/ghosts.ts`
- `src/renderer/src/workspace/hook/ipc/useIpcSubscriptions.ts`
- `src/renderer/src/workspace/hook/actions/streaming.ts`
- `packages/claude-code-headless/src`
- `packages/codex-headless/src`

`cloc` over that surface reported:

- 89 files.
- 27,682 total physical lines.
- 16,741 code lines.
- 9,090 comment lines.
- 1,851 blank lines.

That number is intentionally broad.

It includes headless provider code because rendering failures are often born before React sees data.

It includes semantic folding because that is the current live-turn ownership boundary.

It includes ghost code because ghosts are a rendering recovery mechanism, even though they are persisted outside `features/feed`.

It includes submit/streaming actions because optimistic prompt placement and queue ownership are visible rendering behavior.

It excludes unrelated workspace layout, tabs, dispatch, editor, MCP orchestration, and persistence except where those modules directly mutate feed-owned runtime fields.

The file-level count for the most direct surface:

- `src/renderer/src/features/feed/ui/Feed.tsx`: 946 lines.
- `src/renderer/src/features/feed/model/renderModel.ts`: 430 lines.
- `src/renderer/src/features/feed/ui/semantic/BlockRow.tsx`: 495 lines.
- `src/renderer/src/features/feed/ui/semantic/renderUnits.ts`: 359 lines.
- `src/renderer/src/features/feed/ui/semantic/StreamingTurn.tsx`: 149 lines.
- `src/renderer/src/features/feed/ui/rows/Block.tsx`: 204 lines.
- `src/renderer/src/features/feed/ui/rows/ToolResultRow.tsx`: 178 lines.
- `src/renderer/src/features/feed/ui/rows/ToolUseRow.tsx`: 85 lines.
- `src/renderer/src/features/feed/ui/rows/ConversationRow.tsx`: 69 lines.
- `src/renderer/src/features/feed/ui/markdown/MarkdownComponents.tsx`: 124 lines.
- `src/renderer/src/features/feed/ui/markdown/Prose.tsx`: 63 lines.
- `src/renderer/src/features/feed/lib/helpers.ts`: 386 lines.
- `src/renderer/src/features/feed/lib/streamingWriteInput.ts`: 206 lines.
- `src/renderer/src/features/feed/WorkIndicator.tsx`: 200 lines.
- `src/renderer/src/features/feed/workIndicatorHints.ts`: 105 lines.
- `src/renderer/src/features/feed/AppearanceMenu.tsx`: 218 lines.
- `src/renderer/src/workspace/semantic/foldEvent.ts`: 987 lines.
- `src/renderer/src/workspace/semantic/helpers.ts`: 345 lines.
- `src/renderer/src/workspace/semantic/summarize.ts`: 86 lines.

Provider-side direct surface:

- `packages/claude-code-headless/src/ClaudeCodeHeadless.ts`: 1,382 lines.
- `packages/claude-code-headless/src/proxy/ClaudeProxyAdapter.ts`: 2,022 lines.
- `packages/claude-code-headless/src/proxy/proxyServer.ts`: 609 lines.
- `packages/claude-code-headless/src/proxy/anthropicEvents.ts`: 386 lines.
- `packages/claude-code-headless/src/channels/SemanticChannel.ts`: 825 lines.
- `packages/claude-code-headless/src/channels/CommittedChannel.ts`: 207 lines.
- `packages/claude-code-headless/src/channels/ScreenChannel.ts`: 126 lines.
- `packages/claude-code-headless/src/channels/types.ts`: 870 lines.
- `packages/claude-code-headless/src/parsers/ScreenParser.ts`: 413 lines.
- `packages/claude-code-headless/src/transcript/JsonlTailer.ts`: 340 lines.
- `packages/codex-headless/src/CodexHeadless.ts`: 1,901 lines.
- `packages/codex-headless/src/proxy/CodexResponsesAdapter.ts`: 1,530 lines.
- `packages/codex-headless/src/proxy/responsesProxy.ts`: 845 lines.
- `packages/codex-headless/src/channels/SemanticChannel.ts`: 740 lines.
- `packages/codex-headless/src/channels/CommittedChannel.ts`: 132 lines.
- `packages/codex-headless/src/channels/ScreenChannel.ts`: 84 lines.
- `packages/codex-headless/src/channels/types.ts`: 747 lines.
- `packages/codex-headless/src/parsers/ScreenParser.ts`: 365 lines.
- `packages/codex-headless/src/transcript/FreshRolloutClaim.ts`: 216 lines.
- `packages/codex-headless/src/transcript/JsonlTailer.ts`: 323 lines.
- `packages/codex-headless/src/conditions/evaluateCodexConditions.ts`: 42 lines.

This LOC map hides one important truth.

The rewrite should not touch all 27k lines at once.

The first testable boundary is smaller:

- render ownership selector.
- semantic render-unit selection.
- ghost visibility predicate.
- committed-text/tool suppression.
- optimistic/queue prompt placement.
- debug ownership ledger.

The second boundary is provider normalization:

- Claude proxy semantic events.
- Claude committed JSONL events.
- Claude sidecar filtering.
- Claude screen-only prompt/permission conditions.
- Codex rollout semantic events.
- Codex proxy semantic events.
- Codex committed rollout entries.
- Codex screen-only conditions.
- Codex resume/fork ownership.

The third boundary is visual rows:

- committed conversation rows.
- live semantic rows.
- live and committed tool rows.
- markdown and safe link rendering.
- work indicator.
- empty placeholder.
- queue strip or future queued-prompt render item.

The rewrite should track these as separate test projects or test folders.

The mistake in earlier iterations was treating them as one opaque rendering bug.

## Appendix: Full File Reading Map

Read these in order if you are a future agent.

Do not start in React.

Start with the ownership docs.

- `docs/codex-rewrite-render/README.md`
- `docs/codex-rewrite-render/first-principles-render-model.md`
- `docs/codex-rewrite-render/feed-render-item-plan.md`
- `docs/codex-rewrite-render/headless-channel-model.md`
- `docs/codex-rewrite-render/renderer-runtime-ingestion.md`
- `docs/codex-rewrite-render/feed-ui-rendering.md`
- `docs/codex-rewrite-render/submit-queue-debug.md`
- `docs/codex-rewrite-render/upstream-codex-rendering.md`

Then read the renderer model.

- `src/renderer/src/features/feed/model/renderModel.ts`
- `src/renderer/src/features/feed/ui/Feed.tsx`
- `src/renderer/src/features/feed/ui/semantic/renderUnits.ts`
- `src/renderer/src/features/feed/ui/semantic/StreamingTurn.tsx`
- `src/renderer/src/features/feed/ui/semantic/BlockRow.tsx`
- `src/renderer/src/features/feed/ui/rows/Block.tsx`
- `src/renderer/src/features/feed/ui/rows/ToolUseRow.tsx`
- `src/renderer/src/features/feed/ui/rows/ToolResultRow.tsx`
- `src/renderer/src/features/feed/ui/rows/ConversationRow.tsx`

Then read the semantic reducer.

- `src/renderer/src/workspace/semantic/foldEvent.ts`
- `src/renderer/src/workspace/semantic/helpers.ts`
- `src/renderer/src/workspace/semantic/summarize.ts`

Then read runtime ingestion.

- `src/renderer/src/workspace/hook/ipc/useIpcSubscriptions.ts`
- `src/renderer/src/workspace/hook/actions/streaming.ts`
- `src/renderer/src/workspace/hook/actions/history.ts`
- `src/renderer/src/workspace/hook/actions/initialHistory.ts`
- `src/renderer/src/workspace/hook/actions/session.ts`
- `src/renderer/src/workspace/hook/persistence/rehydrate.ts`
- `src/renderer/src/workspace/workspaceState.ts`
- `src/renderer/src/workspace/mergedEntries.ts`
- `src/renderer/src/workspace/ghosts.ts`
- `src/renderer/src/workspace/queueInvariants.ts`

Then read provider headless.

- `packages/claude-code-headless/src/ClaudeCodeHeadless.ts`
- `packages/claude-code-headless/src/proxy/ClaudeProxyAdapter.ts`
- `packages/claude-code-headless/src/channels/SemanticChannel.ts`
- `packages/claude-code-headless/src/channels/CommittedChannel.ts`
- `packages/claude-code-headless/src/channels/ScreenChannel.ts`
- `packages/claude-code-headless/src/channels/types.ts`
- `packages/claude-code-headless/src/parsers/ScreenParser.ts`
- `packages/claude-code-headless/src/parsers/PermissionPromptParser.ts`
- `packages/claude-code-headless/src/parsers/TrustDialogParser.ts`
- `packages/claude-code-headless/src/parsers/ResumePromptParser.ts`
- `packages/claude-code-headless/src/parsers/SlashPickerParser.ts`
- `packages/claude-code-headless/src/transcript/JsonlTailer.ts`
- `packages/codex-headless/src/CodexHeadless.ts`
- `packages/codex-headless/src/proxy/CodexResponsesAdapter.ts`
- `packages/codex-headless/src/proxy/responsesProxy.ts`
- `packages/codex-headless/src/channels/SemanticChannel.ts`
- `packages/codex-headless/src/channels/CommittedChannel.ts`
- `packages/codex-headless/src/channels/ScreenChannel.ts`
- `packages/codex-headless/src/channels/types.ts`
- `packages/codex-headless/src/parsers/ScreenParser.ts`
- `packages/codex-headless/src/parsers/ApprovalParser.ts`
- `packages/codex-headless/src/parsers/TrustDialogParser.ts`
- `packages/codex-headless/src/transcript/FreshRolloutClaim.ts`
- `packages/codex-headless/src/transcript/JsonlTailer.ts`
- `packages/codex-headless/src/conditions/evaluateCodexConditions.ts`

Then read debug instrumentation.

- `src/renderer/src/workspace/runtime/feedDebug.ts`
- `src/main/storage/feedDebugLog.ts`
- `src/renderer/src/features/debug/renderTrace.ts`
- `src/main/ipc/debugBundle.ts` if present in the current tree.
- `src/main/storage/debugBundles.ts` if present in the current tree.
- `src/renderer/src/features/debug/*` for panels that consume the evidence.

Then read submit/composer ownership.

- `src/renderer/src/workspace/tile-tree/TileLeaf.tsx`
- `src/renderer/src/workspace/tile-tree/TileLeaf/QueueStrip.tsx`
- `src/renderer/src/workspace/tile-tree/TileLeaf/ComposerInput.tsx`
- `src/renderer/src/workspace/tile-tree/TileLeaf/useComposerKeybinds.ts`
- `src/renderer/src/workspace/tile-tree/TileLeaf/claudePaste.ts`

Then read safe rendering.

- `src/renderer/src/features/feed/ui/markdown/MarkdownComponents.tsx`
- `src/renderer/src/features/feed/ui/markdown/Prose.tsx`
- `src/renderer/src/features/feed/lib/remark-plugins.ts`
- `src/renderer/src/features/feed/lib/helpers.ts`
- `src/renderer/src/features/feed/lib/streamingWriteInput.ts`

Then read upstream Codex, but only for model comparison.

- `vendor/codex-src/codex-rs/tui/src/history_cell.rs`
- `vendor/codex-src/codex-rs/tui/src/chatwidget.rs`
- `vendor/codex-src/codex-rs/tui/src/markdown_render.rs`
- `vendor/codex-src/codex-rs/core/src/protocol.rs`
- `vendor/codex-src/codex-rs/core/src/codex.rs`

The important upstream lesson is not that we should copy Rust UI code.

The important lesson is that upstream separates provider deltas, semantic/core events, durable history cells, and screen UI.

Agent Code kept rediscovering that split through bugs.

## Appendix: Issue Trail, Detailed

This is the issue history that explains why the rewrite should be tests-first.

The titles alone tell the story.

The bodies and comments matter because they show the same bug returning under new names.

### Issue #90: Claude prompt submit still inconsistent - detection logic falls behind under load

Status: open.

Provider: Claude.

Area: submit detection, screen parser, paste flow, prompt ownership.

The user-visible symptom is that a submitted Claude prompt is not reliably acknowledged.

The dangerous false assumption is that terminal activity equals submit success.

Under load, screen frames can lag.

Under long paste, bracketed-paste mechanics can make the UI look active while the prompt has not been accepted yet.

The code already contains special handling for long pasted prompts.

The code already avoids using activity alone as confirmation.

The remaining rewrite lesson is that submit detection should be an owned state machine.

It should have evidence types:

- composer accepted locally.
- PTY write started.
- PTY write finished.
- placeholder observed.
- semantic turn observed.
- committed JSONL observed.
- screen activity observed.
- timeout elapsed.

Only some evidence proves submit.

Screen activity is weak evidence.

JSONL user entry is strong evidence.

Semantic assistant turn is strong evidence that the prompt was accepted.

The rendering rewrite should not use Claude screen parser output to create assistant text.

The rendering rewrite may use Claude screen parser output to update submit diagnostics.

TDD requirement:

- simulate slow screen frames.
- simulate bracketed paste event timeout.
- simulate placeholder appearing before semantic event.
- simulate JSONL arriving before screen catches up.
- assert the prompt is visible in exactly one owner.

### Issue #98: Claude/Codex interactive question tool calls render as raw JSON

Status: open.

Provider: both.

Area: tool rendering, conditions, paused awaiting user.

The symptom is that a provider asks an interactive question through a tool call and the feed shows raw JSON.

This is not merely ugly rendering.

It is a missing ownership model for "the agent is paused and expects a user answer".

Today structured provider conditions handle some modal/overlay-like states.

Tool calls with `{ question, options }` do not become a first-class response surface.

The current committed tool renderer detects some interactive question shapes and may render no body.

That avoids raw JSON in some paths but does not solve the workflow.

The feed needs a typed paused state.

Possible owner:

- `condition` for provider-level blocking prompt.
- `semantic-tool-question` for live tool question.
- `committed-tool-question` for durable replay.

The rewrite should not treat this as a markdown row.

The rewrite should log unknown tool-call shapes before falling back to raw JSON.

TDD requirement:

- Claude live question tool.
- Codex live question function call.
- committed replay of a question tool.
- unknown JSON tool call.
- answer submission path.
- cancelled turn path.

### Issue #99: Extend conditions system to consume semantic events alongside screen parsing

Status: open.

Provider: both, currently mostly Codex.

Area: provider conditions, screen versus semantic evidence.

The current condition model is mostly screen-derived.

That works for Codex approval/trust overlays because those appear in TUI screen frames.

It does not cover all semantic provider states.

The condition architecture already points toward a typed provider condition outlet.

The missing work is to feed it from semantic events where possible.

Screen parsing should be fallback evidence.

Semantic event evidence should win when it exists.

Do not let conditions become feed rows.

Conditions are blocking UI state.

They can coexist with feed rows.

They must not mutate semantic text ownership.

TDD requirement:

- condition appears from semantic event with no screen match.
- condition appears from screen match with no semantic event.
- semantic event clears stale screen condition.
- condition response does not create duplicate feed input row.

### Issue #100: Improve evergreen design docs

Status: open.

Area: documentation debt.

This issue is directly related to this file.

The rendering system was changed repeatedly by agents without a single canonical explanation.

The docs that existed were useful but scattered:

- ghost design.
- render rewrite notes.
- plan docs.
- debug bundle notes.
- issue comments.
- PR bodies.

The rewrite should require docs that live beside the subsystem.

Docs must explain invariants.

Docs must explain why naive alternatives failed.

Docs must include test pointers.

Docs must include debug evidence.

The AGENTS instruction says comments must carry thick WHY context.

This doc should not replace comments.

This doc should explain the system-level map; comments should explain local decisions.

### Issue #115: Sanitize logs before writing debug/proxy output

Status: open.

Area: debug evidence.

Rendering is currently debugged with saved bundles, proxy logs, feed-debug streams, render traces, and screen tails.

Those artifacts can contain user prompts, provider output, file paths, credentials, and tool output.

The rewrite needs more diagnostics, not fewer.

Therefore sanitization is not optional.

The unknown-behavior logger must have a redaction layer.

The debug bundle assembler must never leak raw secrets by default.

The rendering pipeline should log structural metadata first:

- owner ids.
- provider.
- event type.
- block type.
- lengths.
- hashes.
- normalized text hashes.
- timestamp ordering.
- suppression decisions.
- first few safe characters only if explicitly allowed.

TDD requirement:

- unknown behavior with secret-like text.
- proxy event with authorization header.
- rendered markdown link with local path.
- tool output with env-looking values.
- ensure default bundle has redacted preview.

### Issue #118: Codex pane can report started while no backend output/lifecycle events arrive

Status: open.

Provider: Codex.

Area: lifecycle, process status, empty feed/work indicator.

The symptom is a pane that looks started but has no meaningful backend output.

Rendering implication:

- `work` can exist without assistant text.
- `empty` can exist while process lifecycle is ambiguous.
- screen readiness is not the same as semantic readiness.

The render pipeline should not fake assistant content to make the pane look alive.

It should render an empty/work state and log missing producer evidence.

Unknown behavior log example:

- `provider_started_without_semantic_or_committed_event`.
- includes session id, process id if available, provider session id, tail path, screen frame age, proxy flow state.

TDD requirement:

- process active but no semantic.
- process active but no committed.
- screen active only.
- proxy active only.
- rollout tail missing.

### Issue #138: Streaming Write tool calls render as raw partial JSON in the live feed

Status: closed.

Provider: Claude primarily, but concept applies to Codex.

Area: live tool rendering.

The bug was that partial Write tool JSON appeared directly in the feed.

The fix introduced a scanner that can identify a file path and partial content before the full JSON object is closed.

That scanner is intentionally lenient.

The feed should show a rich Write preview during streaming.

The feed should not show raw partial JSON unless the shape is unknown and logged.

The scanner returns `filePath` only when the path is closed.

It can return partial content earlier.

It scans by key names.

It tolerates incomplete JSON and escape sequences.

TDD requirement:

- streaming Write with path before content.
- streaming Write with content before path.
- streaming Write with escaped quotes.
- streaming Write with incomplete Unicode escape.
- unknown partial JSON logs unknown behavior instead of raw flood.

### Issue #151: Prompt/conversation search missing known agent content

Status: open.

Area: committed transcript indexing.

Search bugs are rendering-adjacent because the same transcript ownership questions apply.

If rendered feed content is not durably represented, search misses it.

If semantic-only content is indexed as durable, search lies.

If ghost content is indexed as committed, search lies.

The rewrite should define which plane is searchable:

- committed entries: yes.
- committed tool output: yes, with truncation/index policy.
- semantic current: maybe live search only, not durable search.
- semantic history: no durable search until committed.
- ghosts: no durable search unless later promoted or explicitly marked recovery.
- queue strip: no durable search.

### Issue #159: Fix feed clearing and missing user rows during MCP/tool-call turns

Status: closed.

Provider: Codex.

Area: rollout ownership, MCP turns, user rows.

This is an early form of the current ownership problem.

During MCP/tool-call turns, Codex feed rows could disappear because rollout ownership was attributed to the wrong tail or the wrong active session.

PR #160 fixed an important path by correcting rollout tail ownership.

The lesson is that "same cwd" is not proof of ownership.

The active Codex rollout file must be claimed with stronger evidence.

Prompt lineage and provider session ids matter.

TDD requirement:

- two Codex sessions same cwd.
- MCP tool turn writes rollout lines.
- old tail updates after new session starts.
- user row remains owned by correct session.

### Issue #168: Codex resume feed broken: proxy streaming turn dropped + duplicate semantic-history keys

Status: closed.

Provider: Codex.

Area: resume, proxy, semantic history keys.

The symptom combined two problems:

- live proxy turn was dropped.
- duplicate keys made semantic-history unstable.

The fix restored live streaming on resume and de-duped semantic history.

The lesson is that resume can reopen several producer planes at once:

- bootstrap committed history.
- active rollout tail.
- proxy stream.
- screen fallback.

The renderer must not decide which producer owns resume.

Headless/runtime must normalize it before Feed sees it.

Feed keys must encode source and turn identity enough to survive duplicate ids.

TDD requirement:

- resume with committed history.
- proxy turn starts after bootstrap.
- semantic history contains same broad turn id twice.
- keys remain unique.
- current turn not dropped.

### Issue #171: Add rendering trace debug for transcript and semantic channel ownership

Status: closed.

Area: debug evidence.

This issue created or motivated rendering trace diagnostics.

The key idea is that a rendering bug should leave a structured trail:

- what committed rows existed.
- what semantic turns existed.
- what ghosts existed.
- what was suppressed.
- what Feed actually painted.
- what screen HTML looked like around the same time.

The rewrite should make this first-class.

Do not bolt debug on after the rewrite.

The rewrite should define the ownership ledger first and render from it.

Then debug is just serialization of the same ledger.

TDD requirement:

- for every render model test, assert the debug rows match selected items.
- no separate debug derivation path.

### Issue #172: Fix feed render ownership across committed transcript, semantic live/history, ghosts, and optimistic input

Status: open.

Provider: all.

Area: the umbrella issue.

This is the root issue for the rewrite.

The title names the four conflicting owners:

- committed transcript.
- semantic live/history.
- ghosts.
- optimistic input.

Queue strip should be included too.

Work indicator should be included too.

Provider conditions should remain adjacent but separate.

The core invariant from the issue:

- one visible artifact equals one owner.

The rewrite should treat rendering as a compiler:

- raw events.
- normalized observations.
- known pattern detectors.
- unknown pattern diagnostics.
- ownership ledger.
- selected render items.
- dumb rows.

TDD requirement:

- all old script test invariants.
- saved-bundle regressions.
- provider fixture regressions.
- unknown event regressions.

### Issue #173: Codex agents cross-render transcripts

Status: closed.

Provider: Codex.

Area: session ownership.

The symptom was a new empty Codex agent printing another agent's JSONL.

This is a catastrophic ownership bug.

It proves rendering cannot use cwd or recent file activity alone.

It must know the producer identity.

The fix path involved stricter session/rollout ownership.

The rewrite should carry this as a non-negotiable.

No committed row is renderable unless runtime has claimed its lineage.

TDD requirement:

- session A and session B same cwd.
- session B starts empty.
- session A writes rollout.
- B does not render A output.
- debug logs rejected candidate and reason.

### Issue #174: Prompt suggestions leak into feed as raw items

Status: open.

Provider: both.

Area: sidecar/provider helper calls.

The symptom is raw prompt suggestion items entering feed.

This is the same class as title generation and predict-next-prompt sidecars.

Provider helper requests can look like assistant output.

They are not conversation output.

Sidecar detection must happen before feed ownership.

Known sidecar shapes:

- title generation.
- branch/title generation.
- predict-next-prompt.
- prompt suggestions.
- compaction summary helper calls.
- hook/verification calls.
- agent verification helper calls.

The renderer should have a backstop sidecar filter.

But provider adapters should filter earlier when they can see request shape.

TDD requirement:

- title generation does not render.
- prompt suggestion does not render.
- short real assistant answer still renders when not sidecar-shaped.
- ambiguous sidecar is logged.

### Issue #178: Handle sub-agent rendering for both Claude and Codex

Status: open.

Provider: both.

Area: child agents, transcript nesting, orchestration.

Sub-agents can produce visible output that belongs somewhere.

The current feed model is mostly single-session.

Sub-agent rendering needs a policy:

- inline under parent?
- separate dispatch child pane?
- collapsed summary row?
- linked transcript reference?
- live child output streamed into parent?

Until that is explicit, sub-agent output can appear as raw tool output, missing transcript, or duplicate feed content.

The rewrite should not invent this accidentally.

It should log sub-agent behavior it does not understand.

TDD requirement:

- parent starts child.
- child streams text.
- child commits transcript.
- parent receives tool result referencing child.
- renderer picks exactly one visible parent surface.

### Issue #179: Handle background processes and terminals for both Claude and Codex

Status: open.

Provider: both.

Area: background process output.

Background terminals are not assistant messages.

They are not normal tool results either.

They may need:

- live terminal surface.
- collapsed process row.
- output tail preview.
- status indicator.
- separate terminal leaf.

The rewrite must avoid treating background process output as assistant text.

It must also avoid hiding important long-running output.

TDD requirement:

- tool starts background command.
- process emits output after assistant turn ends.
- feed shows process surface or terminal link.
- assistant text does not absorb terminal output.

### Issue #180: Harden markdown hyperlink handling

Status: closed.

Area: safe rendered content.

Markdown rendering is part of the rendering rewrite because links can crash or navigate the Electron app.

Safe link handling must remain in the row layer.

The ownership selector should decide that a markdown text block exists.

The markdown renderer should decide how links activate safely.

Current behavior:

- prevent default navigation.
- stop propagation.
- external URLs go through IPC.
- file links open in Global Editor.
- unsupported targets become inert spans.
- unsafe schemes are rejected.
- path traversal is rejected.

TDD requirement:

- safe http link.
- safe https link.
- file link.
- relative local file.
- javascript scheme.
- path traversal.
- missing file accepted or delegated according to main-boundary policy.

### Issue #181: Open clicked file paths in Global Editor from rendered markdown/feed content

Status: closed.

Area: rendered content activation.

The rendering pipeline must preserve enough metadata for file references to open correctly.

This is not just markdown.

Tool rows, code blocks, grep/read output, and assistant prose can all contain file links.

The rewrite should not flatten everything into untyped HTML.

TDD requirement:

- markdown file link opens editor.
- inline code file path opens editor when intended.
- tool result file path opens editor.
- unsafe path rejected.

### Issue #183: Add comprehensive rendering regression tests

Status: open.

Area: testing.

This issue is the direct test mandate.

The old script tests were useful because they encoded discovered invariants.

They were junk operationally because they lived in `scripts` and were not part of the test framework.

PR #263 established Vitest and removed the scripts.

Now the invariants must be rebuilt in Vitest.

Required test suites:

- render model ownership.
- semantic reducer ownership.
- ghost predicate.
- queue/optimistic prompt placement.
- provider normalization.
- tool row rendering.
- safe markdown.
- debug ledger.
- saved bundle fixture tests.

The rewrite should not begin by changing production behavior.

It should begin by restoring high-value tests.

### Issue #185: Improve queued message rendering for long prompts and multi-line content

Status: open.

Area: queue strip, prompt visibility.

Queued prompts exist because a user can submit while prior live content still owns the tail.

The queue strip is currently outside `Feed`.

That is why it can stay visible below stale semantic rows.

But once a queued prompt commits into entries, it can move above semantic/work rows again unless Feed has a single ordered plan.

Long prompt rendering is a visual problem on top of an ownership problem.

The rewrite should decide whether queued prompts become render items.

If they do, the selector must order them explicitly.

If they remain outside feed, the handoff to committed entries must still preserve tail visibility.

TDD requirement:

- short queued prompt.
- long single-line queued prompt.
- multiline queued prompt.
- queued prompt commits while semantic history exists.
- queued prompt commits while semantic current exists.

### Issue #191: Fix stale semantic web-search rows sticking at bottom after rollout commit

Status: closed.

Provider: Codex.

Area: committed tool suppression.

The symptom was stale semantic web-search rows persisting after committed rollout caught up.

PR #194 suppressed committed semantic web search.

The lesson is that committed ownership is not only assistant text.

Tool use and tool output need independent ownership.

Codex can commit tool items separately from assistant text.

Therefore whole-turn suppression is wrong for Codex.

TDD requirement:

- live web search starts.
- committed response item for web search arrives.
- live web search row disappears.
- live uncommitted assistant text remains.

### Issue #193: Fix Codex resume fork detection rejecting same-cwd rollout with prompt lineage but no shared item ids

Status: open.

Provider: Codex.

Area: resume/fork ownership.

The renderer must not render another session's rollout.

But the claim logic must also not reject the correct resumed/forked rollout when ids do not line up perfectly.

The current direction is to prove fresh rollout ownership by prompt lineage, not recency.

Same cwd is insufficient.

Shared item ids are strong when available but not always present.

Prompt lineage can be a valid proof.

The rewrite should not bake rollout selection into Feed.

Headless/runtime must deliver only claimed committed entries.

Feed should log if a claimed entry lacks expected identity metadata.

TDD requirement:

- same cwd, no shared item ids, matching prompt lineage.
- same cwd, no shared item ids, mismatched prompt lineage.
- different cwd, matching-looking prompt text.
- fork switch opens new tail before old tail closes.

### Issue #206: Add MCP transcript consumption tools for reviewing agent work

Status: closed.

Area: orchestration/transcripts.

This matters for rendering because the app now consumes transcripts from child agents and MCP tools.

Transcript consumption must not become an untyped feed injection path.

If MCP transcript messages are displayed, they need owner and scope.

TDD requirement:

- MCP transcript is available.
- parent feed references transcript.
- transcript content does not cross-render into active session feed unless explicitly selected.

### Issue #211: Codex orchestration agents do not receive initial prompt on launch

Status: closed.

Area: orchestration prompt delivery.

This is prompt ownership again.

The initial prompt belongs to the child agent.

The parent may show orchestration status, but not render the child prompt as if it were parent conversation unless explicitly designed.

TDD requirement:

- child initial prompt delivered.
- child prompt visible in child transcript.
- parent status does not duplicate child prompt as parent user row.

### Issue #239: Optimistic submitted user prompts are buried behind semantic/work rows

Status: closed.

Provider: Codex.

Area: prompt tail visibility.

This was the concrete saved-bundle shape that forced the FeedRenderItem plan.

The prompt did exist.

It was visually buried above semantic-history/current/work rows.

The user perception was "my prompt did not render".

The root cause was independent JSX buckets.

Entries rendered first.

Semantic history rendered later.

Current semantic rendered later.

Work rendered last.

Thus stale semantic rows could occupy the tail after a new prompt.

PR #252 fixed one submit path by using `QueueStrip` when semantic content already owned the tail.

But the broader answer is single ordered render items.

TDD requirement:

- prompt submitted while semantic history exists.
- prompt remains visual tail or queue tail.
- when committed row arrives, prompt remains ordered correctly.
- stale semantic history sorted by endedAt before newer prompt.

### Issue #241: Codex QueueStrip can keep processed follow-up prompts stuck after idle

Status: open.

Provider: Codex.

Area: queue reconciliation.

The queue strip can outlive the actual queued work.

The code has several idle cleanup points.

The fact the issue remains open means cleanup is not proven.

Queue ownership must be reconciled by prompt identity.

Normalized text matching is used because exact text can differ through provider formatting.

But fuzzy matching is dangerous.

The rewrite should define a prompt ownership key.

The key should include:

- normalized prompt text.
- session id.
- submit sequence.
- provider kind.
- optimistic id if present.
- committed row id if present.

TDD requirement:

- queued prompt commits.
- queued prompt removed.
- idle clears stale queue.
- unrelated similar prompt does not clear wrong queue item.
- multiline normalization is stable.

### Issue #253: Orchestration follow-up prompt not reliably inserted for inherited child agents

Status: open.

Area: orchestration prompt insertion.

This is a newer version of prompt delivery ownership.

The renderer must distinguish:

- parent prompt.
- child initial prompt.
- child follow-up prompt.
- tool-invoked prompt.
- queued follow-up prompt.

When inherited context is involved, the transcript can contain copied history and new prompt content.

The rendering rewrite should never infer ownership solely from text.

It must carry session lineage.

### Issue #259: Add option to disable automatic analysis prompts for newly created Codex agents

Status: open.

Area: automatic prompts, sidecar-like content.

Automatic prompts are dangerous for rendering because they are user-like text not typed by the user at that moment.

They need a visible owner if shown.

They need a hidden/system owner if not shown.

They must not be confused with the user's current prompt.

TDD requirement:

- auto analysis prompt enabled.
- auto analysis prompt disabled.
- user prompt follows auto prompt.
- feed distinguishes both.

## Appendix: PR Trail, Detailed

This section maps merged PRs to rendering lessons.

### PR #2: Fix post-refactor permission and feed rendering regressions

Early proof that permission UI and feed rendering are coupled but must remain separate.

Permission prompts are provider conditions.

They should not be rendered as assistant transcript text.

The rewrite should preserve provider condition outlets.

### PR #3: Fix workspace bootstrap and Codex feed rendering

Early proof that bootstrap and committed history can break feed rendering.

Bootstrap is replay.

Replay must not be treated like fresh live streaming.

The rewrite needs bootstrap-aware tests.

### PR #7: Render orphaned ghost fallback entries

This introduced or restored ghost fallback rendering.

The good part:

- semantic evidence is not lost when committed JSONL stalls.

The bad part:

- orphaned ghosts can render sidecar/helper calls if the predicate is too broad.

The final ghost predicate is layered because this PR solved one failure and exposed another.

### PR #25: Prompt/provider conditions baseline

This belongs in the trail because provider prompts are typed conditions.

The rewrite should keep prompt/approval/trust flows outside feed ownership.

### PR #35: Drop AGENTS.md + env_context bootstrap from feed

This is a sidecar/bootstrap filtering lesson.

Provider bootstrap content can look like conversation content.

It is not always renderable.

The rendering pipeline must know which provider inputs are context/config rather than user-visible transcript.

### PR #47: Filter Claude Code title-gen / sidecar calls by request shape

This is the provider-side sidecar filter.

It proves renderer-only filtering is too late when the proxy has better information.

Claude proxy can see request shape.

It can demote title generation before semantic feed creation.

Renderer still needs a backstop because not every path goes through proxy.

### PR #54: Suppress orphan ghosts with title-gen / predict-next-prompt shape

This is the renderer-side ghost backstop.

After PR #7, ghosts could render sidecar calls.

The fix added shape filtering.

The important tradeoff:

- short real answers can resemble sidecar summaries.
- hiding all short assistant ghosts would lose real output.
- rendering all short assistant ghosts would show sidecars.

The current predicate balances this with timestamp and ownership rules.

### PR #66: Render orphan ghosts only when JSONL stalls past proxy

This added the JSONL freshness rule.

Ghost fallback should only appear when semantic evidence is newer than committed tail or committed tail is unknown.

Do not render ghosts if JSONL already caught up.

Do not use `Date.now()` as the primary proof.

Use committed entry timestamps and semantic/ghost timestamps.

### PR #134: Live preview for streaming Write tool calls

This is the Write JSON scanner story.

It turned raw partial JSON into a typed preview.

The broader rewrite lesson:

- every known provider/tool shape should have a detector.
- unknown shapes should be logged.
- raw JSON should be last resort.

### PR #160: Correct rollout tail ownership

This fixed feed clearing during MCP/tool-call turns.

The root problem was Codex rollout ownership.

The rewrite must keep rollout claiming out of Feed.

Feed cannot know enough about files, sessions, lineage, and proxy state.

### PR #165: Keep semantic history visible while JSONL catches up

This PR is why semantic history exists.

Without semantic history, completed live turns disappear before committed JSONL arrives.

With semantic history, stale live turns can remain too long.

The selector must make semantic history temporary and suppressible.

### PR #167: Restore Codex live streaming on resume + de-dupe semantic history

Resume can create duplicate history keys and dropped proxy turns.

The rewrite must key semantic history with enough source/turn/block context.

It must not assume resume is only committed replay.

### PR #170: Suppress committed semantic assistant duplicates

This is committed assistant text suppression.

It solved duplicate assistant text where semantic and committed planes both owned the same answer.

Claude can often suppress by whole turn id.

Codex needs finer-grained suppression because commits are item-level.

### PR #175: Establish Codex rendering foundation

Codex introduced different assumptions:

- rollout JSONL.
- proxy SSE.
- screen fallback.
- function calls.
- web search.
- local shell.
- sparse turn ids.

The rewrite must not project Claude's message model onto Codex.

### PR #176: Stream Codex tool rendering

Codex live function calls reuse committed row renderers where possible.

This reduces duplication but creates coupling.

The selector must supply enough live block metadata for the committed row component to render correctly.

The row component must not decide ownership.

### PR #184: Ship semantic-first rendering stack

This was the large attempt to move away from screen scraping.

It established the right direction:

- semantic live turns.
- committed transcript rows.
- screen as fallback/diagnostics.

But it did not fully centralize ownership.

Some decisions remained in React branches.

The rewrite should keep the semantic-first direction and finish the ownership compiler.

### PR #186: Tighten semantic render ownership

This tightened suppression and ownership after PR #184.

It shows the pattern:

- broad semantic-first change.
- bug found.
- narrower ownership guard added.

The new rewrite should encode those guards as tests before refactoring.

### PR #194: Suppress committed semantic web search

This was tool-level committed suppression.

It proves text suppression is insufficient.

Tool use and tool output need ids.

When ids are missing, the unknown behavior logger should fire.

### PR #197: Prove fresh rollout ownership

This is the Codex resume/fork ownership PR.

It moved away from recency and cwd as proof.

Fresh ownership needs lineage evidence.

The render pipeline should consume only claimed committed events.

### PR #215: Fix feed debug append backpressure

Debug logging itself can become a performance problem.

The rewrite wants more diagnostics, so it must respect backpressure and retention.

Feed-debug streams need caps.

Bundle collection needs truncation.

Tests should not rely on unbounded logs.

### PR #252: Fix Codex prompt queue rendering ownership

This fixed the immediate buried-prompt path by queuing instead of appending when semantic content owned the tail.

It is important but incomplete.

Queue is not a substitute for single ordered render items.

The rewrite should include queue as an owner in the render plan or prove an equivalent handoff invariant.

### PR #256: Unify feed render item ordering

This PR moved toward the current `FeedRenderItem[]` plan.

It changed Feed from hardcoded buckets to a unified item order.

The rewrite should keep this direction.

The next step is making the plan more explicit and more test-backed.

### PR #262: Clean up feed render model compatibility fields

This removed compatibility leftovers after the item model.

It matters because compatibility fields can hide old ownership paths.

The rewrite should avoid leaving parallel APIs that let old JSX buckets creep back.

### PR #263: Establish Vitest testing stack and remove script tests

This is the foundation for the tests-first rewrite.

It removed one-off script tests from `scripts`.

It established Vitest projects.

It did not preserve all old rendering invariants yet.

The next PR should salvage those invariants into real tests.

## Appendix: Old Script Test Salvage Matrix

The old tests were operational junk.

The invariants were not junk.

They should be rewritten as Vitest unit tests.

### Salvage: feed render model

Old area: `test-feed-render-model.ts`.

New target:

- `src/renderer/src/features/feed/model/renderModel.test.ts`

Core cases:

- conversation entries are visible.
- meta entries are hidden.
- compact boundary entries are visible.
- compact summary entries are visible.
- non-conversation system entries are hidden unless explicitly visible.
- committed entries sort by timestamp.
- missing timestamps fall back to stable sequence.
- semantic history renders only if still renderable.
- semantic current renders only if still renderable.
- work item renders when phase is non-idle.
- empty item renders only when no content item exists.
- debug rows match render items exactly.
- stale semantic history sorts before newer user prompt.
- current semantic response sorts after new user prompt.
- queue/optimistic prompt ordering stays explicit.

### Salvage: ghost fallback

Old area: `test-ghost-fallback.ts`.

New target:

- `src/renderer/src/workspace/ghosts.test.ts`
- `src/renderer/src/features/feed/model/renderModel.ghost.test.ts`

Core cases:

- ghost not visible before orphan TTL.
- orphaned ghost visible after TTL when no committed catch-up.
- superseded ghost hidden.
- semantic-owned ghost hidden.
- ghost older than JSONL tail hidden.
- sidecar-shaped ghost hidden.
- non-sidecar real assistant ghost visible.
- no surviving ghosts returns original entries by reference.
- tool output ghosts are not minted.
- compaction synthesis ghosts are not minted.
- Codex web/search/local shell ghosts are not minted unless explicitly supported.

### Salvage: semantic committed text

Old area: `test-semantic-committed-text.ts`.

New target:

- `src/renderer/src/features/feed/ui/semantic/renderUnits.test.ts`
- `src/renderer/src/features/feed/model/renderModel.semantic.test.ts`

Core cases:

- exact committed assistant text suppresses semantic text.
- normalized committed assistant text suppresses semantic text.
- committed text does not suppress different live text.
- text suppression does not suppress unrelated tool block.
- tool suppression does not suppress unrelated text block.

### Salvage: Codex semantic fold replacement

Old area: `test-semantic-fold-codex-replace.ts`.

New target:

- `src/renderer/src/workspace/semantic/foldEvent.codex.test.ts`

Core cases:

- proxy can replace empty rollout shell.
- proxy cannot replace non-empty rollout with mismatched turn id.
- completed proxy turn can yield to follow-up response.
- ended pending-tool turn can yield.
- terminal proxy missing completion does not block forever.
- block events with mismatched turn id are rejected and diagnosed.

### Salvage: Codex optimistic submit

Old area: `test-codex-optimistic-submit.ts`.

New target:

- `src/renderer/src/workspace/hook/actions/streaming.codex.test.ts`
- `src/renderer/src/features/feed/model/renderModel.queue.test.ts`

Core cases:

- idle Codex submit appends optimistic user entry.
- submit while semantic current visible queues.
- submit while renderable semantic history visible queues.
- submit while semantic history fully committed does not queue.
- committed user row reconciles optimistic entry.
- committed user row reconciles queued message.
- idle cleanup clears stale queue.
- similar prompt does not clear unrelated queue.

### Salvage: Codex semantic channel

Old area: `test-codex-semantic-channel.ts`.

New target:

- `packages/codex-headless/src/channels/SemanticChannel.test.ts`
- `packages/codex-headless/src/CodexHeadless.semantic.test.ts`

Core cases:

- strict current turn gate rejects mismatched delta.
- rollout delta without active turn either soft-opens or logs intentional drop.
- proxy flow selected by request id.
- ignored proxy flow emits diagnostic but no renderable turn.
- terminal completion releases active semantic owner.

### Salvage: Claude proxy API error release

Old area: `test-claude-proxy-api-error-release.ts`.

New target:

- `packages/claude-code-headless/src/proxy/ClaudeProxyAdapter.test.ts`

Core cases:

- proxy API error releases active flow.
- next flow can become active.
- failed sidecar does not become assistant content.
- error event updates phase/diagnostic without creating duplicate row.

### Salvage: Codex ready for prompt

Old area: `test-codex-ready-for-prompt.ts`.

New target:

- `packages/codex-headless/src/CodexHeadless.readiness.test.ts`
- `src/renderer/src/workspace/hook/actions/streaming.codex.test.ts`

Core cases:

- screen-ready but no semantic is not prompt accepted.
- rollout-ready can accept prompt.
- proxy-ready can accept prompt.
- process active but no backend events logs missing readiness.

### Salvage: rendered content targets

Old area: `test-rendered-content-targets.ts`.

New target:

- `src/renderer/src/features/feed/ui/markdown/MarkdownComponents.test.tsx`
- `src/renderer/src/features/feed/lib/helpers.renderedContent.test.ts`

Core cases:

- external URL opens externally.
- file path opens editor.
- unsafe scheme rejected.
- path traversal rejected.
- missing file is delegated according to boundary.
- click does not navigate Electron webview.

## Appendix: Target Test Architecture

Use Vitest.

Do not resurrect script tests.

Do not add ad hoc `tsx scripts/test-*.ts`.

Do not require Electron for pure ownership tests.

The test stack should be layered:

- pure unit tests for selectors/reducers/parsers.
- component tests for row rendering and safe link behavior.
- provider-headless unit tests for channel normalization.
- fixture tests for saved debug bundles.
- integration tests for renderer runtime ingestion.
- optional Playwright/Electron tests only for true app-level behavior.

Recommended projects:

- `unit-renderer`: pure TS/TSX renderer logic under `src/renderer`.
- `unit-headless`: provider packages under `packages/*-headless`.
- `component-renderer`: React row/component tests with jsdom.
- `fixtures-rendering`: saved bundle and transcript fixtures.

Do not snapshot massive DOM output by default.

Snapshot ownership ledgers instead.

Snapshot small row HTML only when visual structure is the behavior.

Prefer table tests for provider cases.

Use builder helpers:

- `entryBuilder`.
- `semanticTurnBuilder`.
- `semanticBlockBuilder`.
- `committedTextSetBuilder`.
- `ghostBuilder`.
- `runtimeBuilder`.
- `queueMessageBuilder`.
- `codexRolloutLineBuilder`.
- `claudeTranscriptEntryBuilder`.

Builder rules:

- default objects should be valid.
- every id should be explicit or deterministic.
- every timestamp should be explicit in ordering tests.
- every provider difference should be named.
- no test should depend on wall-clock `Date.now()` unless the test injects time.

Fixture rules:

- save minimized fixtures, not whole huge bundles.
- preserve enough metadata to prove ownership.
- include original bundle id in fixture comments.
- include the issue or PR reference in the test name.
- redact prompt body where not needed.
- preserve hashes or short previews for matching.

What to assert:

- selected owner.
- selected order.
- suppression reason.
- diagnostic reason for rejected candidate.
- debug ledger row.
- no duplicate visible artifact.

What not to assert:

- incidental CSS class order.
- exact generated React key when behavior does not require it.
- full markdown HTML for every prose case.
- provider implementation internals from renderer tests.

## Appendix: Render Pipeline Rewrite Blueprint

The target pipeline should be explicit.

Stage 1: Raw provider input.

- Claude proxy SSE.
- Claude JSONL transcript entries.
- Claude screen frames.
- Codex Responses SSE.
- Codex rollout JSONL lines.
- Codex screen frames.
- local submit events.
- queue events.
- ghost journal events.

Stage 2: Provider observations.

- `assistant_text_delta`.
- `assistant_message_committed`.
- `tool_call_started`.
- `tool_call_delta`.
- `tool_call_completed`.
- `tool_output_committed`.
- `user_message_committed`.
- `provider_condition_detected`.
- `sidecar_detected`.
- `unknown_provider_shape`.

Stage 3: Normalized runtime state.

- committed entries.
- semantic current.
- semantic history.
- ghost candidates.
- optimistic prompts.
- queued prompts.
- work phase.
- provider conditions.
- diagnostics.

Stage 4: Ownership candidates.

- committed row candidate.
- semantic current unit candidate.
- semantic history unit candidate.
- ghost candidate.
- optimistic prompt candidate.
- queued prompt candidate.
- work candidate.
- empty candidate.

Stage 5: Ownership ledger.

Each candidate gets:

- candidate id.
- source plane.
- provider.
- session id.
- provider session id if known.
- turn id if known.
- block id if known.
- tool id if known.
- text key if text.
- timestamp.
- lifecycle state.
- suppression candidates.
- selected owner boolean.
- rejection reason.
- unknown behavior refs.

Stage 6: Ordered render items.

The selected ledger becomes:

- `FeedRenderItem[]`.

Stage 7: Dumb row renderers.

Rows receive typed data and render.

Rows do not:

- choose provider ownership.
- suppress semantic duplicates.
- inspect global runtime.
- parse screen text.
- reconcile queues.
- claim rollout files.

Rows may:

- render markdown safely.
- render tool-specific UI.
- truncate long output.
- format timestamps.
- emit local UI interaction callbacks.

## Appendix: Unknown Behavior Logging Contract

The user specifically asked for a pipeline built around detecting any screen or proxy behavior not covered by known patterns.

This should be a first-class contract.

Unknown behavior is not an exception by default.

Unknown behavior is evidence.

Unknown behavior must be logged in a structured way.

Unknown behavior must be testable.

Unknown behavior must not silently become feed text.

Unknown behavior classes:

- unknown proxy event type.
- known proxy event type with unknown payload shape.
- unknown tool call shape.
- unknown tool result shape.
- unknown screen overlay.
- unknown screen prompt.
- unknown provider condition.
- unknown sidecar request shape.
- unknown rollout line type.
- known rollout line with missing ownership id.
- committed row without stable timestamp.
- semantic block without stable block identity.
- tool output without matching tool call.
- duplicate owner candidates.
- no owner candidate for visible provider output.

Every unknown log should include:

- session id.
- provider.
- source plane.
- event family.
- event type if known.
- payload shape path list.
- payload size.
- redacted preview hash.
- timestamp.
- current semantic owner.
- current committed tail id.
- current proxy flow id.
- current rollout path if safe.
- selected render item count.
- reason it was not rendered.
- reason it was rendered as fallback if it was.

Unknown logs should avoid:

- raw authorization headers.
- full prompt text.
- full tool output.
- unredacted file contents.
- full local absolute paths unless debug mode explicitly allows them.

Unknown logs should be surfaced in:

- feed-debug stream.
- debug bundle.
- provider proxy debug artifacts.
- render ownership ledger.
- optional dev panel count.

Unknown logs should have severity:

- `info`: known non-rendered helper behavior.
- `warn`: unknown but safely ignored behavior.
- `error`: unknown behavior that may hide user-visible output.
- `fatal`: ownership conflict that would render cross-session content.

Unknown logs should have disposition:

- `rendered_known`.
- `rendered_fallback`.
- `hidden_sidecar`.
- `hidden_duplicate`.
- `hidden_unowned`.
- `hidden_unsafe`.
- `queued_for_implementation`.

The "queued for implementation" disposition matters.

It is how future agents discover new provider behavior without re-reading every bundle manually.

## Appendix: Provider Comparison Table

Claude durable history:

- Source: Claude JSONL transcript.
- Shape: Anthropic-style entries.
- User and assistant messages are transcript entries.
- Tool results arrive as user-role entries with `tool_result` blocks.
- Tool uses arrive in assistant entries.
- CommittedChannel emits `entry`, `turn_committed`, `compact_boundary`, and `tool_result`.

Codex durable history:

- Source: rollout JSONL.
- Shape: response items and event messages.
- Multiple committed response items can belong to one broad rollout turn.
- Tool calls can commit separately.
- Assistant text can commit separately.
- Session metadata arrives from `session_meta`.
- Fresh rollout ownership requires lineage.

Claude live semantic:

- Preferred source: proxy SSE.
- Screen text is shadow/fallback/debug in current architecture.
- Turn ids usually align with committed message ids.
- Whole-turn suppression is often safe for archived Claude semantic history.
- Tool results are not Anthropic SSE; they arrive later through committed JSONL.

Codex live semantic:

- Sources: proxy SSE and rollout event messages.
- Screen text is shadow/fallback/debug for assistant content.
- Turn ids are sparse.
- `turn_context` is cleaner than payload fallback.
- Whole-turn suppression is unsafe.
- Unit-level suppression is required.

Claude screen:

- Useful for permissions, trust dialogs, slash picker, resume prompt, compaction UI, submit placeholder.
- Dangerous for assistant text.
- Screen parser must handle TUI chrome and stale frames.

Codex screen:

- Useful for approval/trust overlays, readiness, activity, fallback phase.
- Dangerous for assistant text.
- Screen baseline prevents previous-turn leakage.

Claude sidecars:

- title generation.
- branch/title.
- compaction summary.
- hooks.
- verification.
- prompt suggestions.

Codex sidecars:

- rollout bootstrap.
- environment/AGENTS context.
- prompt suggestions.
- provider helper calls.
- web/search/tool rows that may look like assistant messages.

## Appendix: Debug Bundle Evidence Model

A rendering debug bundle should answer:

- What did the provider emit?
- What did headless normalize?
- What did runtime ingest?
- What did semantic reducer own?
- What did committed entries own?
- What did ghost predicate consider?
- What did render model select?
- What did React paint?

The bundle should include:

- manifest.
- session metadata.
- provider metadata.
- current runtime snapshot.
- committed entry tail.
- semantic current/history snapshot.
- ghost snapshot.
- queue snapshot.
- feed-debug log.
- render ownership ledger.
- render diagnostics.
- proxy event tail.
- rollout or transcript tail.
- screen raw tail.
- screen clean tail.
- HTML snapshot if available.
- performance spans.

Retention rules matter.

Feed-debug cannot be unbounded.

Proxy events cannot be unbounded.

Bundle assembly must truncate with line alignment.

Autosave should be gated.

Manual debug bundles can include more detail when the user explicitly asks.

The rewrite should make "save a debug bundle" produce implementation-ready evidence.

The ideal future issue comment should say:

- selected owner: `semantic-history`.
- rejected owner: `committed-entry`.
- rejection reason: `timestamp_after_prompt`.
- unknown: `codex.proxy.response_item.kind=foo_bar`.
- fixture path: `testing/fixtures/rendering/...`.

## Appendix: Comments Already Encoding Critical Why

The codebase has many thick comments.

They are not noise.

They are archaeology.

Examples of comment themes future agents must respect:

- Feed debug rows must come from the same model React paints.
- Semantic folding must be centralized per session.
- Proxy and rollout events must not fight for the same `currentTurn`.
- Codex proxy can replace an empty rollout shell but not non-empty live content.
- Tool results attach to prior tool blocks so rows can render paired state.
- Claude tool results moved to committed channel to avoid committed data mutating live semantics.
- Work indicator is phase-owned, not text-owned.
- Queue strip exists because normal entry ordering could bury submitted prompts.
- Optimistic Codex submit must set stream baseline before adding the optimistic row.
- Codex prompt reconciliation uses normalized text because provider formatting can differ.
- Ghost rendering must be a fallback after JSONL/proxy stall, not normal live rendering.
- Ghost no-op path returns original entries by reference.
- Sidecar filtering must exist provider-side and renderer-side.
- Safe markdown links must never let Electron navigate directly.
- Static code block rendering exists because Monaco had a black-block issue inside prose fences.

During the rewrite, do not delete these comments just because the code moves.

Port the WHY forward.

If a new abstraction absorbs an old tricky branch, move the comment to the new abstraction.

## Appendix: Non-Obvious Failure Modes

Failure mode: a prompt renders but not at the visual tail.

Cause:

- entries render before semantic/work buckets.

Fix direction:

- single ordered render items.

Failure mode: assistant answer duplicates.

Cause:

- semantic current/history and committed row both own same text.

Fix direction:

- committed text suppression with provider-specific granularity.

Failure mode: Codex tool row duplicates.

Cause:

- committed tool response item arrives before live turn ends.

Fix direction:

- tool-id suppression independent from text suppression.

Failure mode: Claude tool result keeps semantic turn alive.

Cause:

- committed tool_result bridged back into semantic with wrong turn id.

Fix direction:

- committed channel owns durable tool results; semantic bridge must not mutate current turn incorrectly.

Failure mode: sidecar helper text appears in feed.

Cause:

- helper request looks like assistant response.

Fix direction:

- provider request-shape filter plus renderer shape backstop.

Failure mode: real short answer hidden as sidecar.

Cause:

- sidecar shape filter too broad.

Fix direction:

- combine sidecar shape with timestamp, ownership, request evidence, and ghost age.

Failure mode: cross-session transcript rendering.

Cause:

- same cwd or recent rollout file treated as ownership proof.

Fix direction:

- lineage claim with provider session id, prompt lineage, and item ids when available.

Failure mode: screen parser creates assistant text from stale frame.

Cause:

- terminal still contains previous answer.

Fix direction:

- screen is not authoritative assistant text; use screen baseline and shadow-only path.

Failure mode: user prompt stuck in queue after it was processed.

Cause:

- reconciliation missed committed prompt row.

Fix direction:

- normalized prompt ownership key and idle cleanup with tests.

Failure mode: render debug says row exists but React paints null.

Cause:

- debug derived before semantic renderability suppression.

Fix direction:

- model checks `semanticTurnHasRenderableContent`; debug serializes selected model.

Failure mode: unknown provider event silently ignored.

Cause:

- parser has no fallback diagnostics.

Fix direction:

- unknown behavior logger.

## Appendix: First Rendering TDD PR Checklist

This is the next concrete PR after this doc.

Do not refactor production rendering yet.

Add tests first.

Create test helpers:

- `src/renderer/src/features/feed/testing/builders.ts`
- `src/renderer/src/workspace/semantic/testing/builders.ts`
- `packages/codex-headless/src/testing/builders.ts`
- `packages/claude-code-headless/src/testing/builders.ts`

Add render model tests:

- visible committed entry cases.
- semantic suppression cases.
- work/empty cases.
- ordering cases.
- debug rows match selected items.

Add ghost tests:

- five-rule predicate.
- sidecar backstop.
- no-op reference identity.

Add queue tests:

- submit while semantic current visible.
- submit while semantic history visible.
- committed prompt reconciliation.
- stale queue idle cleanup.

Add semantic reducer tests:

- Codex proxy replaces empty shell.
- Codex proxy does not replace non-empty content.
- Claude mismatched tool result does not corrupt current turn.
- terminal completed proxy yields.

Add provider tests:

- Codex rollout soft-open behavior decided and tested.
- Claude proxy error releases flow.
- sidecar request filtered.

Add safe rendering tests:

- markdown links.
- file links.
- unsafe schemes.

Success criteria:

- tests fail if old buried-prompt bug returns.
- tests fail if stale semantic web search remains after commit.
- tests fail if ghost sidecar renders.
- tests fail if cross-session rollout renders.
- tests fail if debug model diverges from render model.

## Appendix: Second Rendering TDD PR Checklist

Add ownership diagnostics without changing visible behavior.

Create an ownership ledger type.

Have the current render model populate it.

Serialize it to feed-debug.

Save it in debug bundles.

Expose it in DevDebug panel if that panel still exists.

Tests:

- selected entry has ledger row.
- suppressed semantic text has reason.
- suppressed tool has reason.
- hidden ghost has reason.
- unknown provider shape creates unknown log.
- redaction removes unsafe payload.

Do not make React consume the new ledger yet unless the shape is trivial.

The point is to make evidence reliable before the rewrite.

## Appendix: Third Rendering TDD PR Checklist

Begin production extraction behind the existing API.

Keep `deriveFeedRenderModel` as the public entry point.

Internally split:

- `collectCommittedCandidates`.
- `collectSemanticCandidates`.
- `collectGhostCandidates`.
- `collectPromptCandidates`.
- `collectWorkCandidates`.
- `applyCommittedSuppression`.
- `applyGhostPredicate`.
- `orderCandidates`.
- `buildFeedItems`.
- `buildDebugRows`.

Tests should already cover behavior before extraction.

The PR should be boring.

If behavior changes, add a failing test first.

## Appendix: Fourth Rendering TDD PR Checklist

Move queue prompt ownership into the unified plan or prove the external strip invariant.

Decision point:

- Option A: `queued-prompt` becomes `FeedRenderItem`.
- Option B: `QueueStrip` remains outside Feed but handoff ordering is enforced in model tests.

Option A is conceptually cleaner.

Option A may require UI/layout changes.

Option B is smaller.

The tests should make the decision visible.

## Appendix: Fifth Rendering TDD PR Checklist

Provider normalization hardening.

Codex:

- decide rollout `agent_message_delta` soft-open behavior.
- log or fix missing active channel turn.
- test proxy flow request id selection.
- test response.completed release.
- test fresh rollout claim.

Claude:

- test sidecar demotion.
- test proxy API error release.
- test committed tool_result channel.
- test screen-only condition flow.

Shared:

- unknown provider behavior logger.
- redaction.
- debug bundle inclusion.

## Appendix: What Success Looks Like

When the rewrite is done, a future rendering bug report should not say:

- "feed is cursed".

It should say:

- "candidate `semantic-history:resp_...` was selected after `entry:user:...` because `endedAt` was missing and fallback sequence was wrong."

Or:

- "unknown Codex response item kind `foo` was hidden with severity error and fixture saved."

Or:

- "Claude sidecar request passed proxy filter because request shape changed; renderer backstop hid it; add provider detector."

Or:

- "queue prompt reconciled by normalized text with wrong session id; ownership key missing provider session id."

That is the point of this rewrite.

The code should stop hiding the reason.

The tests should stop relying on memory.

The debug bundle should stop requiring archaeology.

The feed should be a projection of an ownership ledger, not a negotiation between React branches.

## Appendix: Full Agent Response Delta Notes

After the first draft, the complete outputs from the orchestration agents were read again.

This section records the details that were easy to lose in a summary.

The important correction: the provider-conditions report found a current Claude regression.

It is not merely that Claude conditions are "future work".

The shared type surface and renderer outlet exist.

The main session manager still re-emits legacy per-condition Claude events.

But the renderer subscribes only to `session:conditions`, and current `claude-code-headless` does not emit the unified `conditions` event.

Therefore `runtime.conditions` is null for Claude panes and `ClaudeConditionOutlet` does not render trust/permission/resume/compaction overlays through the current unified path.

That belongs in the rendering rewrite because provider conditions are a render channel.

## Appendix: Debug Diagnostics Full Agent Notes

Debug storage lives under `~/.config/agent-code/`.

The high-value paths:

- `feed-debug/<sessionId>.jsonl`
- `debug-bundles/manual/`
- `debug-bundles/autosave/`
- legacy timestamped folders under `debug-bundles/`
- `proxy/<project>/<session>/<run>/proxy-events.jsonl`
- `proxy/<project>/<session>/<run>/session-meta.json`
- `performance/runs/<ISO>-main-<pid>/`
- `heap-snapshots/manual-<ISO>-<pid>.heapsnapshot`
- `ghost-logs/`

When disk gets huge, check:

- feed-debug.
- debug-bundles.
- proxy.
- performance.

Proxy logs are not just debug fluff.

They are source-of-truth recordings of provider HTTP/SSE wire shape.

Debug retention budget:

- budget is `min(15 GiB, max(10 GiB, 3% of disk))`.
- override via `AGENT_CODE_DEBUG_MAX_GB`.
- TTL default is 48h.
- override via `AGENT_CODE_DEBUG_TTL_HOURS`.
- active grace is 10min.
- prune cooldown is 5min.

Retention bucket caps:

- feed-debug: 22%.
- debug-bundles-manual: 8%.
- debug-bundles-autosave: 20%.
- debug-bundles-legacy: 4%.
- proxy: 28%.
- performance: 10%.
- ghost-logs: 8%.

Manual debug bundles are protected from prune.

Ghost logs are protected from age-based prune.

Prune passes:

- TTL.
- per-bucket cap.
- global budget.

All passes respect active grace.

Debug bundle folder name:

- `YYYY-MM-DDTHH-MM-SS-mmm-<sessionId8>`.

The colon-free ISO avoids filesystem trouble.

The session prefix avoids same-second collisions across panes.

`debugBundleRootForReason(reason)` routes:

- `autosave-*` reasons to autosave root.
- everything else to manual root.

Main process bundle writing is intentionally a byte mover.

Renderer assembles the payload because it owns:

- workspace runtime state.
- DOM snapshot.
- sanitized HTML.

Forwarding all that cross-process as independent schemas would duplicate the model.

Debug bundle ledgers:

- manual ledger: `manual/saved-debug-bundles.jsonl`.
- autosave ledger: `autosave/autosaved-debug-bundles.jsonl`.
- legacy mixed ledger is kept only for old references.

Ledger writes are not locked and not fsynced.

The ledger is an operator-friendly index, not the source of truth.

Notes are also written into the bundle as `note.json`.

That makes a copied bundle self-describing even if the global ledger is pruned.

`render-diagnostics.json` is load-bearing.

It is the join table between:

- committed transcript text ownership.
- committed tool ownership.
- live semantic blocks.

It was added because a 2026-05-16 bundle required too much manual reconstruction when committed assistant rows lacked both `message.id` and `codexTurnId`.

`render-diagnostics.json` should keep carrying:

- committed assistant rows.
- uuid.
- message id.
- codex turn id.
- normalized text lengths.
- snippets.
- committed assistant text snippets.
- semantic current turn.
- semantic history.
- text-owned-by-committed flags.
- tool-owned-by-committed flags.
- tool-result-owned-by-committed flags.
- render unit count.
- render unit types.

Manual bundles include proxy event tails when available.

Autosave bundles deliberately skip proxy payloads because proxy logs are already archived and one-minute cadence can multiply disk usage badly.

Proxy event reader tail cap:

- 5 MiB.

When a proxy run exceeds the cap:

- tail trailing 5 MiB.
- drop the first partial line.
- prepend synthetic `truncated` JSONL header.
- point manifest at the full proxy run directory.

Proxy run search strategy:

- sanitize cwd with the same sanitizer as proxy writers.
- prefer `resume-<providerSessionId>` segment when known.
- fall back to all session segments under project.
- pick newest `proxy-events.jsonl` mtime.

Reader never throws.

Missing or unreadable proxy logs return nulls.

Feed-debug memory ring:

- cap is 500 entries.
- first append sets `feedDebugEpochMs`.
- entries store id, ts, relative tMs, layer, kind, summary, optional data.
- append returns a new runtime; reference equality means no-op.

Feed-debug persistence has a dual cursor:

- `persistedFeedDebugIdRef`.
- `inFlightFeedDebugIdRef`.

Persisted cursor advances only after IPC resolves.

Earlier optimistic cursor advancement lost entries on transient failures.

Main-side feed-debug writer:

- one serialized write queue per session.
- append with `flag: 'a'`.
- idempotence through `lastWrittenFeedDebugId`.
- queue entry is deleted only if the map still points to that exact promise.

That final queue deletion guard fixed the old leak surface where thousands of stranded session queues could remain.

Feed-debug filename safety strips anything outside `[A-Za-z0-9._-]`.

Layer taxonomy:

- `STATE`.
- `JSONL`.
- `SEM`.
- `RENDER`.
- `GHOST`.

The old plan said `MAP`; the shipped vocabulary uses `GHOST`.

`STATE` includes:

- session start.
- process status flips.
- draft transitions.
- optimistic user adds.
- screen content changes, except chrome ticks.
- bootstrap replay reconciliation.

`JSONL` includes:

- bulk ingest events.
- before/base/after entry counts.
- dedupe results.
- optimistic reconciliation evidence.

Those counts distinguish healthy reconcile from row-removal gaps.

`SEM` includes semantic event ingress and folded event summaries.

`RENDER` has two production callers:

- `Feed.tsx` visible row diffs.
- composer submit route/keybind events.

`GHOST` includes:

- ghost reconcile reasons.
- sidecar suppression.
- supersession.
- orphan fallback admission.

Chrome-tick screen frames are intentionally not logged when only raw screen strings change.

That keeps feed-debug readable under TUI redraw churn.

Render performance instrumentation:

- gated by `AGENT_CODE_PERF=1`.
- `AGENT_CODE_PERF_SLOW_MS` default 50.
- local JSONL span exporter.
- flush interval 500ms.
- pending cap 2000 records.
- oldest records drop under pressure.

Canonical render-model timing metric:

- `feed.renderModel.build`.

It emits when:

- duration is at least 10ms.
- or entries length is at least 500.

Payload includes:

- entries.
- visible count.
- rows.
- whether semantic streaming exists.

Render trace:

- in-memory per-session HTML commit chain.
- in-memory per-session screen tail snapshots.
- HTML snapshots dedupe by clean HTML hash.
- checkpoint every 20 commits or first commit.
- max 200 HTML commits.
- screen tail 50 lines.
- max 300 screen samples.
- ANSI and CR stripped.

Debug panels:

- `DebugPanel`: runtime state slice, raw/markdown screen tails, inline raw PTY terminal.
- `FeedDebugPanel`: in-memory feed-debug ring, RENDER rows expanded by default.
- `ProxyDebugPanel`: runtime semantic state, no local reducer.
- `HtmlDebugPanel`: focused pane HTML snapshot, clean/raw modes.
- `DevDebugPanel`: investigation modules, currently headless snapshot probe.

Do not reintroduce a local semantic reducer in `ProxyDebugPanel`.

It was removed because it diverged from the workspace semantic reducer.

## Appendix: Markdown And Tool Rendering Full Agent Notes

There are two markdown surfaces:

- `TextProse`.
- `StreamingProse`.

`TextProse` is for committed JSONL assistant text.

It uses `remark-gfm`.

`StreamingProse` is for live streaming text.

It uses `remark-gfm` plus `remark-breaks`.

The newline behavior is intentional because terminal/Ink output has already made visual newlines meaningful.

Remark plugin arrays must stay module-scoped.

React-markdown v10 caches based on plugin identity.

Fresh array literals bust cache.

Markdown component overrides must stay module-scoped too.

React-markdown v10 also caches based on component-object identity.

`MarkdownPre` strips the default `<pre>` wrapper.

That prevents a custom CodeBlock from being nested inside browser-default pre styling.

`MarkdownCode` detects fenced versus inline code by:

- `language-*` class name.
- or newline presence.

React-markdown v10 does not pass a reliable `inline` prop.

Inline code routes through `SafeInlineCode`.

Fenced code routes through static `CodeBlock`.

Prose fences deliberately do not use Monaco.

Reason:

- Monaco mounted in narrow flex cells can initialize at zero width.
- It produced black-block failures.
- `automaticLayout` did not always recover.
- Static highlight.js is enough for prose fences.

Monaco remains for:

- Read results.
- Grep results.
- committed Write rows.
- Codex read/search output.

Live streaming Write uses `highlight={false}`.

Reason:

- highlight.js can become O(n²) when re-highlighting the whole growing buffer on every delta.

Safe markdown links always:

- prevent default.
- stop propagation.
- classify target before acting.

External URLs:

- only http(s).
- opened through IPC.

Local files:

- opened through Global Editor.
- require workspace root.

Unsupported links render as inert spans.

Unsafe schemes include:

- `javascript:`.
- `data:`.
- `file:`.
- `mailto:`.
- `tel:`.
- `blob:`.
- `about:`.
- `chrome:`.
- `devtools:`.
- `vscode:`.
- `vbscript:`.

Unknown `scheme://` is also rejected.

Path traversal through `..` is rejected in renderer classification.

Main-process editor filesystem containment remains the final backstop.

Inline code activation is stricter than markdown link activation.

Agents put commands, versions, prose, and ratios in backticks.

Inline code only becomes clickable when it is path-shaped and has a known extension.

Block row dispatch rules:

- user text gets `UserBand`.
- assistant text gets assistant marker.
- user role does not mean user-authored for every block.
- Anthropic tool_result blocks live inside user-role messages.
- therefore UserBand must be applied only to user text/image blocks, not whole rows.

Thinking blocks:

- empty thinking returns null.
- non-empty thinking renders collapsed details.

Anthropic committed messages usually strip thinking plaintext and keep only signature ciphertext.

WorkIndicator owns "agent is thinking/working"; empty thinking rows should not render.

Git custom rendering:

- Bash or exec_command may render as `GitCardRow`.
- paired tool_result is suppressed.
- single surface owns that command.

Generic ToolUseRow headline priority:

- command.
- file_path.
- path.
- notebook_path.
- pattern.
- query.
- url.
- description.

`description` is last on purpose because Bash descriptions are often redundant glosses of commands.

Interactive question tools currently fall through poorly.

Shapes like `{ question, options }` do not match the headline picker.

Result:

- row may show `AskUserQuestion`.
- body may be blank.
- no option-list UI exists.
- no answer affordance exists.

That maps directly to issue #98.

Tool result extraction flattens:

- string content.
- array content with text entries.

But not all call sites flatten consistently.

Semantic `BlockRow` sometimes reads `block.resultContent` directly.

This is a bug risk.

ToolResultRow suppresses success stubs for:

- Edit.
- MultiEdit.
- Write.
- TodoWrite.

Read result:

- summary row.
- lazy details.
- line-number prefixes stripped before CodeBlock.

Grep result:

- full output CodeBlock.

Default result:

- first 3 lines.
- click-to-expand.
- max 360px scroll.

Every closed details wrapper that contains Monaco must lazy-mount children.

Native closed `<details>` still mounts React children.

Without explicit lazy mount, restored feeds create Monaco instances even for closed old output.

Once opened, code blocks stay mounted to keep copy-code ids stable.

Claude row details:

- file headers use RTL truncation to preserve filename.
- diff slabs tokenize per line so added/removed backgrounds bind to correct rows.
- empty diff lines render zero-width space to keep row height.
- diff slab uses `w-max min-w-full` so background tint extends with horizontal overflow.
- WriteRow line count trims exactly one trailing newline.
- Todo rows use checked/in-progress/open glyphs and active form text when available.

Codex row details:

- apply patch input can live in `raw`, `arguments`, `cmd`, `patch`, or `input`.
- parser scans patch grammar line-by-line.
- exec_command row promotes `$ <command>` as primary surface.
- empty `write_stdin` renders null.
- successful patch apply result renders null.
- patch errors render per-file unified diff.

Live semantic tool rendering:

- Codex function calls reuse committed Codex row renderers.
- apply_patch partial input may be freeform patch, not JSON.
- partial JSON string readers search key names rather than requiring key order.
- Claude/MCP Write has a special streaming scanner.
- non-Write streaming tool_use falls back to raw JSON pre.
- parse errors show a red banner.

`extractStreamingWriteInput` invariants:

- never throw.
- return `filePath` only after its string literal closes.
- return partial content intentionally.
- scan by key name, not positional order.
- tolerate mid-escape EOF.
- tolerate incomplete Unicode escapes by dropping incomplete escape.
- unknown escapes return literal char.

Compaction synthesis:

- raw `<analysis>` / `<summary>` XML must not render.
- live UI renders `Compacting conversation...`.
- committed compact boundary/summary later owns the durable display.

Semantic render units mirror row null decisions.

If row renderer would return null, render-unit builder should filter it.

Otherwise render model/debug claims a semantic row exists while DOM paints nothing.

Collapsed activity rules:

- group low-signal Glob/Grep/Read/FileRead/Bash runs.
- never collapse blocks with real results or errors.
- collapsing finished output silently hides content.

## Appendix: Queue And Optimistic Prompt Full Agent Notes

`QueueStrip` is outside the scrollable Feed div.

It sits between Feed and provider conditions.

That was deliberate after a saved bundle where rendering queued prompts as Feed rows created a strange half-sent user-message artifact.

Submit flow:

1. guard empty draft.
2. guard backend readiness.
3. mint `pasteId` at earliest observable point.
4. record `RENDER/keydown:enter`.
5. snapshot live screen.
6. extract streaming baseline.
7. set streaming baseline.
8. Codex adds optimistic user entry or queue message.
9. write provider-specific PTY input.
10. clear composer draft and images.
11. record submit returned or throw.

`setStreamingBaseline` sets:

- `streamPhase = 'submitting'`.
- `submittedAt = now`.
- `phaseChangedAt = now`.
- `turnStartedAt = now`.
- `awaitingAssistant = true`.
- streaming baseline.
- clears pending rewind undo.

Ordering invariant:

- `setStreamingBaseline` must run before `addOptimisticCodexUserEntry`.

`shouldQueueOptimisticCodexUserEntry` ignores `streamPhase`.

This is load-bearing.

If it looked at non-idle stream phase, every first prompt in an idle Codex pane would be queued because the same submit just set phase to `submitting`.

The ownership signal is renderable semantic content, not stream phase.

A user prompt has exactly one visible owner:

- composer draft.
- queue strip.
- feed committed entry.
- feed optimistic entry.
- semantic representation if applicable.

Codex optimistic prompts are not always appended to entries.

They are queued when:

- live semantic current turn is running.
- or non-current semantic history has renderable content.

The test uses the same predicates Feed uses:

- `buildCommittedAssistantText`.
- `semanticTurnHasRenderableContent`.

Optimistic Codex uuid prefix:

- `optimistic-codex-user:`.

That prefix is the discriminator.

Reconciliation uses normalized prompt ownership key:

- NFKC.
- collapse whitespace.
- trim.

Reason:

- rollout text can differ from submitted text by CRLF.
- rollout text can differ by Unicode normalization.
- rollout text can differ by block-join whitespace.

Optimistic-row reconciliation has two passes per JSONL burst:

- scan this burst's appended accumulator.
- scan pre-burst current entries.

Two passes are necessary because a Codex burst can commit tool-result user rows after the optimistic prompt but before the real user prompt.

By the time the real user prompt lands, the optimistic row may no longer be tail.

Therefore tail-only reconciliation is insufficient.

Throw-path cleanup is conservative:

- `removeOptimisticCodexUserEntry` only removes if the optimistic row is still tail and text matches.

Codex local queue idle auto-clear only fires when:

- provider is Codex.
- queue length > 0.
- process inactive.
- stream phase idle.
- not awaiting assistant.

It does not fire for Claude because Claude has provider queue-operation records.

Codex idle queue cleanup fires at three seams:

- process-state inactive.
- semantic awaiting flips false.
- bootstrap complete.

At bootstrap complete, `awaitingAssistant` is treated as false for the check because the same missing rollout handoff that leaves queue stale can also leave awaiting stale.

Claude `queue-operation` JSONL is the only provider-driven queue source.

Claude queue operation handling:

- enqueue appends queued message.
- dequeue/remove shifts first queued message.
- queue entries do not carry identity.
- non-empty queue forces `awaitingAssistant = true`.

`totalEntries` is not bumped by optimistic rows.

Optimistic entries are transient UI.

The later JSONL append bumps total exactly once when the real entry lands and replaces the optimistic row.

Claude paste race:

- bracketed paste payload plus Enter in one PTY write races Claude paste accumulator.
- Enter can arrive while Claude still considers paste in-flight.
- prompt appears in composer.
- Claude flips to working.
- no turn starts.
- next Enter sends it.

Current constants:

- paste threshold 100 chars.
- submit delay 125ms.
- image path submit delay 750ms.
- event-driven placeholder timeout 500ms.

The threshold was lowered from 800 after real dumps showed races around 145-215 chars.

Event-driven placeholder detection is primary.

Wall-clock fallback is secondary.

Poll lives main-side to avoid an IPC round-trip every 10ms.

Single-write fast path is effectively Codex-only.

Per-paste journals hash payloads for cross-process correlation.

Surprising but intentional:

- Codex adds optimistic prompt before PTY write.
- cleanup is best-effort.
- this prefers making ignored-prompt failures visible over perfect cleanup.
- Claude does not create optimistic entries; Claude JSONL and queue-operation are authoritative.
- composer auto-grow cap is flat 320px, not pane-aware.

## Appendix: Provider Conditions Full Agent Notes

Conditions are a render channel.

They are the typed projection of blocking provider TUI overlays:

- trust dialog.
- approval prompt.
- permission prompt.
- resume prompt.
- compaction state.
- slash picker.
- model switch prompt.

Flow:

```text
provider TUI/PTY
-> screen frames
-> headless parser
-> typed condition snapshot
-> session emits conditions
-> IPC session:conditions
-> renderer applyConditionSnapshot
-> runtime.conditions plus pending shadow fields
-> ProviderConditionOutlet
-> provider-specific outlet
-> overlay component
-> user action
-> PTY write
```

Codex also enriches condition state from rollout metadata:

- screen detects approval overlay.
- rollout fills call id.
- rollout fills command parts.
- rollout fills workdir.

Condition snapshots are keyed/deduped before crossing IPC.

That matters because screen frames can arrive at TUI cadence.

Without dedupe, a modal could cause 60 runtime updates per second.

Shared type surface:

- `ProviderConditionSnapshot`.
- `provider: 'claude' | 'codex'`.
- `conditions` map keyed by condition kind.

Claude condition kinds:

- `claude.trust-dialog`.
- `claude.resume-prompt`.
- `claude.permission-prompt`.
- `claude.compaction`.
- `claude.slash-picker`.

Codex condition kinds:

- `codex.trust-dialog`.
- `codex.approval`.
- `codex.switch-model-prompt`.

Each condition has:

- kind.
- state.
- actions.

Actions can be:

- PTY action with raw data.
- custom action.

But renderer modals currently hardcode keys instead of reading `actions[]`.

This is a mismatch between type promise and implementation.

Codex working path:

- screen parser detects approval.
- screen parser detects trust dialog.
- rollout events patch approval metadata.
- `evaluateCodexConditions` builds snapshot.
- `publishConditionSnapshot` emits only on JSON key change.
- `codexSession` forwards headless `conditions`.

Codex approval actions:

- approve: Enter.
- approve always: `p`.
- deny: Escape.

Codex trust actions:

- accept: Codex trust accept keys.
- reject: `2\r`.

`codex.switch-model-prompt` exists as a type but has no builder and no renderer modal.

It is stranded type surface.

Claude partial/broken path:

- parsers exist for permission prompt, trust dialog, resume prompt, compaction, slash picker.
- headless emits separate legacy events such as `permission-prompt`, `trust-dialog`, `resume-prompt`, `compaction-state`, `slash-picker`.
- current `claude-code-headless` does not emit unified `conditions`.
- main session manager still forwards legacy per-condition events.
- preload exposes legacy subscriptions.
- renderer does not subscribe to those legacy subscriptions.
- renderer only consumes `session:conditions`.

Result:

- Claude `runtime.conditions` stays null.
- `ProviderConditionOutlet` returns nothing for Claude.
- trust/permission/resume/compaction overlays do not render through this path.
- slash picker still renders separately through screen/picker path.

This is a live regression.

It is not just dead code.

`applyConditionSnapshot` writes two surfaces:

- raw `runtime.conditions`.
- convenience shadow fields like `pendingTrustDialog`, `pendingResumePrompt`, `pendingPermissionPrompt`, `pendingCompaction`, `pendingApproval`, `picker`.

The duplication is intentional during migration.

But it is a divergence risk.

Dispatch badges and modals can disagree if one surface updates without the other.

Condition outlet mount site:

- inside each pane.
- below feed, queue strip, and composer hints.
- above toast and scroll indicator.

Overlays are pane-local, not app-global.

Claude outlet components:

- resume prompt inline strip.
- permission prompt full-screen pane overlay.
- compaction strip.
- trust dialog full-screen pane overlay.

Codex outlet components:

- approval inline strip.
- trust dialog full-screen pane overlay.

Codex approval modal forwards arrow keys to PTY and keeps local selection for snappy UI.

The parsed `>` marker from next screen frame keeps local UI aligned with TUI state.

Slash picker is not currently in the outlet tree.

It renders from `runtime.picker`.

That is deliberate for cadence.

But the presence of `claude.slash-picker` in condition types is misleading.

Screen parsing is allowed for command/modal/detection UI.

Screen parsing is not allowed to drive main assistant rendering.

Conditions are allowed to be screen-sourced because:

- data is small and bounded.
- wrong condition dedupe cannot duplicate assistant prose.
- some option highlight state exists only on screen.
- rollout/proxy can enrich it when available.

Condition limitations to track:

- Claude unified conditions not produced.
- Codex switch-model type has no builder or modal.
- renderer ignores `actions[]` and hardcodes keystrokes.
- runtime has duplicate typed and pending condition surfaces.
- slash picker bypasses conditions.
- dynamic actions would affect JSON-key dedupe.
- compaction `done` renders null, creating possible `running -> null -> summary` flicker.
- Claude paste/clipboard/cwd-conflict prompts are not typed as conditions.

Future condition implementation discipline:

- add parser.
- add provider condition kind.
- add builder.
- wire headless emission.
- wire runtime session forwarding.
- add outlet component.
- test dedupe.
- test typed actions.
- test legacy fallback removal.

## Appendix: Old Script Tests Full Agent Notes

The deleted rendering script tests were not junk conceptually.

They were junk operationally because they lived in `scripts`.

They were stamped as temporary rendering regression scripts until app-wide testing and rendering regression coverage existed.

PR #263 removed them.

The next rendering PR must salvage their invariants into Vitest.

### Old `test-feed-render-model.ts`

Size:

- 748 LOC.

Target:

- `deriveFeedRenderModel`.

New home:

- `src/renderer/src/features/feed/model/renderModel.test.ts`.

Comment to preserve:

```text
the failure mode we keep reintroducing is not 'React cannot map an array.'
It is 'two different data planes both believe they own the same assistant slot.'
A pure selector test makes that ownership contract executable without needing a browser.
```

Invariant 1:

- committed visibility hides meta/system noise without hiding conversation rows.

Invariant 2:

- Claude committed `message.id` suppresses archived semantic copy of same turn.

Invariant 3:

- hidden/non-assistant message ids must not suppress semantic history they do not visibly own.

Invariant 4:

- Codex current semantic turn disappears when all units are committed duplicates across proxy/rollout id split.

Invariant 5:

- archived semantic history must place chronologically before newer optimistic prompt, not after.

Invariant 6:

- archived text-only rollout turns suppress once committed text owns same rendered message.

Invariant 7:

- visible committed assistant text without `message.id` still suppresses same rollout history text.

Invariant 8:

- Codex committed tool-item rollouts must not suppress whole semantic turn by broad `codexTurnId`.

Invariant 9:

- committed `tool_use` ownership suppresses live semantic turn whose only unit is that committed tool.

Invariant 10:

- committed `tool_use` alone must not hide live tool output before committed `tool_result` lands.

Invariant 11:

- committed `tool_result` ownership suppresses duplicate live output block.

Invariant 12:

- empty `write_stdin` must not count as renderable semantic content.

Invariant 13:

- non-empty `write_stdin` still renders.

Invariant 14:

- semantic history drops current turn id so history/current cannot double-own one turn.

Invariant 15:

- current semantic output that starts after user prompt stays below that prompt.

Invariant 16:

- late-arriving history inserts above already-rendered newer prompt.

Invariant 17:

- committed web_search tool_use plus committed answer text suppresses archived proxy web-search turn.

Invariant 18:

- work state renders independently before committed/semantic content exists.

Helpers to preserve as builders:

- `assistantEntry`.
- `assistantEntryWithoutMessageId`.
- `userEntry`.
- `systemEntry`.
- `liveTurn`.
- `textBlockTurn`.
- `toolBlockTurn`.
- `toolOutputTurn`.
- `writeStdinTurn`.
- `webSearchHistoryTurn`.

Preserve `committedToolUseIndex` and `committedToolResultIndex` map shapes.

Do not port this as one giant Vitest file.

Split by invariant groups.

### Old `test-ghost-fallback.ts`

Size:

- 292 LOC.

Targets:

- `selectMergedEntries`.
- `orphanStale`.

New homes:

- `ghosts.test.ts`.
- `mergedEntries.test.ts`.

Comment to preserve:

```text
Wall-clock anchor for tests.
Concrete values keep the predicate inputs explicit and avoid Date.now() drift between assertions.
```

Invariants:

- empty ghost map returns `runtime.entries` by reference.
- unorphaned ghost does not render.
- superseded ghost does not render.
- orphan ghost for live current turn is hidden.
- orphan ghost for semantic-history turn is hidden.
- orphan older than `lastJsonlEntryAt` is hidden.
- orphan newer than `lastJsonlEntryAt` with sidecar shape is hidden.
- orphan newer than `lastJsonlEntryAt` with substantive text renders.
- orphan tool_use ghost newer than `lastJsonlEntryAt` renders even when short.
- `lastJsonlEntryAt === null` allows orphan through if other shape rules pass.
- `orphanStale` returns same map by reference on no-op.
- `orphanStale` creates a new map when threshold elapses.

Preserve:

- `SIDECAR_GHOST_TEXT_MAX = 200`.
- explicit fixed wall-clock anchors.
- explicit role/content shapes from agent transcript parser.

### Old `test-semantic-committed-text.ts`

Size:

- 181 LOC.

Target:

- `buildSemanticRenderUnits`.

New home:

- `renderUnits.test.ts`.

Invariants:

- committed text suppresses finalized live text across Codex proxy/rollout id split.
- same-turn-id committed text suppression still works.
- non-identical live text still renders.

Preserve committedAssistantText semantics:

- turn-text keys.
- raw text set.
- normalized text set.

The old literal duplicated text came from a debug bundle.

New fixture should preserve structural shape and use synthetic text unless literal content is required.

### Old `test-semantic-fold-codex-replace.ts`

Size:

- 246 LOC.

Target:

- `foldSemanticEvent`.

New home:

- `foldEvent.test.ts`.

Invariants:

- completed proxy message turn without `endedAt` can be archived when a new proxy block starts.
- stray block_started while live streaming must not replace current turn.
- completed function_call without `turn_completed` is safe to archive when next proxy turn starts.
- in-progress function_call blocks replacement.
- first block_started against empty semantic runtime initializes current turn.
- Claude provider does not create a Codex-style current turn through this path.

Comment to preserve:

```text
A terminal proxy turn is safe to archive when the next proxy turn starts;
keeping it mounted is worse than losing a pending spinner.
```

### Old `test-codex-optimistic-submit.ts`

Size:

- 186 LOC.

Targets:

- `shouldQueueOptimisticCodexUserEntry`.
- `codexPromptsMatchForOwnership`.
- `shouldClearIdleCodexQueuedMessages`.

New homes:

- `streaming.test.ts`.
- `queueInvariants.test.ts`.

Bug comment to preserve:

```text
The bug this guards was brutally simple: submit calls setStreamingBaseline() first,
which changes streamPhase to 'submitting', then calls addOptimisticCodexUserEntry()
in the same synchronous handler. If the optimistic-row gate treats any non-idle
streamPhase as 'previous turn is live', every first prompt in an idle Codex session
is queued instead of rendered as an optimistic user row. The semantic turn is the
ownership signal; streamPhase is not.
```

Queue matrix:

- submitting + no semantic + no committed => do not queue.
- idle + live current turn => queue.
- tool_running + sealed current turn => do not queue.
- submitting + unsealed renderable history + no committed => queue.
- submitting + unsealed history + committed same text => do not queue.

Prompt match tests:

- CRLF and whitespace normalization match.
- semantically different prompts do not match.

Idle queue clear tests:

- Codex idle inactive not awaiting clears.
- Codex active process does not clear.
- Claude idle inactive does not clear through Codex fallback.

### Old `test-codex-semantic-channel.ts`

Size:

- 56 LOC.

Target:

- Codex `SemanticChannel`.

New home:

- `packages/codex-headless/src/channels/SemanticChannel.test.ts`.

Invariants:

- stale active turn followed by mismatched finish emits lifecycle violation.
- mismatched finish still forwards terminal `turn_completed` for actual turn id.
- active slot releases after mismatch.
- fresh start after mismatch emits clean `turn_started`.

### Old `test-claude-proxy-api-error-release.ts`

Size:

- 209 LOC.

Target:

- Claude proxy adapter and semantic channel.

New home:

- `ClaudeProxyAdapter.test.ts`.

Bug:

- Anthropic `overloaded_error` published.
- failed flow stayed active.
- retry was ignored as concurrent flow.
- feed dropped retry.

Invariants:

- overloaded SSE error emits `api_error` with `isOverloaded`.
- retry success does not emit `flow_ignored` for old failed flow.
- retry emits started and completed turn.
- mid-turn API error emits stopped and completed with partial text.
- retry after mid-turn error has no `start_while_active`.

Preserve SSE builders:

- `sse`.
- `chunk`.
- `startFlow`.
- `endFlow`.
- `successfulTextTurn`.

### Old `test-codex-ready-for-prompt.ts`

Size:

- 81 LOC.

Target:

- `isCodexReadyForPromptScreen`.

New home:

- `codexReadyForPrompt.test.ts`.

Fixture matrix:

- ready screen with GPT model line => true.
- ready screen with non-GPT model => true.
- trust dialog => false.
- startup screen without prompt marker => false.
- working screen => false.
- approval screen => false.
- empty string => false.

Preserve literal screen shapes:

- box drawing chars.
- prompt placeholder.
- model line.
- directory box.

The detector keys on those shapes.

### Old `test-rendered-content-targets.ts`

Size:

- 172 LOC.

Target:

- rendered content target classifiers.

New home:

- `targets.test.ts`.

Invariants:

- http/https allowed.
- trailing slash normalization.
- unsafe protocols rejected.
- malformed URL rejected.
- path suffix line/column parser rejects invalid numbers.
- outside workspace rejected.
- traversal rejected.
- missing workspace root rejected.
- false-positive inline code strings rejected.
- local file paths accepted.
- missing local files accepted by renderer classification.

Reason for accepting missing local files:

- existence check belongs at main-process editor filesystem boundary.
- renderer parsing stays deterministic.
- real click path can still fail safely.

### Deleted Script Non-Goals

Do not revive:

- root `scripts/test-*.ts`.
- live provider harnesses as primary tests.
- DOM snapshots for ownership decisions.

Manual proxy harnesses belong under:

- `tools/proxy-harness/`.
- or `testing/manual/proxy-harness/`.

## Appendix: Codex Full Agent Notes

Codex has three truth planes:

- semantic.
- screen.
- committed.

`semanticShadow` exists for screen fallback so screen-extracted assistant content cannot race renderer-facing semantic content.

Committed means rollout JSONL has already been written.

`CommittedChannel.publishLine` emits:

- raw `rollout_line`.
- `session_meta`.
- every `response_item`.
- `turn_committed` only for response item messages.

Rollout feed UUIDs are deterministic:

- timestamp plus payload id/call id/type/entry type.

This makes overlap/bootstrap replay dedupe possible.

Codex turn ids are sparse.

Clean source:

- `turn_context`.

Fallback:

- `payload.turn_id`.

Renderer carries a rolling Codex turn cursor outside React runtime.

Provider session id source:

- only `session_meta.payload.id`.

`SemanticChannel` is strict transport.

It emits lifecycle violations rather than healing most mismatches.

Exception:

- mismatched `finishTurn` still publishes terminal completion.

Reason:

- stale active turn ids can otherwise leave rendered semantic rows unsealed forever.
- renderer reducer guards by turn id.

Codex proxy flows:

- keyed by proxy request id.
- not keyed by path.
- first chunk wins active flow.
- concurrent flows become secondary.
- `response.completed` releases active slot before socket end.

This release point matters because follow-up tool-output turns can begin before old socket fully closes.

Proxy parser:

- uses StringDecoder.
- normalizes CRLF before SSE splitting.

Do not replace with chunk-level `Buffer.toString`; split multibyte chars can corrupt.

Screen fallback:

- shadow-only for content.
- can own overlays/activity.
- opens synthetic `live-<ts>` shadow turns only when no proxy/rollout owner exists.
- screen baseline suppresses previous-turn leakage.

Codex readiness is screen-based.

Reason:

- `start()` proves plumbing, not prompt readiness.
- trust/approval/working screens are not ready even if process exists.

Apply patch:

- streaming input must flow through `tool_input_delta`.
- apply_patch may be freeform patch, not JSON.
- successful patch-apply results are invisible.
- errors render.

Fresh rollout ownership:

- prove by prompt lineage.
- same cwd is not enough.
- ambiguity fails closed.

Resume fork switching:

- open new fork tail before closing stale tail.
- deterministic UUIDs dedupe overlap.
- closing first risks losing entries.

Known Codex pitfalls:

- comments saying proxy is future parity are stale.
- lineage empty-set comment is stale; code fails closed.
- `agent_message_delta` can synthesize rollout id without `semantic.startTurn`, causing strict channel drop if no active turn exists.
- do not move rolling turn cursor into UI state.
- do not reintroduce singular JSONL IPC.

## Appendix: Claude Full Agent Notes

Claude has three truth planes:

- semantic.
- screen.
- committed.

Semantic:

- model/provider meaning.
- renderer-facing live turns.
- proxy/jsonl high confidence.
- screen fallback is lower confidence and should not drive assistant rendering.

Screen:

- terminal visual truth.
- snapshots.
- activity.
- trust/resume/compaction/slash overlays.
- not assistant rendering.

Committed:

- durable JSONL truth.
- append-only feed/history.
- tool results belong here because Anthropic SSE does not carry them live.

Claude SemanticChannel is strict transport.

Start while active, delta without matching active turn, and mismatched finish are lifecycle diagnostics and drops.

Screen-derived live text publishes to `semanticShadow`.

Renderer is expected to ignore shadow.

Screen owner still exists internally so proxy can preempt/finalize fallback.

JSONL promotion of screen fallback also goes to shadow.

Durable text reaches renderer through committed events.

CommittedChannel emits:

- raw entry.
- turn_committed.
- compact_boundary.
- committed tool_result.

It excludes tool_use/tool_result from committed turn text.

Renderer folding:

- one semantic reducer per session.
- Claude looser than Codex on mismatched turn ids.
- it can archive/replace because pending tool lifecycles otherwise hide subsequent turns.

Claude tool_result:

- pairs by `toolUseId`.
- stamps originating tool block.
- does not create pseudo-entry.

Runtime bridge currently re-emits committed tool_result over semantic-event for renderer compatibility.

It omits committed turnId so strict reducer matching does not drop it before toolUseId pairing.

Claude sidecar filtering:

- title generation.
- branch/title.
- compaction summary.
- hooks.
- agent verification.

Demotion happens at `message_start`.

Reason:

- model id is available then.
- demotion can happen before `turn_started`.

Demotion:

- clears brief requesting phase.
- flips attribution to secondary.
- emits flow_ignored.
- does not release active stream lock until response-end.

Filtering is opt-in gated by `getSessionModel`.

It can be disabled by `sidecarModelPattern: null`.

Request-shape signals are conservative:

- `max_tokens <= 1024`.
- `message_count <= 3`.
- known auxiliary system prompt prefixes.

Permission prompts:

- screen-only.
- parser requires "Do you want to proceed?", "Yes", and "No, and tell Claude".
- approve is Enter.
- deny is `3\r`.

Paste/submit:

- do not use activity as submit success.
- preferred signals are placeholder cleared or JSONL committed entry.
- paste-like text uses bracketed paste then Enter after placeholder or fallback timeout.
- threshold 100 chars or newline.
- event-driven timeout 500ms.
- fallback delay 125ms.

Proxy events:

- mitm emits request, response-chunk, response-end, response.
- SSE chunks are base64.
- buffered SSE response body is intentionally not emitted to avoid duplicate rendering.

Stream phases:

- requesting.
- thinking.
- responding.
- tool-input.
- awaiting-tool.
- idle.

Screen fallback emits coarse thinking/idle only when proxy absent.

Tool-use completion moves phase to awaiting-tool.

Committed/live bridged tool_result moves renderer phase to neutral requesting if it matches pending tool id.

Stale active proxy flows reap after 30s silence.

Claude screen parser pitfalls:

- screen events can stall under synchronized output.
- use `snapshotPlain()` or timeout fallback when reliability matters.
- current-screen parsers use viewport.
- streaming extractors use recent lines because long replies can scroll assistant marker out of viewport.
- tool labels also use assistant marker.
- filter tool/spinner chrome before extracting assistant text.
- queued user prompts below assistant text must terminate extraction.
- continuation lines dedent by two spaces after marker strip.
- trailing whitespace stripped per line because Ink re-padding changes frame-to-frame.

## Appendix: Runtime Ingestion Full Agent Notes

Runtime render planes:

- `entries`.
- `semantic`.
- `ghosts`.
- `queuedMessages`.
- derived `sessionStatus`.

`sessionStatus` priority:

- exited.
- semantic current turn.
- process active.
- awaiting assistant.
- idle.

Submit creates visible work state before provider first event:

- streaming baseline.
- awaiting assistant true.
- stream phase submitting.
- timestamps.
- rewind undo cleared.

Semantic event ingestion:

- fold into runtime semantic.
- update outer stream phase for stream_phase/tool_result.
- mint ghosts from semantic current turn.
- clear optimistic awaiting on active/terminal/error signals.
- derive sessionStatus.

JSONL entries:

- only bulk path.
- old singular path intentionally gone.
- singular path raced bootstrap and caused per-entry render cascades.

Bulk JSONL handler:

- metadata capture pass.
- runtime mutation pass.

Metadata pass:

- Claude sessionId.
- Codex rollout metadata providerSessionId.
- stored once in SessionMeta for rehydrate/resume.

Runtime pass:

- map Codex rollout entries.
- stamp turn ids.
- process Claude queue-operation without rendering them.
- filter conversation/compact entries.
- dedupe by UUID.
- append to entries.
- update tool indices.
- update lastJsonlEntryAt.
- update totalEntries.

JSONL reconciles:

- optimistic Codex entries.
- queued Codex prompts.
- ghosts.

Ghosts:

- created from semantic current turns.
- persisted append-only.
- sweep marks stale unsuperseded ghosts orphaned after 30s.
- later GC removes superseded ghosts.

Process-state owns:

- processActive.
- activityStatus.
- inputReady.
- clears awaitingAssistant.
- may clear stale Codex queue rows.

Screen frames update:

- raw screen.
- markdown screen.
- recent screen.
- picker.

Screen frames do not own activityStatus.

Exit clears:

- queue.
- awaiting.
- activity.
- process/input state.
- stream phase.
- semantic current turn.

Rehydrate:

- renderer session id is routing key.
- providerSessionId is transcript identity.
- detached/buried sessions restore metadata but do not respawn.
- runtime commits may arrive before spawn resolves, so rehydrate merges with existing runtime.
- initial history seeds seen UUIDs, tool indices, ghosts, lastJsonlEntryAt.

Bootstrap complete closes replay-only false running states:

- stale awaitingAssistant.
- stale Codex queue rows.
- open semantic turns when no live process/stream signal exists.

Common ingestion ownership failures:

- committed entries versus optimistic entries.
- entries versus queued messages.
- semantic current/history versus entries.
- semantic current versus competing provider producers.
- ghosts versus live semantic.
- ghosts versus JSONL.
- sessionStatus versus input/process flags.
- rehydrate session id versus providerSessionId.

## Appendix: Provider-Specific Rendering LOC

This section answers the earlier question more directly:

- how many lines are provider rendering?
- where are Claude and Codex different?

There are three categories:

- provider headless.
- provider renderer/runtime glue.
- shared feed/semantic renderer.

Measured with `cloc --by-file` on 2026-05-22.

### Shared Feed And Semantic LOC

Shared feed/semantic direct surface:

- `src/renderer/src/features/feed`
- `src/renderer/src/workspace/semantic`
- `src/renderer/src/workspace/ghosts.ts`

High-impact files by code lines:

- `src/renderer/src/workspace/semantic/foldEvent.ts`: 737 code, 233 comment.
- `src/renderer/src/features/feed/ui/Feed.tsx`: 546 code, 361 comment.
- `src/renderer/src/features/feed/ui/semantic/BlockRow.tsx`: 370 code, 99 comment.
- `src/renderer/src/features/feed/model/renderModel.ts`: 369 code, 33 comment.
- `src/renderer/src/features/feed/lib/helpers.ts`: 239 code, 115 comment.
- `src/renderer/src/workspace/ghosts.ts`: 239 code, 289 comment.
- `src/renderer/src/workspace/semantic/helpers.ts`: 208 code, 115 comment.
- `src/renderer/src/features/feed/ui/semantic/renderUnits.ts`: 205 code, 127 comment.
- `src/renderer/src/features/feed/AppearanceMenu.tsx`: 200 code, 6 comment.
- `src/renderer/src/features/feed/ui/rows/Block.tsx`: 142 code, 54 comment.
- `src/renderer/src/features/feed/ui/rows/ToolResultRow.tsx`: 113 code, 52 comment.
- `src/renderer/src/features/feed/WorkIndicator.tsx`: 111 code, 73 comment.
- `src/renderer/src/features/feed/lib/streamingWriteInput.ts`: 93 code, 98 comment.
- `src/renderer/src/workspace/semantic/summarize.ts`: 75 code, 8 comment.
- `src/renderer/src/features/feed/ui/semantic/StreamingTurn.tsx`: 72 code, 71 comment.
- `src/renderer/src/features/feed/workIndicatorHints.ts`: 58 code, 41 comment.
- `src/renderer/src/features/feed/ui/markdown/MarkdownComponents.tsx`: 45 code, 71 comment.
- `src/renderer/src/features/feed/ui/rows/ToolUseRow.tsx`: 43 code, 36 comment.
- `src/renderer/src/features/feed/ui/markdown/Prose.tsx`: 34 code, 23 comment.

This is the core shared render engine.

It should be the first testing target.

### Claude Headless LOC

Claude headless direct rendering/normalization surface:

- `packages/claude-code-headless/src/ClaudeCodeHeadless.ts`: 728 code, 569 comment.
- `packages/claude-code-headless/src/proxy/ClaudeProxyAdapter.ts`: 1,113 code, 802 comment.
- `packages/claude-code-headless/src/proxy/proxyServer.ts`: 397 code, 173 comment.
- `packages/claude-code-headless/src/proxy/anthropicEvents.ts`: 280 code, 70 comment.
- `packages/claude-code-headless/src/proxy/mitmAddon.py`: 217 code, 246 comment.
- `packages/claude-code-headless/src/channels/SemanticChannel.ts`: 595 code, 181 comment.
- `packages/claude-code-headless/src/channels/types.ts`: 377 code, 438 comment.
- `packages/claude-code-headless/src/channels/CommittedChannel.ts`: 127 code, 69 comment.
- `packages/claude-code-headless/src/channels/ScreenChannel.ts`: 91 code, 24 comment.
- `packages/claude-code-headless/src/parsers/ScreenParser.ts`: 120 code, 258 comment.
- `packages/claude-code-headless/src/parsers/SlashPickerParser.ts`: 73 code, 84 comment.
- `packages/claude-code-headless/src/parsers/PermissionPromptParser.ts`: 71 code, 5 comment.
- `packages/claude-code-headless/src/parsers/ResumePromptParser.ts`: 59 code, 19 comment.
- `packages/claude-code-headless/src/parsers/CompactionParser.ts`: 40 code, 9 comment.
- `packages/claude-code-headless/src/parsers/TrustDialogParser.ts`: 38 code, 61 comment.
- `packages/claude-code-headless/src/parsers/LineDiff.ts`: 53 code, 62 comment.
- `packages/claude-code-headless/src/transcript/JsonlTailer.ts`: 211 code, 103 comment.
- `packages/claude-code-headless/src/transcript/SessionList.ts`: 182 code, 98 comment.
- `packages/claude-code-headless/src/transcript/TranscriptTypes.ts`: 87 code, 8 comment.
- `packages/claude-code-headless/src/transcript/ProjectDir.ts`: 26 code, 30 comment.
- `packages/claude-code-headless/src/terminal/HeadlessTerminal.ts`: 218 code, 193 comment.
- `packages/claude-code-headless/src/index.ts`: 185 code, 46 comment.

Claude headless total from this cloc slice is roughly:

- 5,428 code lines.
- 3,448 comment lines.

The largest Claude rendering risks live in:

- proxy sidecar attribution.
- proxy active-flow ownership.
- strict semantic channel lifecycle.
- committed tool_result mapping.
- screen prompt parsers.
- paste/submit detection.

### Codex Headless LOC

Codex headless direct rendering/normalization surface:

- `packages/codex-headless/src/CodexHeadless.ts`: 1,207 code, 573 comment.
- `packages/codex-headless/src/proxy/CodexResponsesAdapter.ts`: 913 code, 544 comment.
- `packages/codex-headless/src/proxy/responsesProxy.ts`: 458 code, 340 comment.
- `packages/codex-headless/src/channels/SemanticChannel.ts`: 567 code, 127 comment.
- `packages/codex-headless/src/channels/types.ts`: 356 code, 341 comment.
- `packages/codex-headless/src/channels/CommittedChannel.ts`: 97 code, 25 comment.
- `packages/codex-headless/src/channels/ScreenChannel.ts`: 73 code, 3 comment.
- `packages/codex-headless/src/parsers/ScreenParser.ts`: 168 code, 149 comment.
- `packages/codex-headless/src/parsers/ApprovalParser.ts`: 56 code, 28 comment.
- `packages/codex-headless/src/parsers/TrustDialogParser.ts`: 31 code, 37 comment.
- `packages/codex-headless/src/parsers/LineDiff.ts`: 53 code, 62 comment.
- `packages/codex-headless/src/transcript/TranscriptTypes.ts`: 252 code, 51 comment.
- `packages/codex-headless/src/transcript/FreshRolloutClaim.ts`: 179 code, 13 comment.
- `packages/codex-headless/src/transcript/JsonlTailer.ts`: 211 code, 86 comment.
- `packages/codex-headless/src/transcript/SessionList.ts`: 189 code, 116 comment.
- `packages/codex-headless/src/transcript/ProjectDir.ts`: 10 code, 30 comment.
- `packages/codex-headless/src/terminal/HeadlessTerminal.ts`: 218 code, 152 comment.
- `packages/codex-headless/src/conditions/types.ts`: 58 code, 0 comment.
- `packages/codex-headless/src/conditions/approval.ts`: 44 code, 0 comment.
- `packages/codex-headless/src/conditions/evaluateCodexConditions.ts`: 36 code, 0 comment.
- `packages/codex-headless/src/conditions/trustDialog.ts`: 18 code, 0 comment.
- `packages/codex-headless/src/conditions/index.ts`: 21 code, 0 comment.
- `packages/codex-headless/src/debugger/main.mjs`: 233 code, 33 comment.
- `packages/codex-headless/src/debugger/index.html`: 192 code.
- `packages/codex-headless/src/index.ts`: 150 code, 49 comment.

Codex headless total from this cloc slice is roughly:

- 5,502 code lines, excluding debugger HTML/JS.
- 2,726 comment lines, excluding debugger HTML/JS.

The largest Codex rendering risks live in:

- rollout tail ownership.
- proxy request id selection.
- sparse turn id cursor.
- screen fallback shadow path.
- response item to committed row mapping.
- per-tool committed suppression.
- conditions metadata merging.
- resume/fork lineage.

### Claude Renderer/Runtime LOC

Claude app-side provider surface:

- `src/providers/claude/runtime/claudeSession.ts`: 638 physical lines.
- `src/providers/claude/runtime/sessionList.ts`: 398 physical lines.
- `src/providers/claude/types/claudeTranscript.ts`: 111 physical lines.
- `src/providers/claude/renderer/rows/ClaudeRows.tsx`: 402 physical lines.
- `src/providers/claude/renderer/PermissionPromptModal.tsx`: 123 physical lines.
- `src/providers/claude/renderer/ResumePromptModal.tsx`: 122 physical lines.
- `src/providers/claude/renderer/TrustDialogModal.tsx`: 87 physical lines.
- `src/providers/claude/renderer/SlashCommandPicker.tsx`: 79 physical lines.
- `src/providers/claude/renderer/conditions/ClaudeConditionOutlet.tsx`: 57 physical lines.

Total Claude provider app-side physical lines:

- 2,017.

Not all of this is feed rendering, but it is all rendering-adjacent provider glue.

The highest-risk files:

- `claudeSession.ts`.
- `ClaudeRows.tsx`.
- `ClaudeConditionOutlet.tsx`.
- condition modals.

### Codex Renderer/Runtime LOC

Codex app-side provider surface:

- `src/providers/codex/runtime/codexSession.ts`: 497 physical lines.
- `src/providers/codex/runtime/sessionList.ts`: 191 physical lines.
- `src/providers/codex/runtime/projectDir.ts`: 39 physical lines.
- `src/providers/codex/runtime/codexReadyForPrompt.ts`: 27 physical lines.
- `src/providers/codex/types/codexTranscript.ts`: 43 physical lines.
- `src/providers/codex/renderer/rows/CodexRows.tsx`: 684 physical lines.
- `src/providers/codex/renderer/CodexApprovalModal.tsx`: 174 physical lines.
- `src/providers/codex/renderer/conditions/CodexTrustDialogModal.tsx`: 82 physical lines.
- `src/providers/codex/renderer/conditions/CodexConditionOutlet.tsx`: 35 physical lines.

Total Codex provider app-side physical lines:

- 1,772.

The highest-risk files:

- `codexSession.ts`.
- `CodexRows.tsx`.
- `CodexApprovalModal.tsx`.
- `codexReadyForPrompt.ts`.

### Provider LOC Takeaway

Claude and Codex are similar in headless size but not in shape.

Claude complexity is concentrated around:

- Anthropic proxy flow attribution.
- sidecar filtering.
- JSONL committed tool_result.
- screen submit/paste/prompt handling.

Codex complexity is concentrated around:

- rollout JSONL.
- proxy response item semantics.
- same-cwd session ownership.
- sparse turn ids.
- tool item granularity.
- conditions metadata.

The shared Feed rewrite must not flatten those differences.

The render pipeline can be provider-neutral only after provider-specific normalization has done its job.

Provider-specific tests are required.

Shared selector tests are required.

One without the other leaves the old failure modes intact.

## Appendix: Open Issues Snapshot 2026-05-22

Open issues at the time this report was written:

- #261 Keep Dispatch focus within project when closing the last pane.
- #259 Rebuild orchestration context inheritance on a stable provider contract.
- #253 Bug: orchestration follow-up prompt is not reliably inserted for inherited child agents.
- #249 Add settings for command picker visibility.
- #248 Tiled Dispatch.
- #247 Toggle Terminal Agent.
- #244 Host user-authored MCP servers as Agent Code extensions.
- #243 Investigate and harden speech-to-text failure handling and diagnostics.
- #242 Add Root Access MCP for explicit local/global agent management.
- #241 Codex QueueStrip can keep processed follow-up prompts stuck after idle.
- #240 Add MCP-managed dictation context for Deepgram keyterms.
- #236 Dispatch agent list steals Enter/focus from active composer drafts.
- #234 chore(upstream): Codex 0.133.0 is newer than accepted 0.130.0.
- #233 chore(upstream): Claude Code 2.1.148 is newer than accepted 2.1.143.
- #218 Improve command search with lightweight recent-command history.
- #210 Add opt-in anonymous product analytics provider.
- #193 Fix Codex resume fork detection rejecting same-cwd rollout with prompt lineage but no shared item ids.
- #185 Improve queued message rendering for long prompts and multi-line content.
- #183 Add comprehensive rendering regression tests for feed ownership and streaming behavior.
- #179 Handle background processes and terminals for both Claude and Codex.
- #178 Handle sub-agent rendering for both Claude and Codex.
- #174 Implement prompt suggestions for Claude/Codex - currently leak into the feed as raw items.
- #172 Fix feed render ownership across committed transcript, semantic live/history, ghosts, and optimistic input.
- #153 Fix root-pane close dropping project Dispatch listing and incomplete undo restore.
- #151 Fix prompt/conversation search missing known agent content.
- #150 Fix runaway loop/crash when opening worktree panel.
- #149 Make worktree colors stable across restarts and improve worktree panel.
- #148 Wire macOS File menu actions for Agent Code.
- #118 Codex pane can report started while no backend output/lifecycle events arrive.
- #117 Add app-wide Vim mode.
- #115 Sanitize logs before writing debug/proxy output.
- #103 General optimization sweep - reduce memory use and improve app-wide performance.
- #102 Consolidate debug infrastructure into one home, remove ad-hoc console.* scatter, enforce a typed logger boundary.
- #100 Improve documentation: write evergreen design docs in docs/design/ for complex subsystems.
- #99 Extend conditions system to consume semantic events alongside screen parsing.
- #98 Claude/Codex interactive question tool calls render as raw JSON.
- #97 New pin-tab feature is broken and counter-intuitive.
- #96 Resume + session search are inconsistent.
- #90 Claude prompt submit still inconsistent - detection logic falls behind under load.

Rendering-related open issues from that list:

- #90.
- #98.
- #99.
- #100.
- #115.
- #118.
- #151.
- #172.
- #174.
- #178.
- #179.
- #183.
- #185.
- #193.
- #241.
- #253.
- #259.

The rewrite should not claim completion until at least #172 and #183 have concrete test coverage.

## Appendix: Recent PR Timeline Snapshot

Merged PRs near the rendering rewrite window:

- #263, 2026-05-22: Establish Vitest testing stack and remove script tests.
- #262, 2026-05-21: Clean up feed render model compatibility fields.
- #260, 2026-05-21: Disable orchestration context inheritance.
- #258, 2026-05-21: fix(workspace): hibernate detached sessions on rehydrate.
- #257, 2026-05-21: fix(orchestration): skip structured user entries in handoff scan.
- #256, 2026-05-21: Unify feed render item ordering.
- #255, 2026-05-20: fix(claude): recover proxy stream after API errors.
- #254, 2026-05-20: fix(orchestration): repair inherited prompt delivery and output.
- #252, 2026-05-20: Fix Codex prompt queue rendering ownership.
- #246, 2026-05-19: Inherit parent context for orchestration agents.
- #238, 2026-05-19: Separate manual debug bundles from autosaves.
- #229, 2026-05-18: Fix Codex orchestration initial prompt delivery.
- #225, 2026-05-18: Add debug bundle notes and index.
- #222, 2026-05-18: Coalesce Monaco semantic provider registration.
- #219, 2026-05-18: perf(mcp): cache built-in MCP session servers.
- #216, 2026-05-18: Performance optimization sweep.
- #215, 2026-05-18: Fix feed debug append backpressure.
- #208, 2026-05-18: Dedupe Codex transcript MCP messages.
- #207, 2026-05-18: Add agent transcript MCP tools.
- #203, 2026-05-17: Enhance orchestration MCP coordination tools.
- #202, 2026-05-18: Add terminal sessions to Dispatch Mode.
- #201, 2026-05-18: Harden rendered link activation.
- #197, 2026-05-17: fix(codex): prove fresh rollout ownership.
- #194, 2026-05-18: fix(feed): suppress committed semantic web search.
- #186, 2026-05-17: fix(feed): tighten semantic render ownership.
- #184, 2026-05-17: feat(feed): ship semantic-first rendering stack.
- #177, 2026-05-17: chore(feed): clean up obsolete rendering wrappers.
- #176, 2026-05-16: feat(feed): stream codex tool rendering.
- #175, 2026-05-16: feat(feed): establish Codex rendering foundation.
- #170, 2026-05-16: fix(feed): suppress committed semantic assistant duplicates.
- #169, 2026-05-16: chore(codex): bump codex-headless - drop false rollout-error on tail switch.
- #167, 2026-05-16: fix(feed): restore Codex live streaming on resume + de-dupe semantic history.
- #165, 2026-05-16: fix(feed): keep semantic history visible while JSONL catches up.
- #160, 2026-05-16: fix(codex): correct rollout tail ownership - feed clearing during MCP turns.
- #142, 2026-05-16: feat(session-preview): live conversation preview in resume + prompt-search pickers.
- #141, 2026-05-16: chore(upstream): add Claude Code / Codex drift-watch automation.
- #134, 2026-05-16: feat(feed): live preview for streaming Write tool calls.
- #128, 2026-05-14: fix(composer): bounded height + intra-textarea arrow nav.
- #127, 2026-05-14: fix(scroll-indicator): show full transcript length, live-updated.
- #126, 2026-05-14: fix(markdown): force equal-width columns + wrap long tables.
- #123, 2026-05-14: docs: archive 2026-05-13 plan docs.
- #122, 2026-05-14: fix(workspace): make packaged-app launch resilient to proxy failures.

Pattern:

- May 16 concentrated on semantic/feed ownership.
- May 17 concentrated on tightening and debug/ownership follow-up.
- May 18 concentrated on debug, rendered links, MCP transcript surfaces, and performance.
- May 20 concentrated on prompt queue and proxy recovery.
- May 21 concentrated on unified ordering cleanup and orchestration context issues.
- May 22 established testing ground zero.

This timeline explains why the next rendering step must be tests-first.

The code changed too quickly under production pressure.

Every PR fixed one real bug and created new implicit knowledge.

The rewrite must turn that implicit knowledge into executable invariants.

## Appendix: Fixture Design For Saved Bundles

Saved debug bundles are too large to use directly as unit fixtures.

But they are invaluable as source material.

Fixture extraction policy:

- preserve provider.
- preserve source plane.
- preserve turn id shapes.
- preserve timestamps relative ordering.
- preserve tool ids.
- preserve committed row ids when structurally needed.
- preserve message id absence when that was the bug.
- preserve text length class.
- redact user prompt content unless text itself is the bug.
- replace long assistant prose with synthetic same-normalization text.
- include original bundle id in test comment.

Fixture shape for buried prompt:

- committed entry before submit.
- semantic history ended before prompt.
- optimistic or committed user prompt timestamp after semantic history.
- work item active.
- expected order: semantic history, user prompt, work.

Fixture shape for stale web search:

- committed web_search tool_use.
- committed assistant answer text.
- semantic history turn with matching live web_search block.
- expected: semantic history suppressed.

Fixture shape for Codex id split duplicate:

- semantic proxy id `resp_*`.
- committed rollout id or task id different from proxy id.
- same text exact or normalized.
- expected: semantic text suppressed.

Fixture shape for Codex broad tool id hazard:

- semantic turn has tool use and live output.
- committed tool_use exists.
- committed tool_result absent.
- expected: live output remains visible.

Fixture shape for ghost sidecar:

- ghost assistant role.
- one text block.
- length <= 200.
- updated after last JSONL.
- orphaned.
- expected: hidden.

Fixture shape for real ghost fallback:

- ghost assistant role.
- substantive text > 200 or tool_use.
- updated after last JSONL.
- orphaned.
- not semantic-owned.
- expected: visible.

Fixture shape for cross-session Codex:

- two sessions same cwd.
- rollout file from session A.
- empty session B.
- no prompt lineage proof for B.
- expected: B renders nothing and logs rejected candidate.

Fixture shape for Claude condition regression:

- Claude screen parser sees permission prompt.
- headless emits legacy `permission-prompt`.
- no unified conditions snapshot.
- expected current behavior: outlet renders nothing.
- expected fixed behavior: unified condition snapshot renders permission modal.

Fixture shape for interactive question tool:

- semantic tool_use with `{ question, options }`.
- current generic row body would be blank.
- expected future behavior: typed question condition or row.
- expected current unknown logger: unknown interactive tool shape.

## Appendix: Ownership Ledger Proposed Type Detail

The ownership ledger should be serializable.

It should be safe to put in debug bundles after redaction.

Draft shape:

```ts
type RenderOwner =
  | 'committed-entry'
  | 'semantic-current'
  | 'semantic-history'
  | 'ghost'
  | 'optimistic-prompt'
  | 'queued-prompt'
  | 'work'
  | 'empty'
  | 'condition'

type RenderSourcePlane =
  | 'committed'
  | 'semantic'
  | 'screen'
  | 'proxy'
  | 'rollout'
  | 'ghost'
  | 'local-submit'
  | 'queue'
  | 'process'

type RenderCandidate = {
  id: string
  owner: RenderOwner
  provider: 'claude' | 'codex' | 'opencode' | 'unknown'
  sourcePlane: RenderSourcePlane
  sessionId: string
  providerSessionId?: string
  turnId?: string
  blockIndex?: number
  blockId?: string
  messageId?: string
  codexTurnId?: string
  toolUseId?: string
  callId?: string
  timestampMs?: number
  sequence: number
  textKey?: string
  normalizedTextKey?: string
  contentKind:
    | 'user-text'
    | 'assistant-text'
    | 'tool-use'
    | 'tool-result'
    | 'thinking'
    | 'reasoning'
    | 'image'
    | 'compact-boundary'
    | 'compact-summary'
    | 'work'
    | 'empty'
    | 'condition'
    | 'unknown'
  selected: boolean
  rejectionReason?: RenderRejectionReason
  suppressionOwnerId?: string
  unknownRefs?: string[]
}
```

Draft rejection reasons:

- `meta-entry`.
- `not-conversation`.
- `committed-text-owned`.
- `committed-tool-use-owned`.
- `committed-tool-result-owned`.
- `semantic-current-owns-turn`.
- `semantic-history-owns-turn`.
- `ghost-not-orphaned`.
- `ghost-superseded`.
- `ghost-older-than-jsonl`.
- `ghost-sidecar-shape`.
- `empty-semantic-block`.
- `empty-write-stdin`.
- `empty-thinking`.
- `duplicate-current-turn-in-history`.
- `unclaimed-rollout`.
- `wrong-session-lineage`.
- `unsafe-rendered-content`.
- `unknown-provider-shape-hidden`.
- `condition-not-produced`.

The ledger should answer:

- why row exists.
- why row is hidden.
- what row owns a duplicate.
- why a candidate is unsafe.
- whether provider normalization failed.

The ledger should not contain:

- full prompt text.
- full tool output.
- full local absolute paths unless debug mode explicitly allows.
- raw auth headers.
- raw proxy payloads.

For text matching:

- store hashes.
- store lengths.
- store short redacted preview only when allowed.

## Appendix: Rendering Rewrite Work Breakdown

Workstream 1: Test salvage.

- restore render model tests.
- restore ghost tests.
- restore semantic reducer tests.
- restore queue tests.
- restore provider channel tests.
- restore safe link tests.

Workstream 2: Ownership ledger.

- design types.
- populate from current selector.
- serialize to feed-debug.
- include in debug bundles.
- assert ledger rows in tests.

Workstream 3: Candidate collection.

- committed candidate collector.
- semantic candidate collector.
- ghost candidate collector.
- prompt candidate collector.
- work candidate collector.
- condition candidate collector or sibling model.

Workstream 4: Suppression.

- committed text suppression.
- committed tool-use suppression.
- committed tool-result suppression.
- Claude whole-turn suppression.
- Codex unit suppression.
- ghost five-rule predicate.
- sidecar predicate.

Workstream 5: Ordering.

- stable timestamp parse.
- sequence fallback.
- source ranks.
- stale semantic history before newer prompt.
- current semantic after prompt.
- work after current active content.
- empty before work when no content exists.

Workstream 6: Provider normalization.

- Codex rollout semantic soft-open decision.
- Codex proxy flow diagnostics.
- Codex response item mapping.
- Codex resume/fork claim diagnostics.
- Claude proxy error release tests.
- Claude unified conditions restored.
- Claude sidecar detectors.
- Claude paste submit diagnostics.

Workstream 7: Unknown behavior logging.

- provider unknowns.
- screen unknowns.
- proxy unknowns.
- rollout unknowns.
- tool unknowns.
- unsafe rendered content.
- unowned candidate.

Workstream 8: UI rows.

- generic tool-use unknown UI.
- interactive question tool UI.
- background process surface.
- sub-agent surface.
- provider condition action consumption.

Workstream 9: Bundle fixtures.

- minimized JSON fixtures.
- redaction helpers.
- fixture metadata.
- issue/PR links.
- reproduction comments.

Workstream 10: Deletion and cleanup.

- remove stale compatibility fields.
- remove duplicate suppression in rows once selector owns it.
- remove dead legacy condition paths after unified path works.
- update current docs.

## Appendix: Stop Conditions For The Rewrite

Do not merge a rendering rewrite PR unless:

- old script invariants exist as Vitest tests.
- tests fail before the relevant production fix when possible.
- debug ledger is emitted from the same data Feed paints.
- no row renderer makes cross-plane ownership decisions.
- provider-specific differences are explicit in tests.
- unknown provider behavior logs a structured event.
- safe rendered content tests pass.
- no new root scripts are added.
- no live provider is required for CI coverage.

Do not call #172 complete unless:

- committed transcript ownership is tested.
- semantic current ownership is tested.
- semantic history ownership is tested.
- ghost ownership is tested.
- optimistic input ownership is tested.
- queue ownership is tested.
- work ownership is tested.
- empty ownership is tested.
- debug ownership is tested.

Do not call #183 complete unless:

- feed model tests exist.
- semantic reducer tests exist.
- ghost tests exist.
- queue tests exist.
- provider channel tests exist.
- rendered content tests exist.
- fixture-based bundle regression tests exist.

Do not call #98 complete unless:

- interactive question tool calls render structured UI.
- options are selectable.
- answer path is provider-safe.
- cancelled/denied path is tested.
- raw JSON fallback logs unknown behavior.

Do not call #99 complete unless:

- Codex conditions still work.
- Claude unified conditions work.
- screen and semantic condition evidence can coexist.
- renderer consumes `actions[]` or type removes them.
- slash picker ownership is documented.

Do not call #115 complete unless:

- unknown behavior logs are redacted.
- proxy logs in bundles are bounded.
- feed-debug logs are bounded.
- full raw payloads require explicit debug mode.

Do not call #193 complete unless:

- same-cwd prompt lineage tests exist.
- same-cwd mismatch tests exist.
- fork switch tests exist.
- ambiguous lineage fails closed.

Do not call #241 complete unless:

- queued prompt reconciliation tests exist.
- idle stale queue clear tests exist.
- similar prompt false-positive test exists.
- bootstrap complete cleanup test exists.

## Appendix: Practical First PR File List

Files likely touched in first TDD salvage PR:

- `src/renderer/src/features/feed/model/renderModel.test.ts`.
- `src/renderer/src/features/feed/ui/semantic/renderUnits.test.ts`.
- `src/renderer/src/workspace/semantic/foldEvent.test.ts`.
- `src/renderer/src/workspace/ghosts.test.ts`.
- `src/renderer/src/workspace/mergedEntries.test.ts`.
- `src/renderer/src/workspace/hook/actions/streaming.test.ts`.
- `src/renderer/src/workspace/queueInvariants.test.ts`.
- `src/shared/renderedContent/targets.test.ts`.
- `src/providers/codex/runtime/codexReadyForPrompt.test.ts`.
- `packages/codex-headless/src/channels/SemanticChannel.test.ts`.
- `packages/claude-code-headless/src/proxy/ClaudeProxyAdapter.test.ts`.
- `testing/support/builders/rendering.ts`.
- `testing/support/builders/semantic.ts`.
- `testing/support/builders/ghosts.ts`.
- `testing/support/builders/claudeProxySse.ts`.
- `testing/fixtures/codex/readyScreens.ts`.

Files probably not touched in first PR:

- production Feed JSX.
- production provider adapters.
- production semantic reducer.
- production debug bundle writer.

Reason:

- first PR should preserve current behavior and make it executable.
- production fixes after that should be smaller and test-driven.
