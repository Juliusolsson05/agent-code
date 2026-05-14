# Fix grid-vs-dispatch divergence for good — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** End the recurring "command/UI walks `tab.root` only, misses Dispatch agents" bug class (PRs #37, #39, #44–46, #58, #59, #69, #83 + issue #104) in **one PR** by (a) shipping a canonical resolver API for "sessions in this tab", (b) migrating every known broken call site to it, and (c) adding a CI check that fails the build if anyone re-introduces the broken pattern outside an explicit allowlist.

**Architecture:** Three layers, one PR. All three are tightly coupled — the migrations don't make sense without the resolvers, and the CI check would either be redundant on its own or block the migrations if shipped separately. The CI check runs against the final tree of this PR, where every existing violation is already migrated, so it lands green from the first run.

**Tech Stack:** TypeScript 5.5, no new runtime dependencies, Bash + GitHub Actions for the CI check. Existing test suite (`npm run test:review-fixes`, `npm run test:work-context`) used for regression verification — no new test files (per repo convention `feedback_no_test_bloat`). The CI check itself is the regression test for this bug class.

**Branch:** `fix/grid-dispatch-divergence`. Worktree at `.worktrees/grid-dispatch-divergence`.

**Out of scope (parked):**
- Branded TypeScript types (e.g. `TabScopedSessionIds`). Documented in #94 as the optional Move 4; revisit only if the CI check proves leaky.
- Renaming `Tab.root` → `Tab._root`. Too invasive; the CI check covers the same goal without a workspace-types churn.
- ESLint setup. The repo has none today; adding it for one rule would be a multi-PR side quest. Grep does the job.

---

## File structure

| File | Role | New / Modified |
|---|---|---|
| `src/renderer/src/workspace/queries.ts` | Canonical resolvers: `resolveTabSessions`, `resolveAllSessions`. Thick WHY comments on each. | **Create** |
| `src/renderer/src/workspace/dispatch/dispatchSelectors.ts` | Doc-comment additions: `@deprecated` tag on `detachedDispatchSessionIdsForTab`, clarifying comment on `dispatchSessionIdsForTab`. No signature changes. | **Modify** |
| `src/renderer/src/workspace/tile-tree/TabBar.tsx` | Delete local `collectSessionIds`, use `resolveTabSessions`. (Issue #104 fix.) | **Modify** |
| `src/renderer/src/features/performance/ui/PerformancePanel.tsx` | Two sites: `useMemo` block + render loop. Both swap `collectLeaves(tab.root)` → `resolveTabSessions(state, tab.id)`. | **Modify** |
| `src/renderer/src/features/workspace/ui/AgentActivityModal.tsx` | Activity rows per session. Swap to `resolveTabSessions`. | **Modify** |
| `src/renderer/src/features/workspace/ui/ReaderView.tsx` | Fallback session list when no Dispatch context. Swap to `resolveTabSessions`. | **Modify** |
| `src/renderer/src/app/App.tsx` | Two sites: owner-tab lookup (mechanical swap to `resolveTabSessions`), and most-recent fallback (non-mechanical — rewrites the fallback shape). | **Modify** |
| `src/renderer/src/features/command-palette/ui/CommandPalette.tsx` | Buried-pane walk gets a `sourceTabId` scope guard. | **Modify** |
| `src/renderer/src/workspace/dispatch/NewAgentPlacementOverlay.tsx` | Detached-attach reads get a `projectTabId` validation. | **Modify** |
| `src/renderer/src/features/workspace/commands/paneCommands.ts` | `detach-to-dispatch` when-guard uses `commandTargetSessionIdForState` instead of `tab.focusedSessionId`. | **Modify** |
| `scripts/check-resolver-discipline.sh` | Bash grep check that fails on forbidden patterns outside the allowlist. | **Create** |
| `.github/workflows/resolver-discipline.yml` | GitHub Actions workflow running the check on every push and PR. | **Create** |

Twelve files total. ~230 lines net change.

---

## Why these decisions

- **Why one PR, not three:** the three layers are tightly coupled. The migrations don't make sense without the resolvers; the CI check would either be redundant (if no resolver exists) or block the migrations (if shipped first). Splitting adds review round-trips without buying anything. One coherent PR with three logical commits on the branch is cleaner.
- **Why a new file `queries.ts` not adding to `dispatchSelectors.ts`:** the resolvers aren't Dispatch-specific; they're the workspace's general session-set queries. Putting them in the dispatch folder would mislead future readers.
- **Why deprecate `detachedDispatchSessionIdsForTab` instead of deleting:** the dispatch UI's bulk-attach call site depends on its specific ordering. Marking deprecated + folding behind `resolveTabSessions` for new callers is safer than rewriting the dispatch UI in the same PR.
- **Why a grep-CI check, not ESLint:** there's no ESLint config in the repo. A 40-line grep script with an explicit allowlist achieves the same enforcement.
- **Why no new tests:** repo convention `feedback_no_test_bloat`. The CI check is the regression test. Existing tests verify no behaviour change.

---

## Tasks

The PR ships as one branch with three logical commits (resolvers → migrations → CI check) for review readability. The three sub-tasks below correspond to those three commits.

### Task 1: Set up worktree + add resolvers + update dispatch selectors doc comments

**Files:**
- Create: `src/renderer/src/workspace/queries.ts`
- Modify: `src/renderer/src/workspace/dispatch/dispatchSelectors.ts`

- [ ] **Step 1: Create the worktree**

```bash
git worktree add /Users/juliusolsson/Desktop/Development/agent-code/.worktrees/grid-dispatch-divergence \
  -b fix/grid-dispatch-divergence main && \
ln -s /Users/juliusolsson/Desktop/Development/agent-code/node_modules \
  /Users/juliusolsson/Desktop/Development/agent-code/.worktrees/grid-dispatch-divergence/node_modules && \
cd /Users/juliusolsson/Desktop/Development/agent-code/.worktrees/grid-dispatch-divergence && \
git submodule update --init --recursive 2>&1 | tail -3
```

Expected: `Preparing worktree…` + 5 submodule checkout lines.

- [ ] **Step 2: Verify clean baseline**

```bash
npm run test:review-fixes 2>&1 | tail -5 && \
npm run test:work-context 2>&1 | tail -3 && \
npm run build:app 2>&1 | tail -3
```

Expected: all three pass. If any fail, STOP — baseline is dirty.

- [ ] **Step 3: Create `src/renderer/src/workspace/queries.ts`**

Write this exact content:

```ts
import { collectLeaves } from '@renderer/workspace/tile-tree/treeOps'
import type {
  SessionId,
  TabId,
  WorkspaceState,
} from '@renderer/workspace/types'

// Canonical session-set queries for the workspace.
//
// WHY this file exists: the workspace has FIVE session-placement
// buckets (grid via tile-tree leaves, detached via
// state.detachedSessions, buried via state.buried, plus pinned +
// focused as cross-cutting attributes). Asking "which sessions are
// in tab X?" without composing the right subset has been the
// recurring root cause of PRs #37, #39, #44, #45, #46, #58, #59,
// #69, #83, and issue #104. Every patch caught an instance; none
// caught the pattern.
//
// The pattern is broken because surfaces reach for `tab.root`
// directly (via collectLeaves) without remembering that detached
// agents also "belong" to the tab via projectTabId. This file is
// the contract: callers should ask their question through one of
// these functions, and the implementation handles the union
// correctly once. Adding a new surface that walks the grid directly
// is — per the resolver-discipline CI check — a build failure.
//
// SCOPE: these queries answer "membership" questions ("which
// sessions are in this tab?"). They do NOT decide which session a
// command targets — that's the focus-resolution concern, handled by
// `commandTargetSessionId` in
// `hook/selectors/commandTargetSessionId.ts`, which already
// correctly composes Dispatch focus → grid focus.

/**
 * Every live session owned by this tab, regardless of placement.
 *
 * Composes:
 *   - grid leaves (collectLeaves(tab.root)) — the visible tile tree
 *   - detached agents whose `projectTabId === tabId` and whose
 *     surface === 'dispatch' — Dispatch Mode agents that live
 *     outside the grid but belong to this project
 *
 * Excludes terminals from the detached side because terminals are
 * always grid by design (Dispatch never holds a terminal).
 *
 * Excludes `state.buried` deliberately: burying a pane is the
 * user's signal to put it away. Surfaces that ask "what's in this
 * tab right now" should not surface buried items as if they were
 * active. The unbury / undo flow is the place to walk
 * `state.buried`.
 *
 * Order: grid leaves first (in depth-first tile-tree order), then
 * detached agents oldest-detached-first (matches the existing UI
 * ordering documented in
 * `dispatchSelectors.detachedDispatchSessionIdsForTab`).
 */
export function resolveTabSessions(
  state: WorkspaceState,
  tabId: TabId,
): SessionId[] {
  const tab = state.tabs.find(t => t.id === tabId)
  const gridIds = tab ? collectLeaves(tab.root) : []
  const detachedIds = Object.values(state.detachedSessions)
    .filter(entry => (
      entry.surface === 'dispatch' &&
      entry.projectTabId === tabId &&
      state.sessions[entry.sessionId] !== undefined &&
      state.sessions[entry.sessionId]?.kind !== 'terminal'
    ))
    .sort((a, b) => a.detachedAt - b.detachedAt)
    .map(entry => entry.sessionId)
  // De-dupe defensively — the types-level invariant says a session
  // is in the tile tree OR detachedSessions, never both, but a
  // future bug that violates that invariant should not silently
  // produce duplicates in callers' filter/count loops.
  const seen = new Set<SessionId>()
  const out: SessionId[] = []
  for (const id of [...gridIds, ...detachedIds]) {
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

/**
 * Every live session in the workspace, across every tab and every
 * placement.
 *
 * Used by surfaces that genuinely operate globally: cross-tab
 * pickers, global telemetry, the "most recent session" finder. For
 * per-tab questions use `resolveTabSessions` instead — passing an
 * `activeTabId` filter on top of this is a code smell that usually
 * means the caller wanted `resolveTabSessions` to begin with.
 *
 * The `state.sessions` map already includes every live session by
 * definition. Iterating it directly is the cleanest implementation;
 * the helper exists for discoverability (so callers don't reach for
 * `Object.keys(state.sessions)` directly and bypass any future
 * filtering or ordering rules this layer adds).
 */
export function resolveAllSessions(state: WorkspaceState): SessionId[] {
  return Object.keys(state.sessions)
}
```

- [ ] **Step 4: Update `dispatchSelectors.ts` doc comments**

Read `src/renderer/src/workspace/dispatch/dispatchSelectors.ts`. Find the existing `dispatchSessionIdsForTab` (around line 84) and `detachedDispatchSessionIdsForTab` (around line 93). Replace those two functions with this exact code (signatures unchanged, only doc comments added):

```ts
/**
 * @deprecated Use `resolveTabSessions` from
 * `@renderer/workspace/queries` instead.
 *
 * This function still exists for the dispatch UI's bulk-attach
 * ordering, which depends on the oldest-first sort here. New
 * callers should use `resolveTabSessions`, which composes grid +
 * detached for the tab.
 */
export function detachedDispatchSessionIdsForTab(
  state: WorkspaceState,
  tabId: TabId,
): SessionId[] {
  return Object.values(state.detachedSessions)
    .filter(entry => (
      entry.surface === 'dispatch' &&
      entry.projectTabId === tabId &&
      state.sessions[entry.sessionId] !== undefined &&
      state.sessions[entry.sessionId]?.kind !== 'terminal'
    ))
    .sort((a, b) => a.detachedAt - b.detachedAt)
    .map(entry => entry.sessionId)
}

/**
 * Dispatch UI's per-tab row list — grid rows + detached rows, with
 * pinned agents stripped because they render in a separate pinned
 * section.
 *
 * WHY this still walks via `buildDispatchGroups` instead of
 * `resolveTabSessions`: the pinned-set exclusion is a UI display
 * concern (the Pinned section renders them exclusively at the top
 * of the Dispatch view; duplicating them in the tab group would
 * create "this is in two places" ambiguity). `resolveTabSessions`
 * deliberately does NOT strip pinned because pinning is a display
 * concern, not a scoping concern. This function preserves the
 * dispatch-UI semantic.
 *
 * Non-dispatch-UI callers asking "which sessions are in this tab?"
 * should use `resolveTabSessions` from
 * `@renderer/workspace/queries`.
 */
export function dispatchSessionIdsForTab(
  state: WorkspaceState,
  tabId: TabId,
): SessionId[] {
  return buildDispatchGroups(state)
    .find(group => group.tab.id === tabId)
    ?.rows.map(row => row.sessionId) ?? []
}
```

- [ ] **Step 5: Verify it still compiles and tests pass**

```bash
npm run test:review-fixes 2>&1 | tail -3 && \
npm run test:work-context 2>&1 | tail -3 && \
npm run build:app 2>&1 | tail -3
```

Expected: all pass. Phase 1 is pure addition — no behaviour changes.

- [ ] **Step 6: Commit the resolver layer**

```bash
git add src/renderer/src/workspace/queries.ts \
  src/renderer/src/workspace/dispatch/dispatchSelectors.ts && \
git commit -m "$(cat <<'EOF'
Add workspace queries.ts — resolveTabSessions, resolveAllSessions

Introduces the canonical resolver layer for "which sessions live in
this tab" — the question that PRs #37 / #39 / #44 / #45 / #46 / #58
/ #59 / #69 / #83 + issue #104 all answered inconsistently. Marks
detachedDispatchSessionIdsForTab as @deprecated steering new callers
to resolveTabSessions. Clarifying doc on dispatchSessionIdsForTab.

Pure addition; call-site migrations follow in the next commit on
this branch.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Migrate every known broken site

**Files:** 8 files, 12 sites. See File structure section.

- [ ] **Step 1: Migrate `TabBar.tsx` (the issue #104 site)**

Read `src/renderer/src/workspace/tile-tree/TabBar.tsx`. Apply these changes:

1. Add to the imports:
   ```ts
   import { resolveTabSessions } from '@renderer/workspace/queries'
   ```
2. Check whether `TileNode` is still used elsewhere in the file. If not, remove `import type { TileNode } from '@renderer/workspace/types'`.
3. Delete the local `collectSessionIds` function (currently lines 23-27 in main).
4. Replace line ~61:
   ```ts
   const sessionIds = collectSessionIds(tab.root)
   ```
   with:
   ```ts
   const sessionIds = resolveTabSessions(state, tab.id)
   ```

After this, the activity counter correctly reflects grid + detached agents (fixes #104).

- [ ] **Step 2: Migrate `PerformancePanel.tsx` (two sites)**

Read `src/renderer/src/features/performance/ui/PerformancePanel.tsx`. There are two `collectLeaves(tab.root)` calls (around lines 26 and 82).

1. Add `import { resolveTabSessions } from '@renderer/workspace/queries'`.
2. Remove `collectLeaves` from the existing `@renderer/workspace/tile-tree/treeOps` import if no other usage remains in the file (grep `collectLeaves` within the file to confirm).
3. At the `useMemo` block (~L26):
   ```ts
   const visibleIds = useMemo(
     () => visible.flatMap(tab => collectLeaves(tab.root)),
     [visible],
   )
   ```
   →
   ```ts
   const visibleIds = useMemo(
     () => visible.flatMap(tab => resolveTabSessions(workspace.state, tab.id)),
     [visible, workspace.state],
   )
   ```
4. At the render loop (~L82): swap `collectLeaves(tab.root)` for `resolveTabSessions(workspace.state, tab.id)`.

- [ ] **Step 3: Migrate `AgentActivityModal.tsx`**

Read `src/renderer/src/features/workspace/ui/AgentActivityModal.tsx`. Find `collectLeaves(tab.root)` around line 119.

1. Add `import { resolveTabSessions } from '@renderer/workspace/queries'`.
2. Remove the `collectLeaves` import if unused after the migration.
3. Swap the call to `resolveTabSessions(state, tab.id)`. Read the surrounding code to use the correct in-scope state variable.

- [ ] **Step 4: Migrate `ReaderView.tsx`**

Read `src/renderer/src/features/workspace/ui/ReaderView.tsx`. Find the fallback session-list `collectLeaves(tab.root)` around line 98. ReaderView already prefers Dispatch rows when in Dispatch Mode; the fallback is the grid-only path. Swap that fallback to `resolveTabSessions(state, tab.id)` so the fallback also covers detached agents.

- [ ] **Step 5: Migrate `App.tsx:325` (owner-tab lookup)**

Read `src/renderer/src/app/App.tsx`. Find the owner-tab lookup at ~L325. Pattern:

```ts
// OLD:
const ownerTab = state.tabs.find(tab =>
  collectLeaves(tab.root).includes(sessionId)
)
// NEW:
const ownerTab = state.tabs.find(tab =>
  resolveTabSessions(state, tab.id).includes(sessionId)
)
```

(Adjust to exact in-scope variable names by reading the file.)

- [ ] **Step 6: Fix `App.tsx:210` (most-recent fallback) — non-mechanical**

Read App.tsx around line 210. Current pattern is roughly:
```ts
const fallback = Object.values(workspace.state.sessions).pop()
```
This can return a detached background agent.

Replace with a tab-scoped fallback:
```ts
const fallback = (() => {
  const activeTab = workspace.activeTab
  if (!activeTab) return null
  if (activeTab.focusedSessionId) return activeTab.focusedSessionId
  return resolveTabSessions(workspace.state, activeTab.id)[0] ?? null
})()
```

(Adjust variable names by reading the file. Intent: the fallback should pick something relevant to the user's active context, not a stale detached one.)

- [ ] **Step 7: Fix `CommandPalette.tsx:200` (buried scope guard) — non-mechanical**

Read `src/renderer/src/features/command-palette/ui/CommandPalette.tsx` around line 200.

```ts
// OLD:
const buried = workspace.state.buried
// NEW:
const activeTabId = workspace.activeTab?.id
const buried = workspace.state.buried.filter(b => b.sourceTabId === activeTabId)
```

(Confirm `sourceTabId` is the right field via `workspace/types.ts:112-132` — the `BuriedPaneRecord` shape.)

- [ ] **Step 8: Fix `NewAgentPlacementOverlay.tsx:89` (detached-attach scope) — non-mechanical**

Read `src/renderer/src/workspace/dispatch/NewAgentPlacementOverlay.tsx` around line 89. Add a `projectTabId` validation before acting on the detached agent:

```ts
const detached = workspace.state.detachedSessions[attachDetachedSessionId]
const activeTabId = workspace.activeTab?.id
if (!detached || detached.projectTabId !== activeTabId) {
  // Cross-project attach: do whatever the existing skip / error
  // path is for this overlay. Read the full function to decide the
  // exact handling — the validation itself is the load-bearing
  // part.
}
const meta = workspace.state.sessions[attachDetachedSessionId]
const kind = meta?.kind
```

- [ ] **Step 9: Fix `paneCommands.ts:162` (focus asymmetry) — non-mechanical**

Read `src/renderer/src/features/workspace/commands/paneCommands.ts` around line 162. The `detach-to-dispatch` when-guard reads `tab.focusedSessionId` directly and misses Dispatch focus.

1. Add the import:
   ```ts
   import { commandTargetSessionIdForState } from '@renderer/workspace/hook/selectors/commandTargetSessionId'
   ```
2. Replace the direct field read with the resolver:
   ```ts
   // OLD:
   const target = workspace.activeTab?.focusedSessionId
   // NEW:
   const target = commandTargetSessionIdForState(workspace.state)
   ```

- [ ] **Step 10: Run the full verification gauntlet**

```bash
npm run test:review-fixes 2>&1 | tail -10 && \
npm run test:work-context 2>&1 | tail -3 && \
npm run build:app 2>&1 | tail -5 && \
git diff main --no-color | grep -ic "cc-shell\|ccshell\|cc_shell"
```

Expected: tests pass, build succeeds, cc-shell count is 0. If any test broke, the migration changed semantic behaviour somewhere — inspect before continuing.

- [ ] **Step 11: Commit the migrations**

```bash
git status --short  # confirm only expected files modified
git add src/renderer && \
git commit -m "$(cat <<'EOF'
Migrate every known broken site to the resolver discipline

Replaces collectLeaves(tab.root) (and equivalent local helpers)
with resolveTabSessions(state, tabId) at every site that asked
"which sessions are in this tab?" and silently meant grid-only.
Also fixes four state-map suspect sites and one focus-asymmetry
site:

  - TabBar.tsx                — activity counter (issue #104)
  - PerformancePanel.tsx (×2) — visible IDs + render loop
  - AgentActivityModal.tsx    — activity rows per session
  - ReaderView.tsx            — fallback session list
  - App.tsx:325               — owner-tab lookup
  - App.tsx:210               — most-recent fallback (non-mechanical)
  - CommandPalette.tsx:200    — buried scope guard
  - NewAgentPlacementOverlay  — detached-attach projectTabId validation
  - paneCommands.ts:162       — focus asymmetry

After this commit, the tab activity counter reflects detached
agents, PerformancePanel covers them in telemetry,
AgentActivityModal lists them, and the most-recent fallback no
longer picks a background detached agent over the active tab's
session.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Add the CI lock + open the PR

**Files:**
- Create: `scripts/check-resolver-discipline.sh`
- Create: `.github/workflows/resolver-discipline.yml`

- [ ] **Step 1: Create the check script**

Write this exact content to `scripts/check-resolver-discipline.sh`:

```bash
#!/usr/bin/env bash
#
# Resolver-discipline CI check.
#
# WHY this script exists: the grid-vs-dispatch session-set
# divergence kept recurring (PRs #37 / #39 / #44 / #45 / #46 / #58
# / #59 / #69 / #83 + issue #104) because surfaces walked `tab.root`
# directly via collectLeaves and forgot to compose with detached
# agents. The fix layer (resolveTabSessions in
# src/renderer/src/workspace/queries.ts) provides the right answer;
# this check is the gate that prevents the pattern from coming
# back. Run on every push and PR.
#
# Allowlist of files where the patterns ARE allowed:
#   - The resolver layer itself.
#   - Tree-mutation code where grid-only is correct by design.
#
# Forbidden patterns:
#   1. collectLeaves(<expr>.root) — walks tab.root directly. New
#      callers should use resolveTabSessions instead.
#   2. state.detachedSessions direct read outside the resolver
#      layer.
#
# If you genuinely need one of these in a new file, add the file to
# the allowlist below with a brief comment explaining why.

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ALLOWED_FILES=(
  # Resolver layer — defines the contract
  "src/renderer/src/workspace/queries.ts"
  "src/renderer/src/workspace/dispatch/dispatchSelectors.ts"
  "src/renderer/src/workspace/sessionOwnership.ts"
  "src/renderer/src/workspace/tile-tree/treeOps.ts"
  "src/renderer/src/workspace/hook/selectors/commandTargetSessionId.ts"
  # Tree mutation — grid-only is correct by design
  "src/renderer/src/workspace/hook/actions/pane.ts"
  "src/renderer/src/workspace/hook/actions/resize.ts"
  "src/renderer/src/workspace/hook/actions/tab.ts"
  "src/renderer/src/workspace/hook/actions/undoClose.ts"
  "src/renderer/src/workspace/hook/actions/initialHistory.ts"
  "src/renderer/src/workspace/hook/actions/history.ts"
  "src/renderer/src/workspace/hook/actions/dispatch.ts"
  "src/renderer/src/workspace/hook/actions/session.ts"
  "src/renderer/src/workspace/hook/actions/tileTabs.ts"
  "src/renderer/src/workspace/hook/persistence/rehydrate.ts"
  "src/renderer/src/workspace/hook/invalidation/effects.ts"
  "src/renderer/src/workspace/layout/helpers.ts"
  "src/renderer/src/workspace/persistence.ts"
  "src/renderer/src/workspace/tile-tree/paneLabels.ts"
  "src/renderer/src/workspace/tile-tree/TileTree.tsx"
  "src/renderer/src/workspace/tile-tree/useKeybinds.ts"
)

build_filter() {
  local pattern=""
  for f in "${ALLOWED_FILES[@]}"; do
    pattern+="$f|"
  done
  echo "(${pattern%|})"
}

FILTER="$(build_filter)"

violations=0

check_pattern() {
  local label="$1"
  local pattern="$2"
  local hits
  hits=$(grep -rn -E "$pattern" \
    --include="*.ts" --include="*.tsx" \
    src/ 2>/dev/null \
    | grep -E -v "$FILTER" || true)
  if [ -n "$hits" ]; then
    echo ""
    echo "❌ Violation: $label"
    echo "$hits"
    violations=$((violations + 1))
  fi
}

check_pattern \
  "collectLeaves walking a .root expression outside the resolver layer" \
  'collectLeaves\(.+\.root\)'

check_pattern \
  "direct state.detachedSessions read outside the resolver layer" \
  '(state|workspace\.state)\.detachedSessions'

if [ "$violations" -gt 0 ]; then
  echo ""
  echo "Found $violations resolver-discipline violation(s)."
  echo ""
  echo "If you need 'every session in this tab' use resolveTabSessions"
  echo "from src/renderer/src/workspace/queries.ts. If your usage is"
  echo "genuinely grid-only by design (e.g. tile-tree mutation), add"
  echo "the file to ALLOWED_FILES in"
  echo "scripts/check-resolver-discipline.sh with a comment explaining"
  echo "why."
  exit 1
fi

echo "✅ Resolver discipline: no violations."
exit 0
```

- [ ] **Step 2: Make the script executable**

```bash
chmod +x scripts/check-resolver-discipline.sh
```

- [ ] **Step 3: Run it against the current tree**

```bash
./scripts/check-resolver-discipline.sh
```

Expected: `✅ Resolver discipline: no violations.` (Task 2 should have cleared every existing violation. If any remain, STOP — Task 2 missed a site; either migrate it or add its file to ALLOWED_FILES with justification.)

- [ ] **Step 4: Create the GitHub Actions workflow**

Write this exact content to `.github/workflows/resolver-discipline.yml`:

```yaml
name: resolver-discipline

on:
  pull_request:
    branches: [main]
  push:
    branches: [main]

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          submodules: false
      - name: Run resolver-discipline check
        run: bash scripts/check-resolver-discipline.sh
```

- [ ] **Step 5: Final verification**

```bash
git diff main --no-color | grep -ic "cc-shell\|ccshell\|cc_shell" && \
npm run test:review-fixes 2>&1 | tail -3 && \
npm run test:work-context 2>&1 | tail -3 && \
npm run build:app 2>&1 | tail -3 && \
./scripts/check-resolver-discipline.sh
```

Expected: cc-shell count 0, tests pass, build succeeds, check passes.

- [ ] **Step 6: Commit the CI lock**

```bash
git add scripts/check-resolver-discipline.sh \
  .github/workflows/resolver-discipline.yml && \
git commit -m "$(cat <<'EOF'
ci: add resolver-discipline check — fail build on grid-only walks

The grid-vs-dispatch session-set divergence kept recurring because
the broken pattern — collectLeaves(tab.root) for "sessions in tab"
— was easy to write and nobody enforced the resolver layer. This
check is the lock: a grep-based CI test that fails the build if
collectLeaves(*.root) or direct state.detachedSessions access
appears outside an explicit allowlist of resolver-layer files.

The allowlist covers the resolver layer itself plus tree-mutation
code where grid-only is correct by design. New violations either
route through resolveTabSessions or get added to the list with a
comment.

After this commit, the bug class is structurally closed — the next
contributor who tries to commit the broken pattern hits a CI
failure with a message pointing at the right resolver.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 7: Push the branch + open the PR**

```bash
gh auth status 2>&1 | head -2  # confirm Juliusolsson05 is active
git push -u origin fix/grid-dispatch-divergence && \
gh pr create --title "Fix grid-vs-dispatch divergence for good — resolver layer, migrations, CI lock" --body "$(cat <<'EOF'
## Summary

Closes the recurring grid-vs-dispatch session-set divergence bug class — PRs #37 / #39 / #44 / #45 / #46 / #58 / #59 / #69 / #83 + issue #104 — in one PR. Three logical commits on the branch:

1. **\`Add workspace queries.ts\`** — new \`resolveTabSessions\` and \`resolveAllSessions\`; @deprecated tag on \`detachedDispatchSessionIdsForTab\`; clarifying doc on \`dispatchSessionIdsForTab\`. Pure addition.
2. **\`Migrate every known broken site\`** — 12 sites across 8 files swapped to the resolver. Fixes #104 and a handful of hidden cousins (PerformancePanel telemetry coverage, AgentActivityModal rows, ReaderView fallback, App owner-tab lookup, most-recent fallback, buried-pane scope leak, detached-attach validation, focus asymmetry).
3. **\`ci: add resolver-discipline check\`** — grep-based CI test that fails the build if \`collectLeaves(*.root)\` or direct \`state.detachedSessions\` access reappears outside the resolver-layer allowlist.

After this PR merges, the bug class is structurally closed: the next contributor who writes the broken pattern hits a CI failure pointing them at the right resolver.

## Design rationale

The recurring bug pattern existed because the resolvers existed but weren't the contract. Authors could (and did) reach past them directly. Mechanical fixes patched instances; nothing patched the pattern. This PR makes the pattern uncommittable by combining (a) a clear resolver API, (b) migrations of every known violation, and (c) a CI gate that fails on regression.

Full design background in [docs/superpowers/plans/2026-05-13-fix-grid-dispatch-divergence.md](../tree/main/docs/superpowers/plans/2026-05-13-fix-grid-dispatch-divergence.md).

## Sites changed (12)

See commit #2's message for the full enumerated list with file:line.

## Why grep instead of ESLint

The repo has no ESLint configuration. Adding ESLint just for one rule would be a multi-PR side quest. A 40-line grep script with an explicit allowlist achieves the same goal — violations fail the build — without any new tooling.

## Test plan

- [x] \`npm run test:review-fixes\` passes
- [x] \`npm run test:work-context\` passes
- [x] \`npm run build:app\` succeeds
- [x] \`./scripts/check-resolver-discipline.sh\` passes locally
- [x] Zero cc-shell strings introduced
- [ ] Manual: open a tab with grid + detached agents → confirm the activity counter shows the union total. Trigger Performance Panel → confirm detached agents appear.
- [ ] CI: the new \`resolver-discipline\` workflow runs and passes on this PR.

## Closes

- Closes #104 (tab activity counter)
- Closes the recurring class of bugs cited in #94 (the audit issue)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)" 2>&1 | tail -2
```

- [ ] **Step 8: Stop. Wait for user merge approval per `feedback_no_auto_merge`.**

---

## Self-review

**Spec coverage:**
- ✅ Resolver API (Task 1)
- ✅ Migrations of every audited broken site (Task 2)
- ✅ CI lock (Task 3)
- ✅ All in one PR with three logical commits.

**Placeholder scan:**
- No "TBD" / "fill in" / "similar to" patterns.
- Every code edit shows the exact diff. The non-mechanical fixes (App.tsx:210, NewAgentPlacementOverlay, paneCommands.ts) instruct the executor to read the surrounding code before applying the intent-described change, because the surrounding variable names may have drifted.

**Type consistency:**
- `resolveTabSessions(state: WorkspaceState, tabId: TabId): SessionId[]` — defined Task 1, used Task 2.
- `resolveAllSessions(state: WorkspaceState): SessionId[]` — defined Task 1; no Task 2 call site (kept in the API surface for future use, documented in plan).
- `commandTargetSessionIdForState(state)` — pre-existing export, used at paneCommands.ts:162 swap.

**Risks acknowledged:**
- `paneLabels.ts` and `resize.ts` were flagged by the audit but are NOT migrated — they're genuinely grid-only by design. Both are in the CI check's allowlist.
- The non-mechanical fixes (App.tsx:210, NewAgentPlacementOverlay) require reading the surrounding code; the plan provides intent and pattern but not always the literal final code, because the surrounding scope can vary. Each non-mechanical step says "read the file first."
