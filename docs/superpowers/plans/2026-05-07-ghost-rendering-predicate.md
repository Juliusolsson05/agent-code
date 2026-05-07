# Ghost Rendering Predicate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore ghost rendering in the main feed, but only when JSONL has demonstrably stalled past the proxy AND the ghost is not a sidecar-shaped leak. Stops orphan ghosts from piling up at the bottom of feeds (today's regression) without losing the legitimate "JSONL went silent mid-turn" recovery case.

**Architecture:** Layered predicate in `selectMergedEntries`: an orphan ghost renders iff its `_atp.updatedAt` is strictly newer than the newest JSONL entry timestamp this session has observed (`lastJsonlEntryAt`, new field on `SessionRuntime`) AND it does not match the known sidecar shape (single short text block in an assistant turn — title-gen / branch-name / predict-next-prompt fingerprint). Reuses atp's `mergeWithUpstream` for tail placement, which is correct in this case because surviving ghosts are by construction newer than every committed entry. The orphan TTL bumps from 3 s to 30 s so normal slow tool_results don't prematurely flip a ghost to render-eligible.

**Tech Stack:** TypeScript, React 18, Zustand, Electron renderer; cc-shell's `src/renderer/src/workspace/{ghosts,mergedEntries,workspaceState}.ts` and `hook/ipc/useIpcSubscriptions.ts`; `agent-transcript-parser/ghost` for primitives. No atp changes needed.

**Background reading:** [2026-05-07-ghost-system-findings.md](2026-05-07-ghost-system-findings.md) is the long-form analysis of how ghost works today, the four prior fix attempts, and why a single-rule predicate was insufficient. This plan implements the corrected layered predicate that came out of that analysis plus a cross-reading review.

---

## Why two rules, not one

The single-rule timestamp predicate (`updatedAt > lastJsonlEntryAt`) handles "stale orphan from earlier in the session below newer commits" but fails for "sidecar leak after the last real commit." Concretely:

```
real assistant JSONL committed at t=100
predict-next-prompt sidecar at t=105
no further JSONL writes (user walked away)

ghost.updatedAt=105 > lastJsonlEntryAt=100  → predicate would render the sidecar at the tail
```

Production bundles show this is the dominant failure mode (predict-next-prompt fires after every real turn, accumulates at the tail with no later real turn to supersede via the timestamp comparison). So we keep the renderer-side sidecar-shape filter from `2a83978` as a backstop.

Trade-off: a real assistant turn that crashed before any JSONL write AND was a single short text block (e.g. a "Done." reply) would also be hidden. Acceptable — that's a rare invisible loss vs. the everyday clutter of orphan title-gen / predict-next-prompt fragments.

## File structure

| File | Role | Change |
|---|---|---|
| `src/renderer/src/workspace/workspaceState.ts` | Runtime shape + factory | Add `lastJsonlEntryAt: number \| null` field, init `null` in `emptyRuntime()` |
| `src/renderer/src/workspace/hook/ipc/useIpcSubscriptions.ts` | Live JSONL ingest, orphan sweep, ghost reducer wiring | Stamp `lastJsonlEntryAt` from appended entry timestamps; bump `GHOST_ORPHAN_TTL_MS` from 3000 to 30000 |
| `src/renderer/src/workspace/hook/actions/initialHistory.ts` | Bootstrap initial-history pull on resume | Stamp `lastJsonlEntryAt` from loaded entries' timestamps |
| `src/renderer/src/workspace/mergedEntries.ts` | Render-time selector | Replace body with the layered predicate; keep `ghostHasSidecarShape` from `2a83978`; restore `mergeWithUpstream` import |
| `src/renderer/src/workspace/ghosts.ts` | Renderer-side ghost reducer | Comment cleanup (file-level block) — describe ghost's actual job today, not the unfinished Phase 3 framing |
| `src/renderer/src/workspace/tile-tree/TileLeaf.tsx` | Call-site for selector | Comment cleanup — match the new behavior |
| `scripts/test-ghost-fallback.ts` | Existing regression script (no new test files) | Replace assertions with the new predicate's case matrix |

`history.ts` (older-history pagination) is intentionally untouched — prepended entries are by construction older than what's already in `runtime.entries` and must not move `lastJsonlEntryAt` forward.

DO NOT touch:
- `agent-transcript-parser/` — primitives are correct.
- `src/main/ghostJournal.ts`, `src/main/ipc/ghost.ts`, `src/preload/api/ghost.ts` — persistence layer.
- `reconcileUpstream`, `orphanStale`, `gcSupersededGhosts`, `ghostsFromSemanticTurn`, `ghostsToPersist` in `ghosts.ts` — reducers.
- `claudeSession.ts` committed-tool_result bridge — different problem.
- `ClaudeProxyAdapter.isSidecarFlow` and friends — proxy-side filter, complementary.

## Branch + worktree convention

Per `feedback_worktree_default.md` (`~/.claude/projects/.../memory/`), branch work goes in `.worktrees/<name>`. Current state: existing local-only branch `fix/hide-orphan-ghost-tail` was developed on the main checkout, not in a worktree, with provisional changes that this plan supersedes. **Task 0** below moves to a properly-named worktree before code changes start.

Per `reference_gh_account.md`, the cc-shell remote is on `Juliusolsson05`; verify `gh auth status` shows that account before any `gh pr create` step in Task 9.

Per `feedback_no_test_bloat.md`, this plan modifies only `scripts/test-ghost-fallback.ts` (already exists) and does NOT add any new test files or wire any new `test:*` scripts.

Per `feedback_no_auto_merge.md`, Task 9 stops at PR open. Do not auto-merge.

---

## Task 0: Branch hygiene

**Files:**
- No file changes; git operations only.

- [ ] **Step 1: Verify branch state**

Run from repo root:
```bash
git status --short --branch
git branch --show-current
git log --oneline @{u}..HEAD 2>/dev/null || echo "no upstream"
```

Expected: on `fix/hide-orphan-ghost-tail`, with modified files in `scripts/test-ghost-fallback.ts`, `src/renderer/src/workspace/mergedEntries.ts`, and `src/renderer/src/workspace/tile-tree/TileLeaf.tsx`. The "no upstream" output confirms the branch is local-only.

- [ ] **Step 2: Reset the branch back to main and remove old changes**

The provisional v1 changes on this branch are superseded by this plan. Remove them so we start clean.

```bash
git checkout main
git branch -D fix/hide-orphan-ghost-tail
git checkout -- scripts/test-ghost-fallback.ts src/renderer/src/workspace/mergedEntries.ts src/renderer/src/workspace/tile-tree/TileLeaf.tsx 2>/dev/null || true
git status --short
```

Expected: clean working tree, on `main`, only `vendor/in_progress/` and `docs/superpowers/plans/2026-05-07-ghost-system-findings.md` may remain as untracked (those stay).

- [ ] **Step 3: Create worktree on a new branch**

```bash
git worktree add .worktrees/render-stuck-ghosts -b fix/render-stuck-ghosts main
cd .worktrees/render-stuck-ghosts
pwd
```

Expected: print `<repo>/.worktrees/render-stuck-ghosts`. All subsequent steps run from that working directory.

- [ ] **Step 4: Verify gh account**

```bash
gh auth status 2>&1 | head -10
```

Expected: shows `Juliusolsson05` as the active account. If not, switch with `gh auth switch` before any later `gh` step. Don't fix this in Task 9 — fix it now so the rest of the plan is uninterrupted.

---

## Task 1: Add `lastJsonlEntryAt` field to `SessionRuntime`

**Files:**
- Modify: `src/renderer/src/workspace/workspaceState.ts`

- [ ] **Step 1: Add the field to the type**

Open `src/renderer/src/workspace/workspaceState.ts`. Find the `SessionRuntime` type at line 248. Add the new field immediately after the `ghosts` field (currently around lines 379-393). The full field, with a thick WHY comment per project CLAUDE.md:

```ts
  /** Wall-clock ms (epoch) of the newest JSONL entry timestamp we
   *  have observed for this session.
   *
   *  WHY this exists separately from `entries[entries.length-1]`:
   *    Render decisions need a single comparable scalar against
   *    ghost `_atp.updatedAt`. Walking `entries` to find the max
   *    timestamp on every render would be O(N) per call; this is
   *    O(1) read after a single O(burst-size) update at ingest
   *    time. Equally important: the comparison must use entry
   *    *timestamp* (when the event happened on the original
   *    timeline), not `Date.now()`. On resume after a crash, the
   *    most recent JSONL entry might be from yesterday but ghost
   *    `updatedAt` is also from yesterday — both sides need to be
   *    "wall-clock when this was observed by the producer" or the
   *    comparison flips to nonsense.
   *
   *  WHY null instead of 0 for "never seen":
   *    A 0-valued sentinel would make `ghost.updatedAt > 0` always
   *    true, accidentally rendering ghosts on a brand-new session
   *    that has produced nothing yet. Null is checked explicitly
   *    in `selectMergedEntries`.
   *
   *  Used by `selectMergedEntries` (./mergedEntries.ts) to decide
   *  whether an orphaned ghost represents JSONL stalling past the
   *  proxy (render — proxy event is the only record) vs. a sidecar
   *  leak Claude Code never logs to its rollout (hide — JSONL kept
   *  writing real turns past it). See
   *  docs/superpowers/plans/2026-05-07-ghost-system-findings.md
   *  for the full rationale. */
  lastJsonlEntryAt: number | null
  ghosts: Map<string, GhostEntry>
```

(Place `lastJsonlEntryAt` BEFORE `ghosts` to keep the related-render-state fields adjacent — `ghosts` and `lastJsonlEntryAt` are both consumed only by `selectMergedEntries`.)

- [ ] **Step 2: Initialize in `emptyRuntime()`**

Find `emptyRuntime()` at line 425. Add the new field initialization immediately before `ghosts: new Map()`:

```ts
    lastJsonlEntryAt: null,
    ghosts: new Map(),
```

- [ ] **Step 3: Verify TypeScript compiles**

Run:
```bash
npx tsc --noEmit -p tsconfig.web.json 2>&1 | head -30
```

Expected: clean (no new errors). If there are errors about missing `lastJsonlEntryAt` from elsewhere, those callers need updating — note them and add to the relevant tasks below.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/workspace/workspaceState.ts
git commit -m "$(cat <<'EOF'
runtime: add lastJsonlEntryAt to SessionRuntime

Foundation for the ghost-rendering predicate. The field is set in
later commits from the JSONL ingest paths and consumed by
selectMergedEntries to distinguish "JSONL stalled past the proxy"
from "sidecar leak JSONL was never going to write." See
docs/superpowers/plans/2026-05-07-ghost-system-findings.md for the
full design rationale.

No behavior change: nothing reads the field yet.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Stamp `lastJsonlEntryAt` from live JSONL ingest

**Files:**
- Modify: `src/renderer/src/workspace/hook/ipc/useIpcSubscriptions.ts:1102-1190`

- [ ] **Step 1: Locate the runtime patch in `onSessionJsonlEntries`**

Open `src/renderer/src/workspace/hook/ipc/useIpcSubscriptions.ts`. Find the bulk JSONL ingest handler around line 846. Around line 1102, locate the block that builds `baseEntries` and immediately precedes the runtime patch (`const nextRuntimeBase = withDerivedSessionStatus(...)` at ~1171). The `appended` array is fully populated by this point.

- [ ] **Step 2: Insert the timestamp scan**

Immediately after the `baseEntries` calculation (around line 1109, before the "Ghost reconciliation" comment block), insert:

```ts
        // Track the newest JSONL entry timestamp this session has
        // ever observed. selectMergedEntries uses this to decide
        // whether an orphaned ghost is past the JSONL tail (render —
        // proxy stalled past disk) or covered by it (hide —
        // JSONL kept writing past this ghost, so it's a sidecar
        // leak Claude Code never logs to its rollout). Comparison
        // uses entry.timestamp (ISO 8601 on both Claude and Codex
        // entries) NOT Date.now(), because on resume after a crash
        // we want apples-to-apples wall-clock semantics with ghost
        // _atp.updatedAt — both sides represent "when the producer
        // observed this," so a yesterday-vs-yesterday comparison
        // is valid even if "now" is hours later.
        let lastJsonlEntryAt = current.lastJsonlEntryAt
        for (const entry of appended) {
          const ts = (entry as { timestamp?: unknown }).timestamp
          if (typeof ts !== 'string') continue
          const ms = Date.parse(ts)
          if (!Number.isFinite(ms)) continue
          if (lastJsonlEntryAt === null || ms > lastJsonlEntryAt) {
            lastJsonlEntryAt = ms
          }
        }
```

- [ ] **Step 3: Add `lastJsonlEntryAt` to the runtime patch**

Find the `nextRuntimeBase` block at approximately line 1171. Add the new field next to `ghosts: nextGhosts`:

```ts
              ghosts: nextGhosts,
              lastJsonlEntryAt,
```

- [ ] **Step 4: Update the no-change guard**

The no-op short-circuit at ~line 1152-1161 must include the new field — otherwise a JSONL burst that only updates the timestamp (e.g. an entry with no new ghost reconciliation) would silently fail to land. Replace the existing guard:

```ts
        const ghostsChanged = nextGhosts !== current.ghosts
        const noChange =
          appended.length === 0 &&
          reconciledOptimisticText === null &&
          pendingCompaction === current.pendingCompaction &&
          queuedMessages === current.queuedMessages &&
          awaitingAssistant === current.awaitingAssistant &&
          workContext === current.workContext &&
          workActivity === current.workActivity &&
          !ghostsChanged
```

with:

```ts
        const ghostsChanged = nextGhosts !== current.ghosts
        const lastJsonlChanged = lastJsonlEntryAt !== current.lastJsonlEntryAt
        const noChange =
          appended.length === 0 &&
          reconciledOptimisticText === null &&
          pendingCompaction === current.pendingCompaction &&
          queuedMessages === current.queuedMessages &&
          awaitingAssistant === current.awaitingAssistant &&
          workContext === current.workContext &&
          workActivity === current.workActivity &&
          !ghostsChanged &&
          !lastJsonlChanged
```

- [ ] **Step 5: Run build**

```bash
npm run build 2>&1 | tail -20
```

Expected: clean build. The renderer + main + preload all transpile.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/workspace/hook/ipc/useIpcSubscriptions.ts
git commit -m "$(cat <<'EOF'
ipc: stamp lastJsonlEntryAt from live JSONL ingest

Walks each burst's appended entries, parses the entry.timestamp ISO
string, and tracks the max as wall-clock-ms epoch on the runtime.
Fed to selectMergedEntries in a later commit to gate orphan ghost
rendering against the JSONL tail.

No visible behavior change yet: the field is written but no
consumer reads it.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Stamp `lastJsonlEntryAt` from initial-history bootstrap

**Files:**
- Modify: `src/renderer/src/workspace/hook/actions/initialHistory.ts:170-200`

- [ ] **Step 1: Locate the initial-entries patch site**

Open `src/renderer/src/workspace/hook/actions/initialHistory.ts`. Find the `setRuntimes` block around line 114; the runtime patch sets `entries:` around line 194. The `initialEntries` array is fully populated by this point.

- [ ] **Step 2: Insert the timestamp scan and field**

Immediately before the runtime patch (just before the `setRuntimes(prev => { const current = prev[sessionId]; if (!current) return prev; ... })` call's return value), compute the new value. Look for the line that builds the spread:

Find the existing patch (around line 192-198):

```ts
        return {
          ...prev,
          [sessionId]: {
            ...current,
            entries: initialEntries.length > 0
              ? [...initialEntries, ...current.entries]
              : current.entries,
            historyOldestMarker: initialOldestMarker ?? current.historyOldestMarker,
            hasOlderHistory: chunk.hasMore,
```

Insert the timestamp computation BEFORE the `return` statement, in the same `setRuntimes` callback scope:

```ts
        // Bootstrap-load equivalent of the live-ingest stamping in
        // useIpcSubscriptions.ts. selectMergedEntries gates orphan
        // ghost rendering against this timestamp; on resume we need
        // it primed from the loaded JSONL tail so a ghost from the
        // previous session whose updatedAt is OLDER than the
        // freshest JSONL entry stays correctly hidden, while a
        // ghost newer than every loaded entry (the
        // "JSONL-stopped-mid-turn before the previous run died"
        // case) surfaces as expected.
        let lastJsonlEntryAt = current.lastJsonlEntryAt
        for (const entry of initialEntries) {
          const ts = (entry as { timestamp?: unknown }).timestamp
          if (typeof ts !== 'string') continue
          const ms = Date.parse(ts)
          if (!Number.isFinite(ms)) continue
          if (lastJsonlEntryAt === null || ms > lastJsonlEntryAt) {
            lastJsonlEntryAt = ms
          }
        }
```

Then add the field to the returned patch:

```ts
        return {
          ...prev,
          [sessionId]: {
            ...current,
            entries: initialEntries.length > 0
              ? [...initialEntries, ...current.entries]
              : current.entries,
            historyOldestMarker: initialOldestMarker ?? current.historyOldestMarker,
            hasOlderHistory: chunk.hasMore,
            lastJsonlEntryAt,
```

- [ ] **Step 3: Verify history.ts (older-history pagination) is NOT touched**

```bash
grep -n 'lastJsonlEntryAt' src/renderer/src/workspace/hook/actions/history.ts || echo "absent — correct"
```

Expected: "absent — correct". Older-history loads PREPEND entries that are by construction older than `runtime.entries`; touching the timestamp from this path would regress it.

- [ ] **Step 4: Build**

```bash
npm run build 2>&1 | tail -10
```

Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/workspace/hook/actions/initialHistory.ts
git commit -m "$(cat <<'EOF'
bootstrap: stamp lastJsonlEntryAt from initial-history load

Mirrors the live-ingest stamping in useIpcSubscriptions: scans the
loaded JSONL tail, takes the max parseable entry.timestamp.
Necessary so that on resume the ghost-render predicate has the
right comparison anchor against ghost _atp.updatedAt loaded from
disk.

Older-history pagination (history.ts) deliberately does NOT touch
this field — its prepended entries are by construction older than
what's already in runtime.entries.

No visible behavior change yet.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Update `scripts/test-ghost-fallback.ts` for the new predicate (failing first)

**Files:**
- Modify: `scripts/test-ghost-fallback.ts`

This task writes the assertions BEFORE the implementation lands in Task 5. The test will fail until Task 5 is committed.

- [ ] **Step 1: Replace the test file body**

Open `scripts/test-ghost-fallback.ts`. Replace the entire file body (everything below the imports) with the new case matrix. Full file content:

```ts
import assert from 'node:assert/strict'

import {
  createGhost,
  orphanGhost,
  supersedeGhost,
  type ClaudeContentBlock,
  type ClaudeEntry,
} from 'agent-transcript-parser/ghost'

import { orphanStale } from '../src/renderer/src/workspace/ghosts'
import { selectMergedEntries } from '../src/renderer/src/workspace/mergedEntries'
import { emptyRuntime } from '../src/renderer/src/workspace/workspaceState'

// Wall-clock anchor for tests. Concrete values keep the predicate
// inputs explicit and avoid Date.now() drift between assertions.
const T_OLD_JSONL = 1_700_000_000_000
const T_GHOST_NEWER = T_OLD_JSONL + 5_000
const T_GHOST_OLDER = T_OLD_JSONL - 5_000

function baseEntry(uuid: string, timestamp = '2026-04-24T00:00:00.000Z'): ClaudeEntry {
  return {
    type: 'assistant',
    uuid,
    parentUuid: null,
    sessionId: 'session-1',
    timestamp,
    message: {
      id: `msg-${uuid}`,
      role: 'assistant',
      content: [{ type: 'text', text: `committed ${uuid}` }],
    },
  } as ClaudeEntry
}

function ghostWithContent(
  turnId: string,
  content: ClaudeContentBlock[],
  now: number,
) {
  return createGhost({
    sessionId: 'session-1',
    turnId,
    blockIndex: 0,
    role: 'assistant',
    content,
    now,
  })
}

function shortTextGhost(turnId: string, text: string, now: number) {
  return ghostWithContent(turnId, [{ type: 'text', text }], now)
}

function longTextGhost(turnId: string, now: number) {
  // 250 chars — past the SIDECAR_GHOST_TEXT_MAX threshold (200), so
  // the sidecar shape filter will let it through.
  const text = 'A real assistant turn that streamed enough text that it could not be a one-line title-gen sidecar leak. The shape filter is a 200-char cap; this string deliberately blows past that to verify the structural rule applies.'
  return ghostWithContent(turnId, [{ type: 'text', text }], now)
}

function toolUseGhost(turnId: string, now: number) {
  // Tool_use ghosts are explicitly NOT sidecar-shaped (the shape
  // filter only matches single-text-block assistant ghosts), so a
  // tool_use orphan past lastJsonlEntryAt should render even if
  // short.
  return ghostWithContent(
    turnId,
    [
      {
        type: 'tool_use',
        id: `tool-${turnId}`,
        name: 'Read',
        input: { file_path: '/tmp/example.ts' },
      },
    ],
    now,
  )
}

// ---------------------------------------------------------------------------
// 1. Empty ghost map → return entries by identity (reference-stable
//    short-circuit; Feed memos rely on this).
// ---------------------------------------------------------------------------
{
  const runtime = emptyRuntime()
  runtime.entries = [baseEntry('real-1')]
  const merged = selectMergedEntries(runtime, null)
  assert.equal(merged, runtime.entries)
}

// ---------------------------------------------------------------------------
// 2. Ghost not yet orphaned → hidden (JSONL might still arrive
//    within TTL; SemanticStreamingTurn covers the live current
//    turn, this ghost shouldn't double-render).
// ---------------------------------------------------------------------------
{
  const runtime = emptyRuntime()
  runtime.entries = [baseEntry('real-1')]
  runtime.lastJsonlEntryAt = T_OLD_JSONL
  const ghost = longTextGhost('turn-a', T_GHOST_NEWER)
  runtime.ghosts = new Map([[ghost.uuid, ghost]])
  const merged = selectMergedEntries(runtime, null)
  assert.equal(merged, runtime.entries, 'unorphaned ghost must not render')
}

// ---------------------------------------------------------------------------
// 3. Superseded ghost → hidden (JSONL caught up; reconcileUpstream
//    has the row already).
// ---------------------------------------------------------------------------
{
  const runtime = emptyRuntime()
  runtime.entries = [baseEntry('real-1')]
  runtime.lastJsonlEntryAt = T_OLD_JSONL
  const ghost = orphanGhost(
    supersedeGhost(longTextGhost('turn-a', T_GHOST_NEWER), 'real-1', T_GHOST_NEWER + 1),
    T_GHOST_NEWER + 2,
  )
  runtime.ghosts = new Map([[ghost.uuid, ghost]])
  const merged = selectMergedEntries(runtime, null)
  assert.equal(merged, runtime.entries, 'superseded ghost must not render')
}

// ---------------------------------------------------------------------------
// 4. Orphan ghost for the live current turn → hidden.
//    SemanticStreamingTurn owns the live turn render; surfacing a
//    ghost for the same turn would double-render.
// ---------------------------------------------------------------------------
{
  const runtime = emptyRuntime()
  runtime.entries = [baseEntry('real-1')]
  runtime.lastJsonlEntryAt = T_OLD_JSONL
  const ghost = orphanGhost(
    longTextGhost('turn-a', T_GHOST_NEWER),
    T_GHOST_NEWER + 1,
  )
  runtime.ghosts = new Map([[ghost.uuid, ghost]])
  const merged = selectMergedEntries(runtime, 'turn-a')
  assert.equal(merged, runtime.entries, 'current-turn ghost must not render')
}

// ---------------------------------------------------------------------------
// 5. Orphan ghost OLDER than lastJsonlEntryAt → hidden. This is the
//    "stale orphan from earlier in the session, JSONL kept writing
//    past it" case: a sidecar leak that happened before later real
//    JSONL entries. Predicate-4 catches it structurally.
// ---------------------------------------------------------------------------
{
  const runtime = emptyRuntime()
  runtime.entries = [baseEntry('real-1')]
  runtime.lastJsonlEntryAt = T_OLD_JSONL
  const ghost = orphanGhost(
    longTextGhost('turn-a', T_GHOST_OLDER),
    T_GHOST_OLDER + 1,
  )
  runtime.ghosts = new Map([[ghost.uuid, ghost]])
  const merged = selectMergedEntries(runtime, null)
  assert.equal(merged, runtime.entries, 'orphan older than JSONL tail must not render')
}

// ---------------------------------------------------------------------------
// 6. Orphan ghost NEWER than lastJsonlEntryAt with sidecar shape
//    (single short text block, ≤200 chars) → hidden. This is the
//    tail-sidecar case the timestamp predicate alone cannot
//    catch: predict-next-prompt fires after the last real JSONL
//    entry, no later real turn supersedes it. Shape filter is the
//    backstop.
// ---------------------------------------------------------------------------
{
  const runtime = emptyRuntime()
  runtime.entries = [baseEntry('real-1')]
  runtime.lastJsonlEntryAt = T_OLD_JSONL
  const ghost = orphanGhost(
    shortTextGhost('turn-a', 'short ack', T_GHOST_NEWER),
    T_GHOST_NEWER + 1,
  )
  runtime.ghosts = new Map([[ghost.uuid, ghost]])
  const merged = selectMergedEntries(runtime, null)
  assert.equal(merged, runtime.entries, 'sidecar-shaped tail orphan must not render')
}

// ---------------------------------------------------------------------------
// 7. Orphan ghost NEWER than lastJsonlEntryAt with substantive text
//    (>200 chars) → renders. This is the main case ghost was built
//    for: JSONL stopped writing while proxy kept going for an
//    in-flight assistant turn.
// ---------------------------------------------------------------------------
{
  const runtime = emptyRuntime()
  runtime.entries = [baseEntry('real-1')]
  runtime.lastJsonlEntryAt = T_OLD_JSONL
  const ghost = orphanGhost(
    longTextGhost('turn-a', T_GHOST_NEWER),
    T_GHOST_NEWER + 1,
  )
  runtime.ghosts = new Map([[ghost.uuid, ghost]])
  const merged = selectMergedEntries(runtime, null)
  assert.equal(merged.length, 2, 'substantive orphan past JSONL tail must render')
  assert.equal(merged[1]?.uuid, ghost.uuid)
}

// ---------------------------------------------------------------------------
// 8. Orphan tool_use ghost NEWER than lastJsonlEntryAt → renders
//    even though short. tool_use is structurally not a sidecar
//    shape — Claude Code's auxiliary calls all return text-only
//    bodies, never tool_use blocks.
// ---------------------------------------------------------------------------
{
  const runtime = emptyRuntime()
  runtime.entries = [baseEntry('real-1')]
  runtime.lastJsonlEntryAt = T_OLD_JSONL
  const ghost = orphanGhost(
    toolUseGhost('turn-a', T_GHOST_NEWER),
    T_GHOST_NEWER + 1,
  )
  runtime.ghosts = new Map([[ghost.uuid, ghost]])
  const merged = selectMergedEntries(runtime, null)
  assert.equal(merged.length, 2, 'tool_use orphan past JSONL tail must render')
  assert.equal(merged[1]?.uuid, ghost.uuid)
}

// ---------------------------------------------------------------------------
// 9. lastJsonlEntryAt === null (fresh session, no JSONL ever) AND
//    orphan ghost present → render decision falls through the
//    timestamp gate (rule 4 only fires when lastJsonlEntryAt is
//    non-null). The shape filter still applies, so the ghost
//    renders only if it's not sidecar-shaped.
// ---------------------------------------------------------------------------
{
  const runtime = emptyRuntime()
  runtime.entries = [baseEntry('real-1')]
  runtime.lastJsonlEntryAt = null
  const ghost = orphanGhost(
    longTextGhost('turn-a', T_GHOST_NEWER),
    T_GHOST_NEWER + 1,
  )
  runtime.ghosts = new Map([[ghost.uuid, ghost]])
  const merged = selectMergedEntries(runtime, null)
  assert.equal(merged.length, 2, 'orphan with null lastJsonlEntryAt must render if shape passes')
  assert.equal(merged[1]?.uuid, ghost.uuid)
}

// ---------------------------------------------------------------------------
// 10. orphanStale TTL behavior. Confirms the helper still produces
//     reference-stable no-ops and that an orphan flag is set when
//     the threshold elapses.
// ---------------------------------------------------------------------------
{
  const fresh = shortTextGhost('turn-a', 'fresh', T_OLD_JSONL)
  const freshMap = new Map([[fresh.uuid, fresh]])
  assert.equal(orphanStale(freshMap, fresh._atp.updatedAt + 500, 1000), freshMap)

  const staleMap = orphanStale(freshMap, fresh._atp.updatedAt + 2000, 1000)
  assert.notEqual(staleMap, freshMap)
  assert.ok(staleMap.get(fresh.uuid)?._atp.orphanedAt !== undefined)
}

console.log('ghost render predicate tests passed')
```

- [ ] **Step 2: Run the test (it MUST fail at this point)**

```bash
npm run test:ghost-fallback 2>&1 | tail -30
```

Expected: assertion failure on case 7 or 8 (the rendering cases). The current `selectMergedEntries` returns `entries` unconditionally, so cases that expect `merged.length === 2` will fail.

If the test passes here, something is wrong — Task 5 hasn't been done yet so the predicate cannot be returning the expected behavior. Stop and investigate.

- [ ] **Step 3: Commit the failing test**

```bash
git add scripts/test-ghost-fallback.ts
git commit -m "$(cat <<'EOF'
test: spec the ghost-render predicate matrix (currently failing)

10 cases covering the layered predicate: empty/superseded/
unorphaned/current-turn skips, the timestamp gate (orphan older
than JSONL tail = hide), the sidecar shape backstop (tail orphan
with single ≤200-char text block = hide), substantive text
rendering, tool_use rendering (not sidecar-shaped), fresh-session
null-lastJsonlEntryAt path, and orphanStale TTL semantics.

The implementation lands in the next commit (selectMergedEntries
rewrite). Cases 7-9 fail at HEAD because the current selector
returns entries unconditionally.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Implement the layered predicate in `selectMergedEntries`

**Files:**
- Modify: `src/renderer/src/workspace/mergedEntries.ts`

- [ ] **Step 1: Replace the entire file**

Open `src/renderer/src/workspace/mergedEntries.ts`. Replace its entire contents with:

```ts
// Render-time selector: decide which (if any) ghost entries get
// merged into the rendered feed.
//
// -----------------------------------------------------------------------------
// Where ghost rendering fits in cc-shell today
// -----------------------------------------------------------------------------
//
// The live current turn is rendered by `SemanticStreamingTurn`
// directly off `runtime.semantic.currentTurn`, NOT through ghosts.
// JSONL writes catch up within ~100 ms via `reconcileUpstream` and
// supersede the ghost. Most ticks, the ghost map has no rendered
// output here at all.
//
// The one case ghost rendering exists for is JSONL stalling past
// the proxy. Two situations produce that:
//   1. Live-stuck: the agent process gets wedged or its writer
//      backlogs while the proxy keeps emitting events. Eventually
//      the orphan TTL fires and the ghost is the only record of
//      what happened for that turn.
//   2. Resume-after-crash: ghost log on disk has events past the
//      newest JSONL entry; JSONL never caught up before the
//      previous run died. On bootstrap, that ghost surfaces as the
//      lost partial turn.
//
// -----------------------------------------------------------------------------
// The layered predicate
// -----------------------------------------------------------------------------
//
// A ghost is render-eligible iff ALL of:
//   1. Not superseded.
//   2. Orphaned (TTL has elapsed without a JSONL match).
//   3. `turnId !== currentTurnId` (SemanticStreamingTurn owns that).
//   4. `_atp.updatedAt > lastJsonlEntryAt` (proxy state is past the
//      JSONL tail; structurally distinguishes the live-stuck case
//      from "ghost from earlier in the session that JSONL kept
//      writing past").
//   5. Not sidecar-shaped.
//
// Why rules 4 AND 5, not just rule 4:
//   The timestamp predicate is structurally correct for "stale
//   orphan from earlier in the session below newer commits," but
//   it cannot tell apart these two TAIL cases:
//     a) JSONL stopped mid-turn, ghost has the lost partial turn
//        (should render).
//     b) Last real JSONL entry committed at t=100, then a sidecar
//        leak (predict-next-prompt / title-gen / branch-name) at
//        t=105 with no later real turn to supersede it (should
//        NOT render).
//   Both have ghost.updatedAt > lastJsonlEntryAt and produce a
//   tail orphan with no JSONL counterpart. Rule 5 is a structural
//   shape check that matches Claude Code's known sidecar
//   fingerprint: assistant role + single text block + ≤200 chars.
//   Predict-next-prompt with full conversation history can exceed
//   the proxy-side budget predicate, but the response body is
//   short and shaped this way; matching at render time is the
//   backstop.
//
// Trade-off (knowingly accepted): a real assistant turn that
// crashed before any JSONL write AND was a single short text
// block (e.g. "Done.") would also be hidden. In production, that
// loss is rare; the alternative (orphan title-gen / next-prompt
// fragments piling up at the bottom of every session) is a daily
// UX harm. The trade is the same one `2a83978` made; this commit
// keeps the shape filter while adding the timestamp gate that
// `686b94e` was missing.
//
// -----------------------------------------------------------------------------
// Reference stability (load-bearing for Feed memos)
// -----------------------------------------------------------------------------
//
// Feed's row memos key off the `entries` array IDENTITY. When no
// ghost survives the predicate, this selector returns
// `runtime.entries` by identity, NOT a fresh `[...entries]`. The
// pre-fix `mergeWithUpstream` always returned `[...upstream,
// ...trailing]` even when `trailing` was empty, busting memos on
// every tick. atp's `mergeWithUpstream` is only called when
// `visible.size > 0`.
//
// Future work, not done here:
//   Phase 3 of the original headless redesign (delete
//   SemanticStreamingTurn, render the live current turn through
//   ghosts + ordered insertion in `mergeWithUpstream`) requires
//   atp learning to anchor by parentUuid / turnId / nearest
//   committed neighbor instead of always tail-appending. Until
//   that ships, the live current turn stays owned by
//   SemanticStreamingTurn and ghost rendering is reserved for the
//   JSONL-stalled-past-proxy fallback case described above.

import type { Entry } from '@shared/types/transcript'
import type { SessionRuntime } from '@renderer/workspace/workspaceState'
import type { ClaudeContentBlock, GhostEntry } from 'agent-transcript-parser/ghost'
import { mergeWithUpstream } from 'agent-transcript-parser/ghost'

// Cap chosen empirically against debug bundle 2026-05-07T08-26-35
// (max sidecar turn = 41 chars, min real assistant turn = 76
// chars). 200 leaves headroom for slightly-longer next-prompt
// variants and a generous safety margin before we'd start cutting
// into real prose. The same constant lived in mergedEntries.ts at
// commit 2a83978; reused here with the same threshold so the
// regression surface is unchanged.
const SIDECAR_GHOST_TEXT_MAX = 200

function ghostHasSidecarShape(ghost: GhostEntry): boolean {
  // Only assistant orphans match. Sidecars come back through the
  // proxy as assistant streams; user entries don't ghost (they get
  // optimistic-row reconciliation separately) and don't have this
  // failure mode.
  if (ghost.message?.role !== 'assistant') return false
  const content = ghost.message?.content
  if (!Array.isArray(content)) return false
  // Single block. Real assistant turns from a healthy proxy stream
  // nearly always carry at least a tool_use companion or
  // fragmentation across blocks even when short; a lone text block
  // is the title-gen / predict-next-prompt fingerprint.
  if (content.length !== 1) return false
  const block = content[0] as ClaudeContentBlock
  if (block.type !== 'text') return false
  // `text` is required on text blocks per atp's content type, but
  // be defensive — a malformed ghost should not crash the feed
  // selector.
  const text = (block as { text?: unknown }).text
  if (typeof text !== 'string') return false
  return text.length <= SIDECAR_GHOST_TEXT_MAX
}

/**
 * Render-time merge of `runtime.entries` with the surviving ghost
 * set. See the file-level WHY block above for the predicate
 * design.
 */
export function selectMergedEntries(
  runtime: SessionRuntime,
  currentTurnId: string | null,
): Entry[] {
  const { ghosts, entries, lastJsonlEntryAt } = runtime
  if (ghosts.size === 0) return entries

  const visible = new Map<string, GhostEntry>()
  for (const [uuid, ghost] of ghosts) {
    if (ghost._atp.supersededBy !== undefined) continue
    if (ghost._atp.orphanedAt === undefined) continue
    if (currentTurnId !== null && ghost._atp.turnId === currentTurnId) continue
    // Rule 4: only ghosts past the JSONL tail. Null
    // lastJsonlEntryAt (fresh session, never observed any JSONL
    // entry) falls through — rule 5 still applies, and the rest
    // of the predicate (orphaned + non-current) keeps this narrow.
    if (lastJsonlEntryAt !== null && ghost._atp.updatedAt <= lastJsonlEntryAt) continue
    if (ghostHasSidecarShape(ghost)) continue
    visible.set(uuid, ghost)
  }
  if (visible.size === 0) return entries

  // Tail-append is correct for the surviving set: every visible
  // ghost is by predicate-3 not the active turn and by predicate-4
  // newer than every committed entry, so chronologically it
  // belongs at the very end.
  return mergeWithUpstream(entries, visible, {
    trustSupersededFlag: true,
  }) as Entry[]
}

/**
 * Whether Feed should render the live `SemanticStreamingTurn`
 * component. True iff there is a current turn — full stop. The
 * merged feed selector (`selectMergedEntries`) hides ghosts whose
 * `turnId === currentTurnId`, so SemanticStreamingTurn has
 * exclusive ownership of the live view and there is no
 * duplicate-render risk.
 */
export function shouldShowSemanticStreaming(runtime: SessionRuntime): boolean {
  return runtime.semantic.currentTurn !== null
}
```

- [ ] **Step 2: Run the test (must now pass)**

```bash
npm run test:ghost-fallback 2>&1 | tail -10
```

Expected output ends with:
```
ghost render predicate tests passed
```

If any case fails, re-read it; the predicate might be wrong (fix the implementation) or the test might have a typo (fix the test). Don't edit the test to match a buggy implementation.

- [ ] **Step 3: Build**

```bash
npm run build 2>&1 | tail -10
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/workspace/mergedEntries.ts
git commit -m "$(cat <<'EOF'
fix(feed): render orphan ghosts only when JSONL has stalled past proxy

Implements the layered predicate from
docs/superpowers/plans/2026-05-07-ghost-system-findings.md:

  1. not superseded
  2. orphaned (TTL elapsed)
  3. turnId != currentTurnId  (SemanticStreamingTurn owns the live)
  4. updatedAt > lastJsonlEntryAt  (proxy state past JSONL tail)
  5. not sidecar-shaped (≤200-char single text block in
     assistant turn — title-gen / predict-next-prompt fingerprint)

The timestamp gate (rule 4) handles the "stale orphan from earlier
in the session below newer commits" case structurally. The shape
filter (rule 5) is the backstop for the tail-sidecar case where a
sidecar leak fires after the last real JSONL entry and no later
real turn supersedes it via timestamp comparison.

Trade-off (accepted): a real assistant turn that crashed before
any JSONL write AND was a single short text block ("Done.") would
also be hidden. Rare invisible loss vs. daily clutter from orphan
title-gen / predict-next-prompt fragments.

Test cases land in scripts/test-ghost-fallback.ts (modified
in-place; no new test files per project policy).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Bump the orphan TTL

**Files:**
- Modify: `src/renderer/src/workspace/hook/ipc/useIpcSubscriptions.ts:97`

- [ ] **Step 1: Find the constant**

Around line 97 of `src/renderer/src/workspace/hook/ipc/useIpcSubscriptions.ts`:

```ts
const GHOST_ORPHAN_TTL_MS = 3000
const GHOST_ORPHAN_SWEEP_MS = 1000
```

- [ ] **Step 2: Bump TTL and update its comment**

Replace those two lines with:

```ts
// Threshold before an unsuperseded ghost is marked orphaned.
//
// 3000ms was the value used while orphan rendering was always-on
// (commit 686b94e) — the goal was to surface fallback fast. With
// the layered predicate in mergedEntries.ts, an orphan flag merely
// makes a ghost ELIGIBLE for rendering; rules 4 and 5 still gate
// final visibility. So the TTL is now "how long do we wait before
// concluding JSONL had its chance for this ghost," not "how fast
// do we paint." 30000ms matches atp's library default and safely
// covers slow tool_results (large Read, large Bash output, slow
// fetches) without prematurely qualifying a ghost. Sweep cadence
// stays at 1s — that's the polling rate, not the threshold.
const GHOST_ORPHAN_TTL_MS = 30000
const GHOST_ORPHAN_SWEEP_MS = 1000
```

- [ ] **Step 3: Build**

```bash
npm run build 2>&1 | tail -10
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/workspace/hook/ipc/useIpcSubscriptions.ts
git commit -m "$(cat <<'EOF'
ghosts: bump orphan TTL to 30s

3s was set when orphan rendering was always-on and the goal was
"render fallback fast." With the layered render predicate in
mergedEntries.ts, the orphan flag merely qualifies a ghost as
RENDER-ELIGIBLE — rules 4 (timestamp gate) and 5 (shape filter)
still gate final visibility. So the TTL is now "how long before
we conclude JSONL had its chance," not "how fast we paint."

30s matches atp's library default and safely covers slow tool
results (large Read, large Bash, slow fetches) without
prematurely qualifying a ghost mid-turn. Sweep cadence unchanged
at 1s — that's the polling rate.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Comment cleanup — remove stale Phase 3 / "live overlay" framings

**Files:**
- Modify: `src/renderer/src/workspace/ghosts.ts` (file-level block)
- Modify: `src/renderer/src/workspace/tile-tree/TileLeaf.tsx` (call-site)

- [ ] **Step 1: Rewrite `ghosts.ts` file-level block (lines 1-58)**

Open `src/renderer/src/workspace/ghosts.ts`. Replace the file-level block comment (the long block at the top of the file, lines 1-58) with:

```ts
// Renderer-side ghost reducer + the bridge between the live
// semantic stream, the durable JSONL transcript, and disk
// persistence.
//
// -----------------------------------------------------------------------------
// What ghost is in cc-shell today
// -----------------------------------------------------------------------------
//
// Ghost is a parallel disk-backed ledger of semantic events. As
// the proxy stream emits events, this file mints provisional
// `ClaudeEntry` records via atp's `createGhost`. When the
// authoritative JSONL entry lands (Claude's batched 100 ms drain;
// Codex's mpsc flush), `reconcileUpstream` matches by message.id /
// codexTurnId / tool_use_id and supersedes the ghost. If JSONL
// never matches (Claude Code's auxiliary calls — title gen,
// predict-next-prompt, branch-name gen — are not written to the
// rollout), `orphanStale` flags the ghost after the TTL.
//
// The live current turn renders via `SemanticStreamingTurn`
// directly off `runtime.semantic.currentTurn` — NOT through
// ghosts. So most ticks, the ghost map has no rendered output:
// the work this file does is bookkeeping (mint, reconcile,
// orphan, gc, persist) for two consumers:
//
//   1. `selectMergedEntries` (./mergedEntries.ts) — surfaces
//      orphan ghosts ONLY when JSONL has stalled past the proxy
//      (live-stuck mid-turn or resume-after-crash with partial
//      JSONL). The layered predicate there has the full design
//      rationale.
//
//   2. `ghostJournal.ts` (main process) — append-only JSONL log
//      under <userData>/ghost-logs/<sessionId>.ghost.jsonl.
//      Survives reload / restart so the JSONL-stuck case can
//      recover the lost partial turn on resume via the bootstrap
//      merge in src/renderer/src/workspace/hook/actions/session.ts.
//
// -----------------------------------------------------------------------------
// Provider-aware reconciliation
// -----------------------------------------------------------------------------
//
// Claude: upstream assistant entries carry `message.id == turnId`,
// so one upstream entry supersedes every ghost block for that
// turn at once.
//
// Codex: rollout emits one entry per content block, with the
// rollout response_id stamped onto the mapped entry by
// `stampCodexTurnId` in ../codex/rollout.ts. Match is by
// (turnId, blockIndex). When that fails, both providers fall back
// to tool_use_id / call_id pairing for tool blocks.
//
// -----------------------------------------------------------------------------
// Reference stability
// -----------------------------------------------------------------------------
//
// Every reducer below MUST return `prev` unchanged on no-op so
// React memoization holds at the call site. This isn't an
// optimization — it's load-bearing. The pre-fix versions always
// allocated `new Map(prev)` at the top, which made
// `nextGhosts !== current.ghosts` always true downstream, forcing
// a setRuntimes cascade that busted every useMemo([entries]) in
// Feed via selectMergedEntries.
//
// See `agent-transcript-parser/docs/ghost.md` for the underlying
// primitive's semantics, and
// docs/superpowers/plans/2026-05-07-ghost-system-findings.md for
// the longer story of how cc-shell got here.
```

- [ ] **Step 2: Update the `TileLeaf.tsx` call-site comment**

Open `src/renderer/src/workspace/tile-tree/TileLeaf.tsx`. Find the block around lines 333-345 (the comment immediately before `entries={selectMergedEntries(...)}`). Replace it with:

```tsx
          // Committed transcript + (rare) orphan-ghost fallback.
          // The layered predicate in selectMergedEntries renders
          // a ghost only when JSONL has stalled past the proxy
          // AND the ghost is not sidecar-shaped (title-gen /
          // predict-next-prompt fingerprint). The live current
          // turn is owned by `SemanticStreamingTurn` below; the
          // `currentTurnId` argument hides any ghost for that
          // turn so the two surfaces never double-render.
```

Then find the block around lines 363-375 (the comment immediately before `semanticTurn={...}`). Replace it with:

```tsx
          // Live-turn ownership: SemanticStreamingTurn renders
          // the current turn end-to-end off the semantic channel.
          // Ghosts for the same turnId are filtered out of the
          // merged feed by selectMergedEntries (currentTurnId
          // argument), so there is no double-render risk.
          // shouldShowSemanticStreaming collapses to "is there a
          // current turn?".
```

- [ ] **Step 3: Re-run the test (sanity)**

```bash
npm run test:ghost-fallback 2>&1 | tail -5
```

Expected: still passes (comment changes can't break logic).

- [ ] **Step 4: Build**

```bash
npm run build 2>&1 | tail -10
```

Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/workspace/ghosts.ts src/renderer/src/workspace/tile-tree/TileLeaf.tsx
git commit -m "$(cat <<'EOF'
docs: align ghost-system comments with current behavior

Strips the "transcript-first feed with a ghost overlay" / "Phase 3
will delete SemanticStreamingTurn" framings that described an
unfinished plan. Replaces with the actual current behavior:
ghost is a bookkeeping ledger that surfaces in the rendered feed
only when the layered predicate in selectMergedEntries fires
(JSONL stalled past proxy + not sidecar-shaped). The live current
turn is owned by SemanticStreamingTurn directly off the semantic
channel.

No code change. The findings doc at
docs/superpowers/plans/2026-05-07-ghost-system-findings.md has
the long-form rationale.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Final verification

**Files:**
- No file changes; verification only.

- [ ] **Step 1: Run the regression test**

```bash
npm run test:ghost-fallback 2>&1 | tail -5
```

Expected:
```
ghost render predicate tests passed
```

- [ ] **Step 2: Run the full build**

```bash
npm run build 2>&1 | tail -20
```

Expected: clean. Renderer / main / preload all transpile.

- [ ] **Step 3: Quick code-search sanity checks**

Confirm no leftover stale references:

```bash
grep -rn 'Phase 3 will delete SemanticStreamingTurn' src/ packages/ 2>/dev/null
```
Expected: no matches.

```bash
grep -rn 'thin wrapper around atp' src/renderer/src/workspace/mergedEntries.ts
```
Expected: no matches (the new file-level comment is the layered predicate explanation, not the wrapper framing).

```bash
grep -n 'GHOST_ORPHAN_TTL_MS' src/renderer/src/workspace/hook/ipc/useIpcSubscriptions.ts
```
Expected: shows `30000` only.

```bash
grep -n 'lastJsonlEntryAt' src/renderer/src/workspace/workspaceState.ts src/renderer/src/workspace/hook/ipc/useIpcSubscriptions.ts src/renderer/src/workspace/hook/actions/initialHistory.ts src/renderer/src/workspace/mergedEntries.ts
```
Expected: 4+ matches across all four files.

- [ ] **Step 4: Verify history.ts was NOT touched**

```bash
git diff main -- src/renderer/src/workspace/hook/actions/history.ts | head -5
```
Expected: empty (no diff against main).

- [ ] **Step 5: Smoke test in the dev app (manual)**

Run the dev app:

```bash
npm run dev
```

In a Claude session:
1. Send a normal message. Confirm `SemanticStreamingTurn` paints the live response. Confirm no ghost row appears at the bottom of the feed.
2. After the turn completes, confirm no orphan ghost shows. (Title-gen / predict-next-prompt sidecars happen ~5s after each turn — wait 35s and confirm none appear.)
3. Open the FeedDebugPanel (`/cmd toggle-feed-debug-panel`) and confirm `ghost_orphan_sweep` entries fire periodically without the orphan rows appearing in the rendered feed.

Expected: feed stays clean. Live turn renders via SemanticStreamingTurn. No bottom-of-feed ghost clutter.

If you see a real stuck-mid-turn case (rare in normal usage), that's where the predicate WILL render an orphan ghost at the tail. That's correct.

- [ ] **Step 6: Stop the dev app**

`Ctrl-C` the `npm run dev` process.

---

## Task 9: Open the PR

**Files:**
- No file changes; git/gh operations.

- [ ] **Step 1: Verify branch state**

```bash
git status --short --branch
git log --oneline main..HEAD
```

Expected: 7 commits on `fix/render-stuck-ghosts` ahead of `main`. Working tree clean.

- [ ] **Step 2: Push the branch**

```bash
git push -u origin fix/render-stuck-ghosts
```

Expected: push succeeds, sets upstream to `origin/fix/render-stuck-ghosts` on `Juliusolsson05`. If gh / origin is on the wrong account, fix per Task 0 step 4 before retrying.

- [ ] **Step 3: Open the PR**

```bash
gh pr create --title "fix(feed): render orphan ghosts only when JSONL stalls past proxy" --body "$(cat <<'EOF'
## Summary

- Adds a layered predicate to `selectMergedEntries` that renders an orphan ghost iff JSONL has stalled past the proxy (timestamp gate) AND the ghost is not sidecar-shaped (Claude Code title-gen / predict-next-prompt fingerprint backstop).
- Adds `lastJsonlEntryAt` to `SessionRuntime`, stamped from live JSONL ingest and the resume-time initial-history bootstrap.
- Bumps the orphan TTL from 3 s to 30 s — with the new predicate, orphan-ness merely qualifies a ghost as RENDER-ELIGIBLE; rules 4 and 5 still gate visibility, so the TTL semantics are now "how long before we conclude JSONL had its chance," not "how fast we paint fallback."
- Strips stale "Phase 3 will delete SemanticStreamingTurn" / "transcript-first feed with a ghost overlay" comments that described an unfinished plan; comments now match current behavior.

## Why two rules, not one

Production bundles show the dominant orphan-ghost source is Claude Code's auxiliary calls (predict-next-prompt, title-gen, branch-name gen) firing after the LAST real JSONL entry of a session. The timestamp predicate (`updatedAt > lastJsonlEntryAt`) cannot distinguish those from a real stuck-mid-turn ghost — both have `updatedAt` past the JSONL tail. The shape filter (single ≤200-char text block in an assistant turn) is the structural backstop. Trade-off: a real assistant turn that crashed before any JSONL write AND was a single short text block ("Done.") is also hidden. Accepted as the same trade `2a83978` made.

## Background

[docs/superpowers/plans/2026-05-07-ghost-system-findings.md](../tree/main/docs/superpowers/plans/2026-05-07-ghost-system-findings.md) — long-form analysis of how ghost works today, all four prior fix attempts, and why a single-rule predicate was insufficient.

[docs/superpowers/plans/2026-05-07-ghost-rendering-predicate.md](../tree/main/docs/superpowers/plans/2026-05-07-ghost-rendering-predicate.md) — the implementation plan this PR executes.

## Test plan

- [x] `npm run test:ghost-fallback` (10 cases covering the predicate matrix)
- [x] `npm run build`
- [x] Manual smoke in dev: live turn renders via `SemanticStreamingTurn`, no orphan ghosts appear at the bottom of the feed within 35 s of a completed turn (title-gen / predict-next-prompt window)
- [ ] Reviewer: re-read [findings.md §10 case table](../tree/main/docs/superpowers/plans/2026-05-07-ghost-system-findings.md#10-the-actual-edge-case-ghost-was-built-for) and confirm each row is covered by the new predicate

## Out of scope

- atp's `mergeWithUpstream` ordered-insertion (Phase 3 of the original headless redesign). Future work; tracked in findings.md §14.
- Strengthening the proxy-side `isSidecarFlow` predicate for predict-next-prompt — independent improvement, complementary to this renderer-side filter.
- The committed-tool_result bridge in `claudeSession.ts` and its 250 ms quiet-window gate (different problem: bootstrap-replay tool_result spam).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: PR URL printed.

- [ ] **Step 4: Verify and stop**

Print the PR URL for the user. Per `feedback_no_auto_merge.md`, do NOT merge. Hand off.

```bash
gh pr view --json url -q .url
```

---

## Self-review checklist

(For the writing-plans skill's own self-review pass; the human reviewer/cross-reader has their own checklist in findings.md §18.)

- [x] **Spec coverage:** §1 (timestamp gate), §1 (shape filter), §1 (TTL bump), §1 (comment cleanup), §1 (existing-test-only) all covered by Tasks 1-7.
- [x] **No placeholders:** every code block is full content, every command is concrete.
- [x] **Type consistency:** `SessionRuntime.lastJsonlEntryAt` type matches across Task 1 (declaration), Task 2 (read + write), Task 3 (read + write), Task 5 (read). The new field is added to `emptyRuntime()` so existing callers don't break. `ghostHasSidecarShape` signature matches between Task 4 (test, indirect) and Task 5 (definition). `mergeWithUpstream` import added back in Task 5.
- [x] **Branch hygiene:** Task 0 covers worktree creation per project memory. Task 9 stops at PR open per `feedback_no_auto_merge.md`. No new test files per `feedback_no_test_bloat.md`.
- [x] **Verification:** Task 4 specifies test FAILS at HEAD (catches sequence-of-events errors). Task 5 specifies test PASSES post-implementation. Task 8 has explicit grep checks for stale references.
