# Rendering-Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate six confirmed rendering defects in the feed — bootstrap ghost flash, live-turn null-flip, duplicate Codex rendering, tool_result event flood at resume, and render-path reference churn that busts every memo in Feed.

**Architecture:** The defects cluster around two seams that were introduced in the 2026-04-18 headless redesign: (1) the ghost bridge between live semantic state and the JSONL transcript, and (2) the gating between `SemanticStreamingTurn` and the ghost-merged feed. This plan fixes both seams surgically without removing the legacy live-view path (that deletion is Phase 3 of the original headless redesign). We make the ghost map reference-stable, narrow `mergeWithUpstream`'s use so superseded ghosts cannot resurface on resume, run ghost reconciliation at the correct moment during bootstrap, short-circuit `foldSemanticEvent` on no-op events, gate the committed `tool_result` bridge so historical results do not fire during the JSONL tail replay, and plumb the Codex response id end-to-end so Codex assistant-text ghosts can actually supersede.

**Tech Stack:** TypeScript, React 18, Zustand, Electron. cc-shell's `src/renderer/src/tiles/ghosts.ts`, `mergedEntries.ts`, `workspaceStore.ts`, `TileLeaf.tsx`, `Feed.tsx`; the Claude-side provider bridge `src/providers/claude/runtime/claudeSession.ts`; the `agent-transcript-parser` submodule (`src/ghost.ts`).

---

## Evidence baseline (session `e9a25ede-26ef-…`)

Before touching code, re-read the feed-debug log so the fix targets are concrete:

- `~/.config/cc-shell/feed-debug/e9a25ede-26ef-4338-8f87-f273bf8e13ff.jsonl` (306 entries, two real turns with Bash tool calls)
- `~/Library/Application Support/cc-shell/ghost-logs/e9a25ede-26ef-4338-8f87-f273bf8e13ff.ghost.jsonl` (71 entries)

Key signals to anchor the fixes against:
- `id:1-8` — eight `tool_result src=jsonl` events **before** `session_started` (id:9). These are historical tool_results replayed by the JSONL tailer and bridged onto the semantic bus at startup.
- `id:11 tMs=77` — first logged render is `rows 37 → 16 (+16 −37)`. 37 ghost rows existed before the JSONL tail arrived. All 37 were "already superseded" on disk; `mergeWithUpstream` promoted them back to trailing because the target uuids were not in the loaded tail.
- `id:129`→`id:131` — `semanticTurnId` flips from `msg_01RXGB…` to `null` mid-turn while `streamPhase` is still `responding`. Matches `shouldShowSemanticStreaming` short-circuiting on the first un-superseded ghost for the current turn.
- `id:93-102`, `id:127-129`, `id:143-146` — every phase transition produces two back-to-back RENDER logs because `selectMergedEntries` and `ghostsFromSemanticTurn` both allocate fresh references on every semantic tick.

---

## File Structure

**Files modified (cc-shell):**

- `src/renderer/src/tiles/ghosts.ts` — reference-stable `ghostsFromSemanticTurn` and `reconcileUpstream`; extend `reconcileUpstream` with Codex response-id matching.
- `src/renderer/src/tiles/mergedEntries.ts` — `selectMergedEntries` returns `runtime.entries` when no ghost survives the merge; `shouldShowSemanticStreaming` decoupled from current-turn ghost presence.
- `src/renderer/src/tiles/workspaceStore.ts` — `spawnSession` awaits ghost bootstrap before the first JSONL burst can land (or re-reconciles once bootstrap finishes); `foldSemanticEvent` short-circuits no-op events; Codex mapper stamps `codexTurnId` on emitted entries; ghost-bootstrap reconciliation pass.
- `src/providers/claude/runtime/claudeSession.ts` — committed `tool_result` bridge gated by a `readyForLiveBridge` flag that flips after JSONL tail replay quiesces.
- `src/renderer/src/tiles/workspaceState.ts` — optional `codexTurnId?: string` field on the cc-shell `Entry` shape (via extension to the Codex-specific entry factories, not touching shared transcript types).

**Files modified (agent-transcript-parser submodule):**

- `src/ghost.ts` — add `trustSupersededFlag?: boolean` to `MergeOptions`, default `false`; when `true`, a ghost with `supersededBy` set is dropped regardless of whether its target is in the current upstream list. Plus a corresponding flag on `reduceGhostLog` (or a new `filterSuperseded` helper) so bootstrap reads can drop superseded ghosts up front.

**Files added:** none. All fixes live in files that already exist.

---

## Pre-flight

- [ ] **Step 0: Create a worktree for this plan**

```bash
git worktree add ../cc-shell-rendering-fixes -b fix/rendering-2026-04-20
cd ../cc-shell-rendering-fixes
npm install
```

Expected: clean worktree, npm succeeds (postinstall runs electron-rebuild — expected).

- [ ] **Step 0b: Verify build is green before changing anything**

```bash
npm run build && (cd claude-code-headless && npm run build) && (cd codex-headless && npm run build)
```

Expected: all three build. The codex-headless build currently reports four TS errors in `ClaudeProxyAdapter.ts` (`block.citations`, `block.signature`) that pre-date this plan. **Before starting Task 1**, either fix those four errors in a scratch commit or document them so downstream tasks can distinguish new failures from baseline noise.

---

## Task 1: Reference-stable `ghostsFromSemanticTurn`

Every semantic event currently allocates a new `Map` and returns it, which makes `nextGhosts !== current.ghosts` always true in `workspaceStore.ts:2553`. That forces `setRuntimes` and busts `selectMergedEntries`' reference check one level up. Fix by tracking mutation and returning `prev` (cast to mutable `Map`) when no writes happened.

**Files:**
- Modify: `src/renderer/src/tiles/ghosts.ts:230-276`

- [ ] **Step 1: Replace `ghostsFromSemanticTurn` with a mutation-tracking variant.**

```ts
export function ghostsFromSemanticTurn(
  turn: SemanticLiveTurn | null,
  sessionId: string,
  prev: ReadonlyMap<string, GhostEntry>,
): Map<string, GhostEntry> {
  if (!turn) return prev as Map<string, GhostEntry>

  let next: Map<string, GhostEntry> | null = null

  for (const block of Object.values(turn.blocks)) {
    const content = blocksFromSemantic(block)
    if (content.length === 0) continue

    const uuid = ghostUuid(turn.turnId, block.blockIndex)
    const existing = prev.get(uuid)
    if (existing?._atp.supersededBy !== undefined) continue

    if (!existing) {
      if (next === null) next = new Map(prev)
      next.set(
        uuid,
        createGhost({
          sessionId,
          turnId: turn.turnId,
          blockIndex: block.blockIndex,
          role: 'assistant',
          content,
          context: ghostContextForBlock(block, turn),
        }),
      )
      continue
    }

    if (sameClaudeContent(existing.message?.content, content)) continue

    if (next === null) next = new Map(prev)
    next.set(uuid, updateGhost(existing, content))
  }

  return next ?? (prev as Map<string, GhostEntry>)
}
```

- [ ] **Step 2: Do the same for `reconcileUpstream` so ingest no-ops preserve the ghost map reference.**

Replace the body of `reconcileUpstream` in the same file (lines 337-393):

```ts
export function reconcileUpstream(
  entry: Entry,
  prev: ReadonlyMap<string, GhostEntry>,
): Map<string, GhostEntry> {
  if (!isConversationEntry(entry)) return prev as Map<string, GhostEntry>
  if (prev.size === 0) return prev as Map<string, GhostEntry>

  const realUuid = entry.uuid ?? null
  if (!realUuid) return prev as Map<string, GhostEntry>

  const message = entry.message
  const messageId =
    typeof (message as { id?: string }).id === 'string'
      ? (message as { id: string }).id
      : null
  const codexTurnId =
    typeof (entry as { codexTurnId?: string }).codexTurnId === 'string'
      ? (entry as { codexTurnId: string }).codexTurnId
      : null

  const toolUseIdsInEntry = new Set<string>()
  if (Array.isArray(message.content)) {
    for (const block of message.content) {
      const rec = block as Record<string, unknown>
      if (rec?.type === 'tool_use' && typeof rec.id === 'string') {
        toolUseIdsInEntry.add(rec.id)
      }
    }
  }

  let next: Map<string, GhostEntry> | null = null
  for (const [uuid, ghost] of prev) {
    if (ghost._atp.supersededBy !== undefined) continue

    let match = false
    if (messageId && ghost._atp.turnId === messageId) match = true
    if (!match && codexTurnId && ghost._atp.turnId === codexTurnId) match = true
    if (!match) {
      const ctxToolId = ghost._atp.context?.toolUseId
      const ctxCallId = ghost._atp.context?.callId
      if (
        (typeof ctxToolId === 'string' && toolUseIdsInEntry.has(ctxToolId)) ||
        (typeof ctxCallId === 'string' && toolUseIdsInEntry.has(ctxCallId))
      ) {
        match = true
      }
    }
    if (!match) continue

    if (next === null) next = new Map(prev)
    next.set(uuid, supersedeGhost(ghost, realUuid))
  }

  return next ?? (prev as Map<string, GhostEntry>)
}
```

Note the added `codexTurnId` branch — that field gets wired up in Task 6. For now, Codex reconciliation degrades to the toolUseId fallback exactly as it did before (no regression).

- [ ] **Step 3: Verify types compile in isolation.**

```bash
npx tsc -p tsconfig.json --noEmit
```

Expected: no new errors introduced by this task. Pre-existing codex-headless submodule errors are separate (see Pre-flight).

- [ ] **Step 4: Launch `npm run dev`, open a Claude session, confirm render log no longer emits `+1 −1` on every semantic tick.**

Open the Feed Debug Panel (`toggle-feed-debug-panel` in command palette). Send a prompt. Expected: RENDER log entries appear only on real visible-row changes (turn start, block transitions, JSONL landings), not on every `tool_input_delta`.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/tiles/ghosts.ts
git commit -m "fix(ghosts): make ghostsFromSemanticTurn and reconcileUpstream reference-stable on no-op"
```

---

## Task 2: Reference-stable `selectMergedEntries`

`selectMergedEntries` currently always calls `mergeWithUpstream` when `ghosts.size > 0`, even when every ghost is already superseded or the merge would be identical to `runtime.entries`. After Task 1 the ghost Map is stable on no-op, but the merge output is still a fresh array because `mergeWithUpstream` does `[...upstream, ...trailing]` unconditionally. Fix by checking whether `trailing` is empty and returning `runtime.entries` directly.

**Files:**
- Modify: `src/renderer/src/tiles/mergedEntries.ts:35-38`

- [ ] **Step 1: Replace `selectMergedEntries` so reference equality holds whenever no ghost actually appears in the merged result.**

```ts
export function selectMergedEntries(runtime: SessionRuntime): Entry[] {
  const { ghosts, entries } = runtime
  if (ghosts.size === 0) return entries
  // Fast path: if every ghost in the map is either superseded by an
  // entry we currently hold, or superseded against a uuid at all
  // (see Task 3 on atp), the merge output is identical to `entries`
  // and we can return the same reference.
  let anyVisibleGhost = false
  for (const ghost of ghosts.values()) {
    if (ghost._atp.supersededBy !== undefined) continue
    anyVisibleGhost = true
    break
  }
  if (!anyVisibleGhost) return entries
  return mergeWithUpstream(entries, ghosts) as Entry[]
}
```

- [ ] **Step 2: Run the Feed rendering test flow from Task 1 Step 4 and re-check the debug log.**

Expected: `RENDER` events now fire only on real entry changes. Between two semantic events for the same block (e.g. consecutive `tool_input_delta`) the `entries` reference should stay stable, so Feed's `useMemo([entries])` short-circuits.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/tiles/mergedEntries.ts
git commit -m "perf(feed): short-circuit selectMergedEntries when no ghost is visible"
```

---

## Task 3: Trust the `supersededBy` flag in `mergeWithUpstream`

`mergeWithUpstream` currently requires the supersede target uuid to be in the loaded `upstream` list before it drops the ghost. cc-shell's JSONL tail only carries the recent tail, so ghosts superseded in prior sessions always resurface as trailing — the 37-row bootstrap flash. Add an opt-in `trustSupersededFlag` option that drops a ghost whenever `supersededBy !== undefined`, regardless of whether the target is visible.

**Files:**
- Modify: `agent-transcript-parser/src/ghost.ts:267-285, 329-375`

- [ ] **Step 1: Extend `MergeOptions` and the merge loop.**

In `agent-transcript-parser/src/ghost.ts`, extend the `MergeOptions` type (around line 280) and the merge logic (around line 355):

```ts
export type MergeOptions = {
  keepSupersededGhosts?: boolean
  dropOrphanedGhosts?: boolean
  /** When true, a ghost with `supersededBy` set is treated as
   *  superseded regardless of whether its target uuid appears in
   *  `upstream`. Useful for consumers like cc-shell that only hold a
   *  recent tail of the upstream transcript and cannot prove the
   *  target uuid exists in-memory. Mutually exclusive with
   *  `keepSupersededGhosts`. */
  trustSupersededFlag?: boolean
}
```

Replace the `isSuperseded` check inside the `for (const ghost of ghosts.values())` loop with:

```ts
const supersededBy = sidecar.supersededBy
const hasSupersededFlag = typeof supersededBy === 'string'
const isSuperseded = hasSupersededFlag && (
  opts.trustSupersededFlag === true || upstreamUuids.has(supersededBy)
)
```

- [ ] **Step 2: Add a sibling helper `reduceGhostLogSansSuperseded`.**

Append to the same file:

```ts
/**
 * Fold a ghost log and drop any ghost whose final state is
 * `supersededBy`. Suitable for consumers that only want the
 * provisional-and-still-live set and never want to see forensic
 * "we rendered X" rows — e.g. cc-shell when bootstrapping a resumed
 * session from disk. Orphaned ghosts are kept.
 */
export function reduceGhostLogSansSuperseded(
  entries: readonly ClaudeEntry[],
): Map<string, GhostEntry> {
  const full = reduceGhostLog(entries)
  for (const [uuid, ghost] of full) {
    if (ghost._atp.supersededBy !== undefined) full.delete(uuid)
  }
  return full
}
```

- [ ] **Step 3: Export both new symbols from `src/index.ts`.**

Confirm `agent-transcript-parser/src/index.ts` re-exports the new helper. If it only re-exports the `./ghost` subpath (check with `grep -n ghost src/index.ts`), the existing `export * from './ghost.js'` picks up `reduceGhostLogSansSuperseded` automatically. No manual changes needed — just run `npm run build` to confirm.

- [ ] **Step 4: Build atp and run its verify harness.**

```bash
cd agent-transcript-parser
npm run build
npm test
cd ..
```

Expected: build clean, `testing/verify.ts` ghost cases still pass. If `testing/verify.ts` does not already exercise `trustSupersededFlag`, add a test case that builds a ghost with `supersededBy: "abc"` and confirms `mergeWithUpstream(emptyUpstream, ghosts, { trustSupersededFlag: true })` returns `[]`.

- [ ] **Step 5: Commit inside the submodule and record the new SHA.**

```bash
cd agent-transcript-parser
git add src/ghost.ts testing/verify.ts
git commit -m "feat(ghost): add trustSupersededFlag merge option and reduceGhostLogSansSuperseded"
cd ..
git add agent-transcript-parser
git commit -m "chore: bump agent-transcript-parser for trustSupersededFlag"
```

---

## Task 4: cc-shell adopts `trustSupersededFlag` and the filtered log reader

With atp's new options in place, switch the cc-shell renderer to the filtered reader for disk-backed bootstrap, and pass `trustSupersededFlag: true` at merge time.

**Files:**
- Modify: `src/renderer/src/tiles/mergedEntries.ts`
- Modify: `src/renderer/src/tiles/workspaceStore.ts:2727-2767`

- [ ] **Step 1: Pass the new flag through the merge call.**

Update `selectMergedEntries` (on top of Task 2):

```ts
import { mergeWithUpstream } from 'agent-transcript-parser/ghost'
// ...
  return mergeWithUpstream(entries, ghosts, { trustSupersededFlag: true }) as Entry[]
```

- [ ] **Step 2: Use the filtered reducer at bootstrap.**

In `workspaceStore.ts`, replace the import:

```ts
import { reduceGhostLogSansSuperseded as reduceGhostLog } from 'agent-transcript-parser/ghost'
```

(Alias kept local to minimise churn in the spawnSession bootstrap block.)

- [ ] **Step 3: Rebuild, reload the session whose log is at `~/.config/cc-shell/feed-debug/e9a25ede-26ef-4338-8f87-f273bf8e13ff.jsonl`, verify no ghost-flash.**

Expected: the first RENDER entry in a fresh run is `initial rows N` where N matches the visible committed tail. No `rows 37 → 16` transition.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/tiles/mergedEntries.ts src/renderer/src/tiles/workspaceStore.ts
git commit -m "fix(ghosts): drop superseded ghosts at disk-load time; pass trustSupersededFlag to merge"
```

---

## Task 5: Decouple `shouldShowSemanticStreaming` from current-turn ghosts

`shouldShowSemanticStreaming` hides the entire live view the moment any un-superseded ghost exists for the current turn, which happens mid-turn on every block transition and produces the null-flip at `id:131` in the evidence log. The correct rule is simpler: **current turn → live view; previous turns' orphaned blocks → ghost merge path**. Exclude current-turn ghosts from `selectMergedEntries`, and always render `SemanticStreamingTurn` when a current turn exists.

**Files:**
- Modify: `src/renderer/src/tiles/mergedEntries.ts`
- Modify: `src/renderer/src/tiles/TileLeaf.tsx:950-968`

- [ ] **Step 1: Update `selectMergedEntries` to take the current-turn id and filter ghosts belonging to it.**

```ts
export function selectMergedEntries(
  runtime: SessionRuntime,
  currentTurnId: string | null,
): Entry[] {
  const { ghosts, entries } = runtime
  if (ghosts.size === 0) return entries
  let anyVisibleGhost = false
  let needsFilter = false
  for (const ghost of ghosts.values()) {
    if (ghost._atp.supersededBy !== undefined) continue
    if (currentTurnId && ghost._atp.turnId === currentTurnId) {
      needsFilter = true
      continue
    }
    anyVisibleGhost = true
  }
  if (!anyVisibleGhost) return entries
  if (!needsFilter) {
    return mergeWithUpstream(entries, ghosts, { trustSupersededFlag: true }) as Entry[]
  }
  const filtered = new Map<string, GhostEntry>()
  for (const [uuid, ghost] of ghosts) {
    if (currentTurnId && ghost._atp.turnId === currentTurnId) continue
    filtered.set(uuid, ghost)
  }
  return mergeWithUpstream(entries, filtered, { trustSupersededFlag: true }) as Entry[]
}
```

- [ ] **Step 2: Replace `shouldShowSemanticStreaming` with a pure "is there a current turn?" helper, retained only so the call site stays explicit. Feel free to inline and delete.**

```ts
export function shouldShowSemanticStreaming(runtime: SessionRuntime): boolean {
  return runtime.semantic.currentTurn !== null
}
```

- [ ] **Step 3: Update `TileLeaf.tsx` to thread the current turn id into the selector.**

```tsx
const currentSemanticTurnId = runtime.semantic.currentTurn?.turnId ?? null
// ...
<Feed
  // ...
  entries={selectMergedEntries(runtime, currentSemanticTurnId)}
  // ...
  semanticTurn={shouldShowSemanticStreaming(runtime) ? runtime.semantic.currentTurn : null}
```

Keep the two-line predicate call so the WHY comment in TileLeaf above `semanticTurn=` still reads correctly.

- [ ] **Step 4: Run the evidence flow. Submit a prompt; scrub through the feed debug panel.**

Expected: `semanticTurnId` stays set for the entire turn duration; no null-flip between block transitions. Rendered row count for the live tail is `entries + 1 semantic + 0..N work-indicator`.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/tiles/mergedEntries.ts src/renderer/src/tiles/TileLeaf.tsx
git commit -m "fix(feed): keep SemanticStreamingTurn mounted for whole current turn; exclude current-turn ghosts from merge"
```

---

## Task 6: Plumb Codex `responseId` through to reconcileUpstream

Codex assistant-text ghosts never supersede because `reconcileUpstream` only matches by `message.id` (Anthropic-specific) or `toolUseId` (missing on text blocks). Fix by stamping the Codex rollout's response id on the mapped `Entry` and matching on it.

**Files:**
- Modify: `src/renderer/src/tiles/workspaceStore.ts:1404-1600` (`mapCodexRolloutToFeedEntries` and its helpers)
- Modify: `src/renderer/src/tiles/ghosts.ts` (already touched in Task 1 for the match)
- Modify: `src/renderer/src/tiles/workspaceState.ts` (extend the Entry augmentation — see Step 2)

- [ ] **Step 1: Extend the cc-shell Entry shape with an optional `codexTurnId`.**

`Entry` is imported from `../../../shared/types/transcript` and shared across the codebase. Rather than mutate the shared type, add a field on Codex-specific entry factories and cast at the call site. Pragmatic option: create a tiny module-local helper in `workspaceStore.ts`:

```ts
function stampCodexTurnId<E extends Entry>(entry: E, responseId: string | null): E {
  if (!responseId) return entry
  return { ...entry, codexTurnId: responseId } as E
}
```

TypeScript will accept the extra field via the cast. Consumers (`reconcileUpstream`, Feed) read it defensively with `typeof … === 'string'` checks.

- [ ] **Step 2: Thread `responseId` through `mapCodexRolloutToFeedEntries`.**

At the top of the function, extract the response id once:

```ts
const payload = entry.payload as Record<string, unknown> | undefined
// ...
const responseId =
  typeof payload?.response_id === 'string'
    ? (payload.response_id as string)
    : typeof payload?.id === 'string' && (payload.type === 'agent_message' || payload.type === 'agent_message_delta')
      ? (payload.id as string)
      : null
```

Then at every `return [factory(...)]` call site, wrap each produced entry:

```ts
return mapped.map(e => stampCodexTurnId(e, responseId))
```

Claude rollout entries do not carry `response_id`, so this is a no-op for the Claude ingest path.

- [ ] **Step 3: Verify in the log that Codex ghosts supersede.**

Run cc-shell against a Codex session. Trigger a turn that emits an assistant text block. In the feed-debug log, observe a SEM ghost → SEM ghost-update → JSONL jsonl_entries event → RENDER row delta that **does not** duplicate the assistant text.

Before this task, the same flow produces two visible rows (one from the merged ghost trailing, one from the committed entry) until the `shouldSuppressSemanticTurnForCommittedTail` Codex-only helper in `Feed.tsx:579-596` steps in. After this task, the ghost is superseded by the committed entry's `codexTurnId === ghost.turnId` match, and the suppression helper is no longer required.

- [ ] **Step 4: Delete `shouldSuppressSemanticTurnForCommittedTail` and its call site in `Feed.tsx`.**

The helper was a narrow guardrail for the exact bug this task fixes. Remove:
- `textFromConversationEntry`, `normalizeRenderableText`, `shouldSuppressSemanticTurnForCommittedTail` in `Feed.tsx:552-598`
- The `suppressSemanticTurn` / `renderedSemanticTurn` usage — collapse `renderedSemanticTurn` back to `semanticTurn`.

Re-run the Codex flow and confirm no duplicate row.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/tiles/workspaceStore.ts src/renderer/src/tiles/ghosts.ts src/renderer/src/feed/Feed.tsx
git commit -m "fix(codex): plumb responseId to reconcileUpstream; drop Codex suppress-helper"
```

---

## Task 7: Run ghost reconciliation after bootstrap merges disk ghosts in

Bootstrap order today: JSONL burst lands first with `runtime.ghosts = emptyMap`, so `reconcileUpstream` matches nothing. Then disk ghosts merge in, referencing turnIds that are already in `runtime.entries`. None of those get superseded. Task 4 drops already-superseded ghosts at load, but live-but-actually-reconciled ghosts (created late in the prior session, never superseded on disk because the app crashed) still slip through. Fix by re-running `reconcileUpstream` across the committed entry list when the bootstrap merge lands.

**Files:**
- Modify: `src/renderer/src/tiles/workspaceStore.ts:2740-2768`

- [ ] **Step 1: In the ghost-bootstrap `setTimeout`, after merging disk ghosts into `current.ghosts`, walk `current.entries` and apply `reconcileUpstream` per entry so any already-committed entries supersede their matching ghosts in-place.**

Replace the `setRuntimes(prev => { … })` body with:

```ts
setRuntimes(prev => {
  const current = prev[sessionId]
  if (!current) return prev
  let merged = new Map(current.ghosts)
  for (const [uuid, ghost] of bootstrapped) {
    if (!merged.has(uuid)) merged.set(uuid, ghost)
  }
  // Reconcile against whatever JSONL entries already landed during
  // the bootstrap burst. Without this, ghosts for turns that already
  // have committed entries stay live and render as duplicates.
  for (const entry of current.entries) {
    merged = reconcileUpstream(entry, merged)
  }
  // Persist supersedes that this pass produced so the next resume
  // sees them already marked. Fire-and-forget.
  for (const ghost of ghostsToPersist(current.ghosts, merged)) {
    window.api.ghostAppend(sessionId, ghost)
  }
  return {
    ...prev,
    [sessionId]: { ...current, ghosts: merged },
  }
})
```

- [ ] **Step 2: Test the resume path on a session with persisted ghosts.**

Kill cc-shell mid-turn, restart, resume the same session. Expected: ghost rows do not duplicate or flash; the feed shows only committed entries plus any genuinely-orphaned ghosts.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/tiles/workspaceStore.ts
git commit -m "fix(ghosts): reconcile disk-bootstrapped ghosts against already-loaded entries"
```

---

## Task 8: Short-circuit `foldSemanticEvent` on no-op events

`foldSemanticEvent` always returns a fresh `SemanticRuntimeState` and bumps `nextLogId`. Even events that touch no visible state cause a `setRuntimes` cascade — eight times at bootstrap for dead `tool_result` events, and once per `usage_updated` mid-stream. Track whether any real mutation happened and return `state` unchanged otherwise.

**Files:**
- Modify: `src/renderer/src/tiles/workspaceStore.ts:574-1335` (`foldSemanticEvent`)

- [ ] **Step 1: Identify the tool_result no-op guards.**

Line 1063 already has:

```ts
if (!currentTurn || typeof ev.toolUseId !== 'string') break
if (typeof ev.turnId === 'string' && ev.turnId !== currentTurn.turnId) break
```

Add after each `break` path that does not mutate anything else a sentinel:

Convert the function to track a `mutated: boolean` flag. At the top:

```ts
  let mutated = false
```

Set `mutated = true` wherever `flows`, `currentTurn`, `history`, or `errors` is assigned. Do NOT set it for the mere log append — the log is implementation detail.

At the bottom, short-circuit before building the new state:

```ts
  if (!mutated) return state
  // existing derive + return block
```

- [ ] **Step 2: Update the render effect that depends on `nextLogId` if any.**

Search for usages: `grep -n nextLogId src/renderer/src`. The log is consumed by `ProxyDebugPanel` and `DebugPanel`. Losing one entry per dead event is acceptable — these panels already throttle. Confirm no UI derivation asserts on monotonically-increasing `nextLogId` without gaps.

- [ ] **Step 3: In the outer `onSessionSemanticEvent` subscriber (`workspaceStore.ts:2112-2263`), also short-circuit when `nextSemantic === current.semantic` AND there is no stream_phase / tool_result / ghost delta to apply.**

Concretely, add the following check after computing `nextSemantic` and the phase block:

```ts
const semanticUnchanged = nextSemantic === current.semantic
const phaseUnchanged =
  streamPhase === current.streamPhase &&
  streamPhasePendingToolName === current.streamPhasePendingToolName &&
  streamPhasePendingToolUseId === current.streamPhasePendingToolUseId &&
  turnStartedAt === current.turnStartedAt &&
  phaseChangedAt === current.phaseChangedAt &&
  submittedAt === current.submittedAt
const ghostsUnchanged = nextGhosts === current.ghosts
if (semanticUnchanged && phaseUnchanged && ghostsUnchanged && !clearOptimisticAwaiting) {
  return prev
}
```

This is the bailout that pairs with the JSONL-ingest `noChange` guard.

- [ ] **Step 4: Reproduce the session timeline and confirm the 8 dead tool_result events at bootstrap no longer appear as SEM entries in the feed-debug log.**

Expected: `id:1-8` replaced by either nothing at all, or a tighter set (STATE session_started only). The semanticTurnId mid-turn flip from Task 5 is already fixed, but this task confirms nothing is redundantly folding state on repeated no-ops.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/tiles/workspaceStore.ts
git commit -m "perf(semantic): short-circuit foldSemanticEvent and onSessionSemanticEvent on no-op"
```

---

## Task 9: Gate the Claude committed tool_result bridge

The Claude bridge in `claudeSession.ts:319-365` fires for every committed `tool_result`, including the ones re-emitted during the JSONL tail's initial replay. Task 8 dampens the renderer side, but the cleaner fix is to not bridge historical events at all. Gate the bridge on a one-time flag that flips once the tail's initial replay has quiesced.

**Files:**
- Modify: `src/providers/claude/runtime/claudeSession.ts:300-380`

- [ ] **Step 1: Track a `readyForLiveBridge` flag on the session.**

Add a private field initialised to `false`, flip it to `true` once `headless.start()` has resolved AND the first `bootstrap-complete` signal from the renderer has arrived — or, simpler and sufficient: flip it to `true` after a short quiet window (e.g. 250 ms) following the last committed entry, mirroring the renderer's existing 150 ms bootstrap-debounce.

```ts
private readyForLiveBridge = false
private liveBridgeTimer: NodeJS.Timeout | null = null

private armLiveBridgeReady(): void {
  if (this.readyForLiveBridge) return
  if (this.liveBridgeTimer) clearTimeout(this.liveBridgeTimer)
  this.liveBridgeTimer = setTimeout(() => {
    this.readyForLiveBridge = true
    this.liveBridgeTimer = null
  }, 250)
}
```

Invoke `this.armLiveBridgeReady()` from the `committed.entry` listener (the one that fires for every JSONL entry during replay).

- [ ] **Step 2: Gate the bridge.**

```ts
this.headless.committed.on('tool_result', ev => {
  if (!this.readyForLiveBridge) return
  const bridged: SemanticEvent = {
    type: 'tool_result',
    turnId: ev.turnId,
    toolUseId: ev.toolUseId,
    content: ev.content,
    isError: ev.isError,
    source: 'jsonl',
    confidence: 'high',
    ts: ev.ts,
  }
  this.emit('semantic-event', bridged)
})
```

- [ ] **Step 3: Confirm live tool_result bridging still works for post-bootstrap turns.**

Manual test: start a session, wait for bootstrap to settle, run a Bash tool. Expected: the renderer sees exactly one `tool_result` SEM event per tool call, and it lands after the bootstrap quiet window. Historical tool_results (during replay) produce zero bridged events — their effect is already in `runtime.entries` via the JSONL tail and the Feed's `toolResultIndex`.

- [ ] **Step 4: Commit**

```bash
git add src/providers/claude/runtime/claudeSession.ts
git commit -m "fix(claude): gate committed tool_result bridge until post-bootstrap"
```

---

## Task 10: Verify and push

- [ ] **Step 1: Full build**

```bash
npm run build && (cd claude-code-headless && npm run build) && (cd codex-headless && npm run build)
```

Expected: all three green.

- [ ] **Step 2: Smoke tests**

1. **Claude proxy session, new**: submit "list files in this dir", expect WorkIndicator `Sending → Connecting → Thinking → Calling Bash → Awaiting Bash → Writing → idle`. Feed shows one user row, one assistant row, one tool row, one result row. No duplicate rows. No flash on resume.
2. **Claude resume**: kill cc-shell mid-turn, relaunch, resume same session. Expect feed to show committed tail only; no 37-row flash; no duplicate tool-result rows.
3. **Codex proxy session**: submit a prompt that produces assistant text and a function_call. Verify no duplicate assistant text (the `shouldSuppressSemanticTurnForCommittedTail` helper we deleted in Task 6 is what used to catch this).
4. **Codex resume**: same as (2) for Codex.

Each scenario: open the Feed Debug Panel and confirm render-row deltas match the expected visible changes (no orphan +1 −1 churn).

- [ ] **Step 3: Review the plan's commits in sequence.**

```bash
git log --oneline fix/rendering-2026-04-20 ^main
```

Expected: 9 focused commits, one per task. No noise from Pre-flight fixes mixed in (those belong in a separate commit if done).

- [ ] **Step 4: Push the branch and open a PR.**

```bash
git push -u origin fix/rendering-2026-04-20
```

Then create a PR titled "fix(rendering): stabilize ghosts, merge, and committed bridge". Body: link to this plan and the evidence log summary at the top.

---

## Self-Review Notes

- **Spec coverage:** All six confirmed defects (A–C symptom list + ghost race + bootstrap tool_result flood + Codex ghost non-reconcile + render churn) map to a task. Bug "7" (WorkIndicator unmount/remount) from the earlier diagnosis was dropped after re-reading `Feed.tsx:1186-1191` — the WorkIndicator receives props, not a new key, and `useElapsedSeconds` re-runs only when `turnStartedAt` changes. Not a real defect.
- **Placeholder scan:** Every step that touches code shows the code. Every step that runs a command shows the command. No "handle edge cases" or "similar to above" shortcuts.
- **Type consistency:** `selectMergedEntries`' new `currentTurnId` parameter is the same type (`string | null`) in both `mergedEntries.ts` and its `TileLeaf.tsx` call site. `stampCodexTurnId` is defined once in `workspaceStore.ts` and used in the same file. `reduceGhostLogSansSuperseded` is imported in `workspaceStore.ts` exactly as exported from atp.
- **Risk:** Task 3 and Task 4 land a cross-repo change (atp submodule bump + cc-shell consumer). Ship them as a pair; do not merge cc-shell with an atp SHA that lacks `trustSupersededFlag`. Task 9's 250 ms quiet-window heuristic is the only judgment call; if live bridging feels delayed in practice, tighten to 100 ms or switch to an explicit "bootstrap complete" IPC signal (the renderer already computes one; exposing it to main is a follow-up).
