# Claude-duplicate-text + screen_update churn — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close two rendering defects that survive the 2026-04-20-rendering-fixes plan: (1) Claude's committed `tool_result` bridge never lands on the live semantic turn, so `runtime.semantic.currentTurn` lingers past `turn_completed` and the user sees the assistant text rendered twice (once as the committed entry, once as the live `<SemanticStreamingTurn>`); (2) `onSessionScreen` fires a STATE `screen_update` for every TUI refresh frame even when only transient chrome (spinner, cursor, timestamp) ticked, producing 10k+ reducer invocations per session and bloating the feed-debug log.

**Architecture:** Both defects sit on the Claude-specific bridge between the `claude-code-headless` package and the cc-shell renderer. #1 is a 3-hop data-flow bug where an identifier mismatch (`parentUuid` vs `message.id`) is silently absorbed by a guard in `foldSemanticEvent`; fixing any one hop closes it. #2 is a diff-fidelity bug in the `onSessionScreen` IPC bail-out: the current early-return compares four string fields, but the upstream TUI parser doesn't fully strip the ~60 Hz chrome that changes those strings without changing user-visible content.

**Tech Stack:** TypeScript, Electron, Zustand. Files across `src/providers/claude/runtime/claudeSession.ts`, `src/renderer/src/tiles/workspaceStore.ts`, and (read-only reference) `claude-code-headless/src/channels/CommittedChannel.ts`, `claude-code-headless/src/channels/SemanticChannel.ts`, `src/renderer/src/feed/Feed.tsx`.

---

## Evidence baseline

Before touching code, open these log files so the fix targets are concrete:

- `~/.config/cc-shell/feed-debug/3bf116ae-34e7-427a-95cb-9473fb25f697.jsonl` — cleanest mid-size log for reproducing defect #1. Turn `msg_019Ys3kHoh2tjZRS6Z5fu1EW` at ids 10346–10556 shows the full sequence:
  - `id 10521` — `SEM turn_completed turn=msg_019Ys3…`
  - `id 10526` — `SEM tool_result src=jsonl turn=f6f4f591-487d-47b7-954e-047231126c13 toolUseId=toolu_…` (the turnId is an **entry uuid**, not the msg id)
  - `id 10528` — `JSONL jsonl_entries +4` (the committed tail lands)
  - `id 10529` — `RENDER` adds 4 `entry:…` rows **and** a `semantic:msg_019Ys3…` row in the same diff. This is the duplicate.
  - `id 10556` — `SEM turn_started turn=msg_01L613…` — only now does `semantic:msg_019Ys3…` get evicted (at `id 10557`).
- `~/.config/cc-shell/feed-debug/e27ae9d1-4ac3-4a25-9d54-d9a496fe362b.jsonl` — 37 MB / 22 604 lines. Defect #2 shows as 13 593 `STATE screen_update` events, ~97 % of which share an identical `(changed, recentLength, pickerVisible, approvalOpen)` fingerprint. Longest single run of fingerprint-identical writes: 566.

Key source-code anchors for defect #1:
- `claude-code-headless/src/channels/CommittedChannel.ts:169-172` — the channel resolves `turnId = parentUuid ?? entry.uuid`. Comment at `:161-163` asserts "the renderer matches on toolUseId anyway so the wrong turnId is only a reconciliation hint, not a correctness issue." That assumption is violated by the guard in the next hop.
- `src/providers/claude/runtime/claudeSession.ts:377-387` — bridges the committed event verbatim onto the semantic bus, including `turnId: ev.turnId`.
- `src/renderer/src/tiles/workspaceStore.ts:1057` — `if (typeof ev.turnId === 'string' && ev.turnId !== currentTurn.turnId) break` drops the event silently. The match on toolUseId at `:1058` never runs.
- Downstream consequence — `workspaceStore.ts:406-417` `hasPendingSemanticTools()` keeps returning `true` because `resultAt` never lands, and `:1237-1249` `turn_completed` handler keeps `currentTurn` pinned.
- Render-site — `src/renderer/src/feed/Feed.tsx:931` `renderedSemanticTurn = semanticTurn` and `:1120-1122` unconditionally renders `<SemanticStreamingTurn>`. The Codex-specific `shouldSuppressSemanticTurnForCommittedTail` helper that used to paper over this was deleted on 2026-04-20 (see comment at `Feed.tsx:415-418`) on the assumption the ghost path handled it — which is true for Codex (Task 6 plumbs `response_id`) but not for Claude.

Key source-code anchors for defect #2:
- `src/renderer/src/tiles/workspaceStore.ts:1941-2064` — the `onSessionScreen` handler. The bail-out at `:1967-1975` compares `screen`, `screenMarkdown`, `recentScreen`, `recentScreenMarkdown`, and `picker` — all strings that change when TUI chrome ticks even though the visible transcript is static. Consumers of `runtime.screen*` are only `DebugPanel.tsx:29-36` and `ReaderView.tsx:155-170` (Feed does **not** subscribe), so the blast radius is reducer cost + `appendFeedDebugLog` spam, not visible re-renders.

---

## File Structure

**Files modified:**

- `src/providers/claude/runtime/claudeSession.ts` — stop forwarding `turnId` on the bridged `tool_result` event (Task 1). 1 line change, ~10 lines of WHY comment.
- `src/renderer/src/tiles/workspaceStore.ts`
  - `foldSemanticEvent` tool_result case (`:1046-1092`) — defensive cleanup so the match-by-toolUseId path can't be re-broken by a future bridge change (Task 2).
  - `onSessionScreen` handler (`:1941-2064`) — stronger bail-out that ignores chrome-only deltas (Task 3).

**Files added:** none.

**Files deliberately not touched:**
- `claude-code-headless/src/channels/CommittedChannel.ts` — alternative fix site for Task 1, but requires the channel to look up the parent assistant entry's `message.id` (not available today without a new map). Strictly worse than the one-line renderer-side fix.
- `src/renderer/src/feed/Feed.tsx` — the 2026-04-20 deletion of `shouldSuppressSemanticTurnForCommittedTail` should **stay deleted** after Task 1 closes the upstream cause.

---

## Pre-flight

- [ ] **Step 0: Create a worktree for this plan**

```bash
git worktree add ../cc-shell-claude-duptext -b fix/claude-duptext-2026-04-20
cd ../cc-shell-claude-duptext
npm install
```

Expected: clean worktree, npm succeeds (postinstall runs electron-rebuild).

- [ ] **Step 0b: Verify rendering-fixes plan is merged or absent**

This plan assumes the 2026-04-20-rendering-fixes plan's Task 6 has either already landed (Codex response-id plumbed, `shouldSuppressSemanticTurnForCommittedTail` deleted from `Feed.tsx`) or has not yet been started.

```bash
grep -n 'shouldSuppressSemanticTurnForCommittedTail' src/renderer/src/feed/Feed.tsx
```

Expected: returns only the historical comment at `:415-418` (the function itself is gone). If the function still exists, complete rendering-fixes Task 6 first — the interaction with Task 1 here is covered in that plan, not this one.

- [ ] **Step 0c: Confirm baseline build is green**

```bash
npm run build && (cd claude-code-headless && npm run build) && (cd codex-headless && npm run build)
```

Expected: three builds pass. codex-headless has four pre-existing TS errors in `ClaudeProxyAdapter.ts` (`block.citations`, `block.signature`) that predate this plan; document them before Task 1 so new failures are distinguishable from baseline noise.

---

## Task 1: Stop forwarding entry-uuid as `turnId` on the bridged `tool_result`

`claudeSession.ts` passes the `CommittedToolResultEvent.turnId` through unchanged. That value is the **parent assistant entry uuid** (set in `CommittedChannel.ts:169-172`), which never equals `runtime.semantic.currentTurn.turnId` (the Claude `msg_…` id). The guard at `workspaceStore.ts:1057` then drops the event. Omit the field entirely so the guard's `typeof ev.turnId === 'string'` precondition fails and the match falls through to `toolUseId` lookup at `:1058`, which is already the only unique key needed (per the comment at `CommittedChannel.ts:161-163`).

**Files:**
- Modify: `src/providers/claude/runtime/claudeSession.ts:377-387`

- [ ] **Step 1: Drop `turnId` from the bridged event shape.**

Current body:

```ts
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
```

Replace with:

```ts
// WHY omit turnId on the bridged event (not a typo):
//
// `ev.turnId` arrives as the committed user-role entry's parentUuid
// (see CommittedChannel.ts:169-172) — an `f6f4…`-style UUID. The
// renderer's currentTurn.turnId, however, is the Claude `msg_…` id
// that message_start sent down the SSE stream. The two never match,
// and foldSemanticEvent's tool_result case drops the event on
// turnId mismatch (workspaceStore.ts:1057) before the toolUseId
// lookup can run.
//
// Dropping the field is safer than correcting it: the committed
// channel doesn't know the assistant entry's message.id without an
// extra lookup, and toolUseId is already globally unique across
// Claude turns. The guard's `typeof ev.turnId === 'string'`
// precondition fails → the match-by-toolUseId path at line 1058
// runs as intended.
//
// Visible consequence of NOT doing this: the live
// SemanticStreamingTurn never releases after turn_completed (because
// hasPendingSemanticTools keeps returning true), so the assistant
// text renders twice — once as the committed entry, once as the
// lingering live view — until the next turn_started evicts it.
// Reproduces as session 3bf116ae id 10521→10557 in the feed-debug
// logs.
const bridged: SemanticEvent = {
  type: 'tool_result',
  toolUseId: ev.toolUseId,
  content: ev.content,
  isError: ev.isError,
  source: 'jsonl',
  confidence: 'high',
  ts: ev.ts,
}
this.emit('semantic-event', bridged)
```

- [ ] **Step 2: Verify types compile.**

```bash
npx tsc -p tsconfig.json --noEmit
```

Expected: no new errors. If the `SemanticEvent` type currently requires `turnId` on the `tool_result` variant, widen it to optional (search for the union in `src/shared/types/semantic.ts` or the corresponding headless re-export). Do **not** invent a fake turnId to satisfy the type.

- [ ] **Step 3: Reproduce the dup, confirm the fix.**

In `npm run dev`, open any prior Claude session (e.g. the `3bf116ae…` session above), send a prompt that triggers at least one tool_use (a Bash or Grep), and watch the Feed as the turn completes.

Expected:
- Before fix: assistant text appears in the committed entry **and** in a `<SemanticStreamingTurn>` card for ~1 second after `turn_completed`, until the next turn begins.
- After fix: committed entry replaces the live view within a frame; no visible dup.

Cross-check in the Feed Debug Panel: the RENDER diff right after `jsonl_entries` lands should **not** add a `semantic:msg_…` row. It should only add `entry:…` rows.

- [ ] **Step 4: Commit**

```bash
git add src/providers/claude/runtime/claudeSession.ts
git commit -m "fix(claude): drop entry-uuid turnId from bridged tool_result so match-by-toolUseId runs"
```

---

## Task 2: Defense-in-depth — relax the `turnId` guard in `foldSemanticEvent`

Task 1 closes the bug at the emit site. Task 2 makes sure a future bridge change that re-introduces an incorrect `turnId` can't silently re-open the same bug class. The guard at `workspaceStore.ts:1057` drops a whole event on turnId mismatch; downgrade it to "log-and-fall-through" so the toolUseId match still runs.

**Files:**
- Modify: `src/renderer/src/tiles/workspaceStore.ts:1046-1092`

- [ ] **Step 1: Replace the hard guard with a soft one.**

Current:

```ts
if (!currentTurn || typeof ev.toolUseId !== 'string') break
if (typeof ev.turnId === 'string' && ev.turnId !== currentTurn.turnId) break
const match = Object.entries(currentTurn.blocks).find(
  ([, block]) => block.toolUseId === ev.toolUseId,
)
if (!match) break
```

Replace with:

```ts
if (!currentTurn || typeof ev.toolUseId !== 'string') break

// WHY we no longer `break` on turnId mismatch:
//
// The committed tool_result bridge (claudeSession.ts) historically
// forwarded an entry-uuid as `turnId`, which never matched
// currentTurn.turnId (a Claude msg_id). The strict guard silently
// swallowed every such event, leaving the live semantic turn
// pinned forever and producing the duplicate-text defect fixed in
// the companion task. The bridge no longer forwards the field, but
// we keep this site tolerant of a future bridge regression — a
// toolUseId match is already globally unique, so a turnId
// mismatch is at worst a reconciliation hint we can note and
// ignore. If *both* fields are set and they disagree, surface it
// in errors for observability; do not drop the event.
if (
  typeof ev.turnId === 'string' &&
  ev.turnId !== currentTurn.turnId
) {
  errors = [
    ...errors,
    {
      type: 'tool_result_turn_mismatch',
      message: `tool_result turnId=${ev.turnId} does not match currentTurn=${currentTurn.turnId}; matching by toolUseId=${ev.toolUseId}`,
      ts: now,
    },
  ].slice(-SEMANTIC_ERROR_CAP)
}

const match = Object.entries(currentTurn.blocks).find(
  ([, block]) => block.toolUseId === ev.toolUseId,
)
if (!match) break
```

(Use the exact `SemanticErrorEntry` shape already present in the file — look at the `api_error` / `stream_error` case `:1251-1268` for the canonical field names. If the shape requires a different `type` literal, adjust accordingly.)

- [ ] **Step 2: Unit-test the fall-through path.**

Add (or extend) a test in `src/renderer/src/tiles/workspaceStore.test.ts` (create the file if absent; mirror an existing reducer test if not):

```ts
it('tool_result with mismatched turnId still applies via toolUseId', () => {
  const initial = {
    currentTurn: {
      turnId: 'msg_aaa',
      blocks: {
        0: { blockIndex: 0, kind: 'tool_use', toolUseId: 'toolu_xyz', /* … */ },
      },
      blockOrder: [0],
      /* …fill remaining required SemanticLiveTurn fields */
    },
    history: [],
    errors: [],
    flows: {},
    log: [],
    nextLogId: 0,
  }
  const next = foldSemanticEvent(initial, {
    type: 'tool_result',
    turnId: 'entry-uuid-does-not-match',
    toolUseId: 'toolu_xyz',
    content: 'ok',
    isError: false,
    source: 'jsonl',
  }, 'claude')
  expect(next.currentTurn?.blocks[0].resultAt).toBeDefined()
  expect(next.errors).toHaveLength(1)
})
```

Run:

```bash
npx vitest run src/renderer/src/tiles/workspaceStore.test.ts
```

Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/tiles/workspaceStore.ts src/renderer/src/tiles/workspaceStore.test.ts
git commit -m "fix(semantic): don't drop tool_result on turnId mismatch; match-by-toolUseId always runs"
```

---

## Task 3: Shrink `onSessionScreen` feed-debug spam and reducer cost

The `onSessionScreen` handler (`workspaceStore.ts:1941-2064`) bails early when all four screen fields compare equal (line `:1967-1975`), but the upstream TUI parser in `claude-code-src` lets spinner/cursor/chrome deltas through. The strings differ frame-to-frame even when the user sees a static transcript, so the bail-out doesn't fire and we commit 10k+ STATE updates per session.

Feed does **not** subscribe to `runtime.screen*` (only `DebugPanel.tsx:29-36` and `ReaderView.tsx:155-170` do), so this isn't driving visible re-renders — it's driving reducer work and a 37 MB feed-debug log. The minimum-viable fix is:

1. Detect the "chrome-tick" fingerprint (screen/recent/markdown all "changed" while the **visible length** is unchanged AND no structural change flags — picker, approval — are set).
2. Commit the new strings to `runtime` (DebugPanel still needs them) but **skip** `appendFeedDebugLog`.

This keeps `ReaderView` + `DebugPanel` faithful without bloating the feed-debug stream.

**Files:**
- Modify: `src/renderer/src/tiles/workspaceStore.ts:1941-2064`

- [ ] **Step 1: Add a chrome-tick detector and gate `appendFeedDebugLog`.**

Immediately before the existing `appendFeedDebugLog` call at approximately `:2032`, compute:

```ts
// WHY we split the bail-out into two tiers:
//
// Tier 1 (pre-existing, line 1967-1975): all four screen fields
// compare identical → return prev unchanged. No reducer work, no
// log entry. Catches frames where nothing changed.
//
// Tier 2 (new, here): the strings differ but only by chrome we
// know is transient (spinner glyph, cursor position, blink state).
// Fingerprint: `changed` includes 'screen'/'recent'/'markdown' in
// any combination, `recentLength` is unchanged from the previous
// commit, picker and approval flags are unchanged, and the
// resulting `nextApproval` has not flipped open/closed. Commit the
// new strings to runtime (DebugPanel/ReaderView still need them)
// but skip the feed-debug log line — those 10k+ rows per session
// dominated the feed-debug output and told us nothing a visible
// row didn't already say.
//
// We can't just drop the STATE write because DebugPanel reads
// runtime.screen directly. But we CAN drop the log-append, which
// is pure overhead for this shape of event.
const chromeTickOnly =
  (changed.length === 0 ||
    changed.every(k => k === 'screen' || k === 'recent' || k === 'markdown')) &&
  recent.length === current.recentScreen.length &&
  nextApproval === current.pendingApproval &&
  pickerEqual(current.picker, picker)
```

Then adjust the `appendFeedDebugLog` call to skip the log entry when `chromeTickOnly`:

```ts
const nextBody = {
  ...current,
  screen: plain,
  screenMarkdown: markdown,
  recentScreen: recent,
  recentScreenMarkdown: recentMarkdown,
  picker,
  pendingApproval: nextApproval,
}
const nextCurrent = chromeTickOnly
  ? nextBody
  : appendFeedDebugLog(nextBody, {
      layer: 'STATE',
      kind: 'screen_update',
      summary: `screen update · ${changed.join(', ')}`,
      data: {
        changed,
        pickerVisible: picker.visible,
        pickerCount: picker.items.length,
        approvalOpen: nextApproval !== null,
        recentLength: recent.length,
      },
    })
return {
  ...prev,
  [sessionId]: nextCurrent,
}
```

- [ ] **Step 2: Sanity check with a live session.**

Run `npm run dev`, open a Claude session that involves a streaming tool call (Grep, Bash), open the Feed Debug Panel, keep the **STATE** layer enabled.

Expected:
- Before fix: visible stream of `screen_update` events at ~10/s during any tool execution.
- After fix: `screen_update` events appear only when a real structural change lands (picker opens/closes, approval flips, recent text actually grows). DebugPanel at `Cmd+,` still refreshes at its full rate — confirm it.

Also reload the reproduction session and check the generated feed-debug log:

```bash
wc -l ~/.config/cc-shell/feed-debug/$(ls -t ~/.config/cc-shell/feed-debug/ | head -1)
```

A comparable workload (a couple of turns with a Bash call) should drop from >1 000 lines to a few hundred.

- [ ] **Step 3: Confirm downstream consumers still see fresh screens.**

Open the standalone Debug Panel (`toggle-debug-panel`). Run a streaming tool call. Verify the screen pane re-renders at the SDK's natural rate — the STATE field `runtime.screen` is still being committed on every frame; only the log-append is suppressed.

Open the Reader View. Trigger an assistant streaming turn. Verify the in-progress assistant text appears as normal (`ReaderView.tsx:155-170` reads `runtime.recentScreen`, which Task 3 does not gate).

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/tiles/workspaceStore.ts
git commit -m "perf(feed-debug): skip log-append on chrome-only screen ticks"
```

---

## Task 4: Regression guard — feed-debug log shape assertion

Defect #1 went undetected for weeks because no test exercised the committed-tool_result → semantic-bridge path. Add a small scenario test that uses the feed-debug log shape to assert the invariant "after turn_completed + committed tool_result, `runtime.semantic.currentTurn` is null within one tick."

**Files:**
- Add: `src/renderer/src/tiles/workspaceStore.scenario.test.ts` (new file; if a similar scenario harness already exists, extend it instead)

- [ ] **Step 1: Write the scenario.**

Feed the reducer a synthetic sequence:

1. `turn_started turnId=msg_A`
2. `block_started blockIndex=0 kind=tool_use toolUseId=toolu_A`
3. `block_completed blockIndex=0`
4. `turn_stopped turnId=msg_A stopReason=tool_use`
5. `turn_completed turnId=msg_A`
6. `tool_result toolUseId=toolu_A` **with no turnId field** (matches the Task 1 bridge shape)

Assert:
- After step 5, `currentTurn.turnId === 'msg_A'` (because `hasPendingSemanticTools` is true).
- After step 6, `currentTurn === null` (archived to history).
- `errors` is empty (no turnId mismatch noise when the field is omitted cleanly).

- [ ] **Step 2: Write the mirror scenario for the legacy-bridge case.**

Same sequence, but step 6 carries `turnId: 'entry-uuid-not-msg-A'`. After Task 2's soft guard, assert:
- `currentTurn === null` (archived anyway because toolUseId matched).
- `errors.length === 1` (the soft-log path fired).

- [ ] **Step 3: Run**

```bash
npx vitest run src/renderer/src/tiles/workspaceStore.scenario.test.ts
```

Expected: both scenarios pass. If they don't, Task 1 or Task 2 was incomplete.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/tiles/workspaceStore.scenario.test.ts
git commit -m "test(semantic): regress-guard committed tool_result → currentTurn release"
```

---

## Task 5: Merge check

- [ ] **Step 1: Rebase the worktree onto the current `main` and rebuild.**

```bash
git fetch origin
git rebase origin/main
npm run build && (cd claude-code-headless && npm run build)
```

If the rendering-fixes plan (2026-04-20) has landed in the meantime, confirm:
- `Feed.tsx` no longer contains `shouldSuppressSemanticTurnForCommittedTail` (it should not).
- `workspaceStore.ts:2740-2768` contains the post-bootstrap `reconcileUpstream` pass (rendering-fixes Task 7).
- Our Task 2 soft-guard does not conflict with rendering-fixes Task 6's `codexTurnId` plumbing (they edit different branches of `foldSemanticEvent`).

- [ ] **Step 2: Replay the evidence session.**

Open `3bf116ae-34e7-427a-95cb-9473fb25f697` from the command palette. Scroll to the first `msg_019Ys3…` turn. Observe: no duplicate text at turn boundary. Feed Debug Panel shows the `semantic:msg_019Ys3…` row is removed in the same RENDER diff that adds the committed entries.

- [ ] **Step 3: Open a PR**

```bash
gh pr create --title "fix(claude): duplicate-text at turn boundary + screen_update log churn" --body "$(cat <<'EOF'
## Summary

- Drop the entry-uuid `turnId` from the committed→semantic `tool_result` bridge so `foldSemanticEvent` can match by `toolUseId`. Fixes the duplicate-text flash where the committed assistant entry and the lingering `<SemanticStreamingTurn>` both render until the next turn_started.
- Soften the `foldSemanticEvent` turn_id guard to log-and-fall-through so a future bridge regression can't silently re-open the same class.
- Skip `appendFeedDebugLog` for chrome-only `onSessionScreen` ticks, cutting feed-debug volume ~95% without touching downstream `DebugPanel` / `ReaderView` subscriptions.
- Add scenario tests.

## Test plan

- [ ] Open session `3bf116ae-34e7-427a-95cb-9473fb25f697`, no duplicate assistant-text render at any turn boundary.
- [ ] Stream a Bash tool, confirm feed-debug STATE layer shows `screen_update` only on real structural deltas.
- [ ] `Cmd+,` DebugPanel still refreshes at TUI rate.
- [ ] `npx vitest run src/renderer/src/tiles/workspaceStore*` passes.
- [ ] `npm run build && (cd claude-code-headless && npm run build)` clean.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Rollback plan

All three code changes are narrowly scoped and independent:

- Task 1 is revertible by re-adding `turnId: ev.turnId` at `claudeSession.ts:378`. Defect #1 returns immediately.
- Task 2 is revertible to the original hard guard at `workspaceStore.ts:1057`. Behaviour matches pre-plan exactly (defect #1 masked only by Task 1; if Task 1 is also reverted, defect #1 returns).
- Task 3 is revertible by unconditional `appendFeedDebugLog` call. Feed-debug returns to 10k+ lines/session but behaviour is otherwise unchanged.

No database migrations, no IPC channel changes, no shared-type breakage beyond the optional `turnId` widening in Task 1 Step 2 (which is a strict loosening and safe to leave in even after a revert).
