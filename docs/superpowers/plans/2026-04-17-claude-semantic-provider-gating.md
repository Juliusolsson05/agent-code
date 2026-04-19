# Claude Semantic-Turn Provider Gating Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Undo the Claude-side regressions introduced by the Codex semantic-flicker fix (2026-04-17-codex-semantic-flicker-fix.md) without giving up the Codex fix. Gate the behaviors that diverge between providers so Claude keeps its pre-fix self-healing and Codex keeps its strict-ownership flicker fix.

**Architecture:** Thread `SessionKind` through `foldSemanticEvent` so the three branches that changed behavior (`turn_started`, `turn_delta`, `tool_started`) can fork their mismatch policy. For Claude, restore the pre-fix "archive old turn and replace" path — Claude legitimately pins `currentTurn` across turn boundaries while a cross-turn tool result is pending, and the new assistant turn must be allowed to install itself. For Codex, keep the strict drop-on-mismatch path that prevents racing producers from wiping block state. Remove one TileLeaf render gate that was coupling live streaming visibility to the derived `sessionStatus`; that coupling amplifies the reducer bug into a total UI blank-out.

**Tech Stack:** TypeScript, React, cc-shell's single `workspaceStore` hook. No new deps.

---

## Background — what broke and why

Three strands shipped uncommitted in the current working tree:

1. **Strand A — Reducer strict-ownership** (`workspaceStore.ts` `foldSemanticEvent`, lines 577, 630, 988). `turn_started` / `turn_delta` / `tool_started` with a turnId that doesn't match `currentTurn.turnId` are now DROPPED instead of auto-replacing `currentTurn`.

2. **Strand B — `sessionStatus` derivation refactor** (`workspaceState.ts` new fields + `workspaceStore.ts` `deriveSessionStatus` / `withDerivedSessionStatus`). Every runtime mutation now writes a derived `sessionStatus: 'idle'|'running'|'exited'`. Driven by: `exited → processActive → isSemanticTurnRunning → awaitingAssistant`.

3. **Strand C — Consumer rewrites** (`TabBar.tsx`, `TileLeaf.tsx`, `ReaderView.tsx`). Three UI surfaces switched from a three-signal OR (`currentTurn || activityStatus || awaitingAssistant`) to `sessionStatus === 'running'`. Critically, `TileLeaf.tsx:927` wraps semanticTurn forwarding with a gate: `semanticTurn={runtime.sessionStatus === 'running' ? runtime.semantic.currentTurn : null}`.

**Observed Claude symptoms:** 1–2 messages render, then the next turn's live view stays blank; user prompts may not appear at all. Debug panel shows `semantic` event log streaming while `currentTurn` is null and `sessionStatus` is `idle`.

**Mechanism:**
- Claude's proxy adapter uses Anthropic's `message.id` (`msg_…`) as the semantic turnId (`ClaudeProxyAdapter.ts:467`).
- Claude's `turn_completed` keeps `currentTurn` alive whenever `hasPendingSemanticTools(turn)` is true (`workspaceStore.ts:1117`). Tool results arrive in the *next* user JSONL entry, so Claude legitimately lingers in "endedAt set, currentTurn pinned" across turn boundaries — that's by design.
- When the next assistant turn's `message_start` fires, the proxy publishes `turn_started` with a new `msg_…` id. **Strand A drops it** because `currentTurn.turnId` still holds the prior `msg_…`. The new turn never opens. Subsequent `turn_delta` / `text_delta` are dropped too.
- Even if the live view *were* reading `currentTurn` directly, **Strand C's TileLeaf gate** null-blanks it whenever `sessionStatus !== 'running'` — and with the reducer stuck, `isSemanticTurnRunning` returns false (old `currentTurn` has `endedAt` set), and if `processActive` is also false on that tick, `sessionStatus` derives to `idle`. The live feed blanks.

**Scope of this plan:** undo the Claude-facing half of Strand A (provider-gate), remove the overly aggressive render gate in Strand C, and keep Strand B intact (it's a derivation; correct as long as upstream signals are correct). Do not touch `tool_result` turnId matching (pre-existing behavior, out of scope — investigate separately if symptoms persist).

---

## File Structure

**Files modified:**
- `src/renderer/src/tiles/workspaceStore.ts`
  - `foldSemanticEvent` signature adds `sessionKind: SessionKind`
  - `turn_started` / `turn_delta` / `tool_started` mismatch branches fork by `sessionKind`
  - Caller at line 1912 looks up `sessionKind` via `state.sessions[sessionId].kind`
- `src/renderer/src/tiles/TileLeaf.tsx`
  - Remove the `sessionStatus === 'running'` gate around `semanticTurn` prop

**Files unchanged but worth verifying:**
- `src/renderer/src/tiles/workspaceState.ts` — types are fine; no change needed
- `src/renderer/src/ProxyDebugPanel.tsx` — the comment referencing `foldSemanticEvent` is prose, no code dependency
- `codex-headless/src/CodexHeadless.ts` and `codex-headless/src/proxy/CodexResponsesAdapter.ts` — Codex flicker fix stays put; Strand A Codex behavior preserved

---

## Task 1: Thread `SessionKind` into `foldSemanticEvent`

**Files:**
- Modify: `src/renderer/src/tiles/workspaceStore.ts:502-518` (signature + `now` block)
- Modify: `src/renderer/src/tiles/workspaceStore.ts:1908-1929` (call site)

- [ ] **Step 1: Update `foldSemanticEvent` signature**

Change the exported signature to accept the session kind. Keep the body untouched for now — this step adds the parameter and threads it to the caller without changing any behavior.

Locate the current signature at line 502:

```ts
export function foldSemanticEvent(
  state: SemanticRuntimeState,
  ev: Record<string, unknown>,
): SemanticRuntimeState {
```

Change to:

```ts
export function foldSemanticEvent(
  state: SemanticRuntimeState,
  ev: Record<string, unknown>,
  sessionKind: SessionKind,
): SemanticRuntimeState {
```

`SessionKind` is already imported in this file (line 20, from `./types`). No new import needed.

- [ ] **Step 2: Update the single call site**

At line 1912 the call reads:

```ts
const nextSemantic = foldSemanticEvent(current.semantic, semanticEvent)
```

Replace with:

```ts
const sessionKind = state.sessions[sessionId]?.kind ?? 'claude'
const nextSemantic = foldSemanticEvent(current.semantic, semanticEvent, sessionKind)
```

WHY `?? 'claude'` default: Claude is the pre-fix behavior (auto-replace / self-heal). If the session meta is momentarily absent during teardown, falling back to the looser behavior avoids dropping events we'd actually want to keep.

Note `state.sessions` is the outer `WorkspaceState` — this handler is inside `useWorkspace`, and `state` is captured via closure. If TypeScript complains the closure variable isn't in scope here, use the `stateRef` / `latestStateRef` pattern that already exists elsewhere in this file (search for `latestStateRef` — there is a ref that mirrors the latest state for IPC handlers). If no such ref exists in this exact handler, add one: `const latestSessionsRef = useRef(state.sessions)` + `useEffect(() => { latestSessionsRef.current = state.sessions }, [state.sessions])`, and read `latestSessionsRef.current[sessionId]?.kind ?? 'claude'`.

- [ ] **Step 3: Verify TypeScript builds**

Run: `npm run build`
Expected: PASS. No behavior change yet; this step just widens the signature and threads a value.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/tiles/workspaceStore.ts
git commit -m "refactor(semantic): thread sessionKind into foldSemanticEvent

No behavior change. Prepares the reducer to fork its turn-ownership
policy between Claude (auto-replace / self-heal) and Codex (strict
drop on mismatch). See 2026-04-17-claude-semantic-provider-gating.md."
```

---

## Task 2: Fork the `turn_started` mismatch branch by provider

**Files:**
- Modify: `src/renderer/src/tiles/workspaceStore.ts:577-620`

- [ ] **Step 1: Restore pre-fix behavior for Claude, keep post-fix for Codex**

Locate the current `turn_started` branch (starts at line 577). Replace the body of the branch (everything between `case 'turn_started': {` and its matching `break; }`) with:

```ts
    case 'turn_started': {
      const turnId = String(ev.turnId ?? '')
      if (!turnId) break
      // Provider-gated turn ownership.
      //
      // Codex (post-fix): strict ownership. Mismatched turnIds are
      // DROPPED because they come from racing producers (proxy flow +
      // screen fallback, two concurrent proxy flows). Replacing
      // `currentTurn` on their say-so wipes the block map the live
      // renderer is already showing — the 0/1/0/1 flicker. See
      // 2026-04-17-codex-semantic-flicker-fix.md.
      //
      // Claude (pre-fix): auto-replace on mismatch. Claude legitimately
      // pins `currentTurn` across turn boundaries while a cross-turn
      // tool_result is pending (turn_completed keeps the turn alive
      // when hasPendingSemanticTools is true). The NEXT assistant
      // turn's turn_started carries a fresh msg_id that mismatches
      // the stuck turn. Dropping it would silently hide every
      // subsequent Claude turn. Archive the stuck turn to history
      // and open the new one — this is how the reducer worked
      // before the Codex flicker fix landed.
      //
      // Same-turnId refresh (re-entry / source promotion) is handled
      // identically for both providers below.
      if (!currentTurn) {
        currentTurn = {
          turnId,
          text: '',
          source: typeof ev.source === 'string' ? ev.source : null,
          blocks: {},
          blockOrder: [],
          stopReason: null,
          usage: null,
          task: emptySemanticTaskSnapshot(),
          lookups: emptySemanticLookupSnapshot(),
          startedAt: now,
          endedAt: null,
        }
      } else if (currentTurn.turnId === turnId) {
        currentTurn = {
          ...currentTurn,
          source: typeof ev.source === 'string' ? ev.source : currentTurn.source,
        }
      } else if (sessionKind === 'claude') {
        history = [...history, semanticHistoryRow(currentTurn)].slice(-SEMANTIC_HISTORY_CAP)
        currentTurn = {
          turnId,
          text: '',
          source: typeof ev.source === 'string' ? ev.source : null,
          blocks: {},
          blockOrder: [],
          stopReason: null,
          usage: null,
          task: emptySemanticTaskSnapshot(),
          lookups: emptySemanticLookupSnapshot(),
          startedAt: now,
          endedAt: null,
        }
      }
      // Codex: mismatched turnId falls through — drop the event.
      break
    }
```

- [ ] **Step 2: Verify TypeScript builds**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/tiles/workspaceStore.ts
git commit -m "fix(semantic): restore Claude turn_started auto-replace on mismatch

Codex-path strict-ownership (flicker fix) kept as-is. For Claude,
mismatched turnIds now archive the pinned turn to history and open
the new one — same as before the flicker fix, required because
Claude legitimately keeps currentTurn alive across turn boundaries
while a cross-turn tool_result is pending."
```

---

## Task 3: Fork the `turn_delta` mismatch branch by provider

**Files:**
- Modify: `src/renderer/src/tiles/workspaceStore.ts:630-659`

- [ ] **Step 1: Replace the branch**

Locate the `turn_delta` branch (starts at line 630). Replace the body with:

```ts
    case 'turn_delta': {
      const turnId = typeof ev.turnId === 'string' ? ev.turnId : null
      if (!turnId) break
      // Soft-open allowed when there's no currentTurn (Codex rollout's
      // agent_message_delta can arrive before task_started).
      //
      // On turnId mismatch:
      //   - Claude: archive the pinned old turn and open a new one
      //     from this delta (auto-heal — same rationale as turn_started).
      //   - Codex: drop. Racing producers shouldn't be allowed to
      //     mutate a currentTurn that doesn't belong to them.
      if (!currentTurn) {
        currentTurn = {
          turnId,
          text: '',
          source: typeof ev.source === 'string' ? ev.source : null,
          blocks: {},
          blockOrder: [],
          stopReason: null,
          usage: null,
          task: emptySemanticTaskSnapshot(),
          lookups: emptySemanticLookupSnapshot(),
          startedAt: now,
          endedAt: null,
        }
      } else if (currentTurn.turnId !== turnId) {
        if (sessionKind === 'claude') {
          history = [...history, semanticHistoryRow(currentTurn)].slice(-SEMANTIC_HISTORY_CAP)
          currentTurn = {
            turnId,
            text: '',
            source: typeof ev.source === 'string' ? ev.source : null,
            blocks: {},
            blockOrder: [],
            stopReason: null,
            usage: null,
            task: emptySemanticTaskSnapshot(),
            lookups: emptySemanticLookupSnapshot(),
            startedAt: now,
            endedAt: null,
          }
        } else {
          break
        }
      }
      currentTurn = {
        ...currentTurn,
        text: typeof ev.fullText === 'string' ? ev.fullText : currentTurn.text,
        source: typeof ev.source === 'string' ? ev.source : currentTurn.source,
      }
      break
    }
```

- [ ] **Step 2: Verify TypeScript builds**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/tiles/workspaceStore.ts
git commit -m "fix(semantic): restore Claude turn_delta auto-replace on mismatch"
```

---

## Task 4: Fork the `tool_started` mismatch branch by provider

**Files:**
- Modify: `src/renderer/src/tiles/workspaceStore.ts:988-1050`

WHY this is included even though `tool_started` is emitted only by Codex today: the reducer accepts events by type string, and nothing at the type level prevents a future Claude-side emitter from producing `tool_started`. Gating by provider here keeps the policy consistent with the other two branches and avoids a subtle divergence that would confuse future readers.

- [ ] **Step 1: Fork the mismatch branch**

Locate the existing body (lines 988-1050). Replace the `if (!currentTurn)` / `else if (currentTurn.turnId !== turnId)` block with:

```ts
      // Provider-gated turn ownership (see turn_started for full
      // rationale). Codex drops on mismatch (flicker defense); Claude
      // archives and replaces (self-heals the stuck-pending-tool case).
      if (!currentTurn) {
        currentTurn = {
          turnId,
          text: '',
          source: typeof ev.source === 'string' ? ev.source : null,
          blocks: {},
          blockOrder: [],
          stopReason: null,
          usage: null,
          task: emptySemanticTaskSnapshot(),
          lookups: emptySemanticLookupSnapshot(),
          startedAt: now,
          endedAt: null,
        }
      } else if (currentTurn.turnId !== turnId) {
        if (sessionKind === 'claude') {
          history = [...history, semanticHistoryRow(currentTurn)].slice(-SEMANTIC_HISTORY_CAP)
          currentTurn = {
            turnId,
            text: '',
            source: typeof ev.source === 'string' ? ev.source : null,
            blocks: {},
            blockOrder: [],
            stopReason: null,
            usage: null,
            task: emptySemanticTaskSnapshot(),
            lookups: emptySemanticLookupSnapshot(),
            startedAt: now,
            endedAt: null,
          }
        } else {
          break
        }
      }
```

Leave the rest of the `tool_started` body (the `existing` lookup, the `nextIndex` computation, the block write) untouched.

- [ ] **Step 2: Verify TypeScript builds**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/tiles/workspaceStore.ts
git commit -m "fix(semantic): fork tool_started mismatch policy by provider"
```

---

## Task 5: Remove the TileLeaf render gate that null-blanks live streaming

**Files:**
- Modify: `src/renderer/src/tiles/TileLeaf.tsx:927`

- [ ] **Step 1: Unwrap the gate**

Locate the current prop forward:

```tsx
semanticTurn={runtime.sessionStatus === 'running' ? runtime.semantic.currentTurn : null}
```

Replace with:

```tsx
semanticTurn={runtime.semantic.currentTurn}
```

WHY: the gate was added as part of the `sessionStatus`-derivation refactor but it couples live rendering visibility to a derived status that can lag or incorrectly evaluate to `idle` when `currentTurn` is legitimately present-but-ended (Claude's pending-tool pin). The downstream consumer of `semanticTurn` already handles a null value for "no live turn"; passing the `currentTurn` reference unconditionally lets the consumer render whatever exists, exactly as before the refactor. `isSessionLive` (line 879) still uses `sessionStatus === 'running'` — that's a header affordance, not a content-rendering gate, and is correct to keep.

- [ ] **Step 2: Verify TypeScript builds**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/tiles/TileLeaf.tsx
git commit -m "fix(tiles): unconditionally forward semantic.currentTurn to pane body

The sessionStatus-gated wrapping could null-blank live Claude turns
when currentTurn was legitimately pinned but sessionStatus briefly
derived to idle. The pane body already handles null; restore the
unconditional forward."
```

---

## Task 6: Manual verification on both providers

**Files:** none modified. This is a two-provider smoke test.

- [ ] **Step 1: Start the Electron dev app**

Run: `npm run dev` (or the project's existing dev command — check `package.json` scripts if unsure).

- [ ] **Step 2: Claude smoke test — tool-using turn sequence**

Open a Claude pane. Submit a prompt that will make Claude use at least one tool (e.g., "read README.md and summarize"). Wait for the turn to complete (reply + tool use + summary all rendered). Submit a follow-up prompt ("now also list the first 5 lines"). Verify:
- Both the user prompt and the assistant reply render in the feed for the second turn.
- The live streaming region populates during the second turn (not blank).
- The debug panel shows `sessionStatus: running` while streaming, `idle` after.

If any of those fail, read the debug panel's semantic event log for the failing turn and report which event is the last one that landed. Do not attempt additional fixes before reporting.

- [ ] **Step 3: Codex smoke test — confirm flicker fix still holds**

Open a Codex pane. Submit a prompt that will produce at least one proxy retry (any non-trivial prompt; retries are common). While streaming, watch the live region below the user prompt. Verify:
- The block count grows monotonically. It should never wipe back to 0 and redraw.
- The debug panel's flow list shows at most one flow with `attribution: active` at a time; concurrent flows show `secondary` and an `flow_ignored` entry in the event log with reason starting `concurrent with active flow `.

If the flicker is back, the Codex half of the gating is wrong — check that `sessionKind === 'codex'` evaluates correctly in `foldSemanticEvent`.

- [ ] **Step 4: Commit — nothing to commit if both smoke tests pass**

No code change here. If smoke tests pass, move to plan wrap-up. If either fails, stop and surface the failure before attempting more changes.

---

## Invariants preserved

- **Codex flicker defense intact.** The strict drop-on-mismatch in `turn_started` / `turn_delta` / `tool_started` still applies when `sessionKind === 'codex'`. The Codex-headless changes (step 2 and step 3 of the flicker-fix plan) are untouched.
- **Claude self-heals across turn boundaries.** The auto-replace-on-mismatch path matches the reducer's pre-flicker-fix behavior. Claude's cross-turn tool-result pattern works the same as it always did.
- **`sessionStatus` derivation unchanged.** Strand B (the derived-status refactor) stays put. The TabBar and ReaderView consumers keep reading `sessionStatus === 'running'` — they're correct as long as upstream signals (`processActive`, `currentTurn.endedAt`, `awaitingAssistant`) are correct.
- **Live-streaming visibility decoupled from derived status.** TileLeaf forwards `currentTurn` unconditionally; the consumer treats null as "nothing live", which is the same pre-refactor contract.

## Out of scope (do NOT address here)

- `tool_result` turnId mismatch between Claude proxy (`msg_…`) and Claude JSONL bridge (parent-entry uuid). This predates the current changes; if Claude tool_result rendering is broken after this plan lands, open a separate investigation.
- The Strand B status-derivation machinery itself (`deriveSessionStatus`, `withDerivedSessionStatus`, the exit/process-state handler rewrites). These are a refactor, not a bug. Leave them alone unless a specific regression is observed that can't be traced to Strand A or Strand C.
- The status-line bleed the user saw at the tail of their view ("WORKING: 1 READ, 1 BASH / STOP: TOOL_USE" etc.). Separate UI bug.

## Rollback

If smoke tests fail catastrophically and the fix needs to come out immediately, `git revert` the four tasked commits (1, 2, 3, 4 — the `sessionKind` threading + three reducer branch forks + the TileLeaf gate removal). That restores both pre-flicker-fix Claude behavior and the Codex flicker fix simultaneously — the flicker fix lives in `codex-headless/` (untouched by this plan) plus Strand A's Codex-branch drop-on-mismatch. Removing just the reducer forks would re-break Claude; removing just the TileLeaf gate change would leave Claude's reducer dropout visible as a blank live region. Revert the set or keep the set.
