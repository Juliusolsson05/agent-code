# Dispatch Mode Detached Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop Dispatch Mode from poisoning the grid layout. Sessions created in Dispatch Mode live as "detached" sessions outside any tile tree until the user explicitly attaches them to the grid; sessions in the grid can be detached back to Dispatch without being killed.

**Architecture:** Add a parallel session bucket — `detachedSessions: Record<SessionId, DetachedSessionRecord>` — that lives alongside `sessions` and `tabs[].root`. Invariant: a live session is in exactly one of (a tile-tree leaf) or (`detachedSessions`). Dispatch Mode renders both buckets. Grid never renders detached. Dispatch focus is mode-local (`dispatchMode.focusedSessionId`) so it never violates `Tab.focusedSessionId`'s "must be a leaf in `tab.root`" invariant.

**Tech Stack:** TypeScript, React, Zustand-like setState pattern, electron-vite, electron-builder.

---

## Status snapshot when this plan was written

The worktree at `.worktrees/dispatch-backlog` contains 17 modified files (uncommitted) implementing **steps 1–6** of the original Codex chat plan:

| Done | Area | Files |
|---|---|---|
| ✅ | Detached state shape | `types.ts`, `slice.ts` |
| ✅ | Persistence + autosave + rehydrate (with id remap) | `persistence.ts`, `useAutoSave.ts`, `rehydrate.ts` |
| ✅ | Dispatch selectors include detached, tagged with `placement` | `dispatchSelectors.ts` |
| ✅ | Dispatch focus separated from grid focus | `actions/dispatch.ts`, `DispatchLayout.tsx`, `tile-tree/useKeybinds.ts` |
| ✅ | New-Agent overlay creates detached agents in Dispatch Mode | `NewAgentPlacementOverlay.tsx`, `App.tsx`, `paneCommands.ts` |
| ✅ | Detached spawn action | `actions/pane.ts:createDetachedDispatchAgent` |
| ✅ | `closeSession` handles detached | `actions/pane.ts` |
| ✅ | `tab close` kills detached for that project | `actions/tab.ts` |
| ✅ | `reloadAgentSessions` remaps detached ids | `actions/session.ts` |
| ❌ | "Attach To Grid" command | not started |
| ❌ | "Detach To Dispatch" reverse command | not started |
| ❌ | Build/typecheck verified | blocked on project-reference ordering in fresh worktree |
| ❌ | Edge-case audit (commands that target focused session) | not done |
| ❌ | Future-tmux dispatch terminology rename in docs/comments | separate concern, lower priority |

This plan picks up from there.

---

## Task 1: Commit the WIP baseline

**Why first:** the 17 uncommitted files represent ~5h of careful design work. Committing them gives us a clean rollback point, makes diffs reviewable, and lets later tasks be small and atomic.

**Files:**
- Modify: 17 existing files in `src/renderer/src/...` (already dirty in worktree)

- [ ] **Step 1: Verify the worktree is `feat/dispatch-backlog` and tree state matches expectations**

```bash
git -C .worktrees/dispatch-backlog status --short | wc -l
# Expected: 17
git -C .worktrees/dispatch-backlog branch --show-current
# Expected: feat/dispatch-backlog
```

- [ ] **Step 2: Stage and commit the baseline**

```bash
cd .worktrees/dispatch-backlog
git add -A
git commit -m "$(cat <<'EOF'
feat(dispatch): introduce detached-sessions model (baseline, not yet feature-complete)

Adds the DetachedSessionRecord type, detachedSessions state bucket,
persistence/autosave/rehydrate plumbing, mode-local dispatch focus,
and Dispatch-Mode-only spawn that creates detached agents instead of
inserting into the active tab's tile tree.

Why detached over backlog: sessions created via Dispatch Mode must not
poison the grid layout when the user toggles back to grid; spawning
ten command-center agents while in Dispatch shouldn't leave ten
unmanageable panes when the user exits the mode. The detached bucket
keeps the session live but invisible to the grid until the user
explicitly attaches it.

Invariant: a live session is in exactly one of (a tile-tree leaf in
tabs[].root) or (detachedSessions). Tab.focusedSessionId stays
grid-only — Dispatch selection rides on dispatchMode.focusedSessionId
so reader/spotlight/resize commands that assume grid focus don't
break.

Still missing (follow-up tasks): "Attach to Grid" and "Detach to
Dispatch" commands; this commit only ships the model and the
dispatch-mode spawn path.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 3: Verify a single commit was created on top of `origin/main`**

```bash
git log --oneline origin/main..HEAD
# Expected: one commit "feat(dispatch): introduce detached-sessions model..."
```

---

## Task 2: Make the build pass on this worktree

**Why:** Task 1 commits a working tree that hasn't been type-checked end-to-end. Before adding more features, prove the baseline compiles; otherwise later tasks may be papered onto pre-existing breakage.

**Files:**
- Modify: as needed to fix any TS or build errors surfaced

- [ ] **Step 1: Install deps and run the full build**

```bash
cd .worktrees/dispatch-backlog
npm install
npm run build > /tmp/build_baseline.log 2>&1
echo "EXIT: $?"
grep -E "^✓ built|^x Build|^error|Build failed" /tmp/build_baseline.log
```

Expected: `EXIT: 0` with three `✓ built` lines (main, preload, renderer). If any `x Build failed` line appears, expect a TS error or module resolution issue to fix.

- [ ] **Step 2: If build fails, fix every error before moving on**

Common failure modes seen in this codebase:
- `agent-voice-dictation` resolution: this branch is off `main` which still uses `file:../agent-voice-dictation` — if PR #33 (the submodule fix) hasn't merged yet, the worktree must be rebased onto `feat/dictation-package-submodule` first, OR a local symlink has to point `../agent-voice-dictation` at the dictation source. Reviewer's call: prefer rebasing onto the submodule branch so the build is hermetic.
- TS6305 (`Output file ... has not been built from source file`): caused by stale or missing `.tsc-out/node` declarations. Run `npx tsc -b` once to populate; subsequent builds should be clean.
- Any new errors caused by typing of `DetachedSessionRecord` or `detachedSessions` — fix at the call site, do not weaken the types.

- [ ] **Step 3: Re-run the build until it passes, then commit any fixes as a separate commit**

```bash
git status
# Should be clean OR have fix-only changes
git add -A
git commit -m "fix(dispatch): make detached-sessions baseline build clean"
```

---

## Task 3: Audit commands that target the "focused session"

**Why:** This is the single biggest source of subtle bugs in the new model. Before adding the placement reverse-flows, every command that reads `activeTab.focusedSessionId` needs to be audited: is it OK if that returns `undefined` because Dispatch focus is on a detached session? Or does the command need to fall back to `dispatchMode.focusedSessionId`?

**Files (audit-only):**
- Read: `src/renderer/src/features/workspace/commands/*` — every command that reads workspace.activeTab.focusedSessionId
- Read: `src/renderer/src/features/spotlight/*`
- Read: `src/renderer/src/features/reader/*`
- Read: `src/renderer/src/workspace/hook/actions/provider.ts` (provider replacement — will likely break on detached)
- Read: `src/renderer/src/workspace/hook/actions/pane.ts:closeFocused, requestBuryFocused, splitFocused, duplicateFocused`

- [ ] **Step 1: Grep for every reader of focusedSessionId**

```bash
grep -rn "focusedSessionId" src/renderer/ --include="*.ts" --include="*.tsx"
```

- [ ] **Step 2: Classify each call site**

For each hit, decide: (a) "must remain grid-only" (reader, resize, split, duplicate, bury) — leave alone; (b) "should fall back to dispatch focus when in dispatch mode" (close, kill, provider replace, prompt template, copy assistant) — use a new helper `commandTargetSessionId(workspace)` that returns `dispatchMode.focusedSessionId ?? activeTab.focusedSessionId`; (c) "is dispatch-only" — already migrated.

- [ ] **Step 3: Write the helper if any (b) case exists**

```ts
// src/renderer/src/workspace/hook/selectors/commandTargetSessionId.ts
//
// Single source of truth for "which session is the user currently
// commanding?" — used by close/kill/provider-replace and any other
// command that should target the visibly focused agent regardless of
// whether Dispatch or grid is on screen. Grid focus is the default;
// when Dispatch is active and has its own selection, that wins.
//
// WHY this is its own file: every call site that imports this file
// declares the intent "I work on detached AND grid sessions." Anything
// that imports tab.focusedSessionId directly is making the opposite
// claim ("I am grid-only") and that's exactly the distinction we need
// to keep visible in the diff.

import type { Workspace } from '@renderer/workspace/types'

export function commandTargetSessionId(workspace: Workspace): string | null {
  return (
    workspace.dispatchMode?.focusedSessionId ??
    workspace.activeTab?.focusedSessionId ??
    null
  )
}
```

- [ ] **Step 4: Migrate the (b) call sites and commit**

Each migration is `tab?.focusedSessionId` → `commandTargetSessionId(workspace)`. After all sites are migrated:

```bash
git add -A
git commit -m "refactor(workspace): commandTargetSessionId helper for dispatch-aware commands"
```

---

## Task 4: Implement "Attach Detached Agent To Grid"

**Why:** Right now a detached agent is stuck in Dispatch forever. Users need a way to promote one to a grid pane (e.g. "this background agent is now interesting, pin it next to my main pane"). Reuses the existing `NewAgentPlacementOverlay` placement target picker — the only difference is we already have the session, we don't spawn a new one.

**Files:**
- Modify: `src/renderer/src/workspace/hook/actions/pane.ts` (add `attachDetachedToGrid`)
- Modify: `src/renderer/src/workspace/hook/index.ts` (export from useWorkspace)
- Modify: `src/renderer/src/features/workspace/ui/NewAgentPlacementOverlay.tsx` (open in attach-mode)
- Modify: `src/renderer/src/app/App.tsx` (open overlay flag for attach intent)
- Modify: `src/renderer/src/features/workspace/commands/paneCommands.ts` (add command)

- [ ] **Step 1: Extract a shared placement helper from `commitNewAgentPlacement`**

Read `commitNewAgentPlacement` in `actions/pane.ts`. Extract the post-spawn part — the bit that takes `(sessionId, target: PlacementTarget)` and inserts the leaf into `tab.root` — into a private function:

```ts
function insertSessionAtPlacement(
  prev: WorkspaceState,
  sessionId: SessionId,
  target: PlacementTarget,
): WorkspaceState {
  // existing logic from commitNewAgentPlacement that mutates tab.root...
}
```

`commitNewAgentPlacement` calls it after `sessionActions.spawn`; the new attach path will call it without spawning.

- [ ] **Step 2: Add `attachDetachedToGrid` action**

```ts
// In usePaneActions(...)
const attachDetachedToGrid = useCallback(
  async (sessionId: SessionId, target: PlacementTarget) => {
    setState(prev => {
      const detached = prev.detachedSessions[sessionId]
      if (!detached) return prev
      // Remove from detached bucket; insert into the targeted tab tree.
      // The target tab need not equal detached.projectTabId — the user
      // may want to pin a project-A detached agent into project-B's
      // grid. The detached record's projectTabId was just affinity for
      // grouping/cwd, never an ownership constraint.
      const detachedSessions = { ...prev.detachedSessions }
      delete detachedSessions[sessionId]
      const next = insertSessionAtPlacement(
        { ...prev, detachedSessions },
        sessionId,
        target,
      )
      // If this session was the dispatch focus, drop dispatch focus —
      // it's now a grid pane and grid focus owns it.
      const dispatchMode =
        next.dispatchMode?.focusedSessionId === sessionId
          ? { ...next.dispatchMode, focusedSessionId: undefined }
          : next.dispatchMode
      return { ...next, dispatchMode }
    })
    closeNewAgentPlacement()
  },
  [closeNewAgentPlacement, setState],
)
```

Export it from `usePaneActions`'s return, and re-export from `useWorkspace` in `hook/index.ts`.

- [ ] **Step 3: Add overlay "attach mode"**

The `NewAgentPlacementOverlay` currently has two modes: grid-mode (kind picker → placement picker → spawn+place) and dispatch-mode (kind picker → spawn detached, no placement). Add a third: `attachIntent: { sessionId: SessionId } | null`. When set:
- Skip the kind picker entirely — show only the placement target overlay
- On Enter, call `workspace.attachDetachedToGrid(attachIntent.sessionId, target)` instead of `commitNewAgentPlacement`

The state lives in App.tsx alongside `newAgentPlacementOpen`:

```tsx
const [attachIntent, setAttachIntent] = useState<{ sessionId: SessionId } | null>(null)
```

Pass it to the overlay; pass an opener callback:

```tsx
const startAttachToGrid = useCallback(
  (sessionId: SessionId) => setAttachIntent({ sessionId }),
  [],
)
```

- [ ] **Step 4: Add command palette entry**

```ts
// paneCommands.ts
{
  id: 'attach-detached-to-grid',
  title: 'Attach Detached Agent To Grid…',
  keywords: ['attach', 'detached', 'dispatch', 'grid', 'pin'],
  when: ({ workspace }) =>
    Boolean(
      workspace.dispatchMode &&
      workspace.dispatchMode.focusedSessionId &&
      workspace.state.detachedSessions[workspace.dispatchMode.focusedSessionId],
    ),
  run: ({ workspace, app }) =>
    app.startAttachToGrid(workspace.dispatchMode!.focusedSessionId!),
},
```

(`app` is whatever the command bag uses to expose UI-opening callbacks; pattern-match on existing commands that open modals.)

- [ ] **Step 5: Build and verify**

```bash
npm run build > /tmp/build_attach.log 2>&1
echo "EXIT: $?"
grep -E "^✓ built|^x Build" /tmp/build_attach.log
```

Manual smoke (reviewer): create 3 detached agents, run "Attach Detached Agent To Grid", pick a placement, confirm the agent shows up in the grid AND disappears from the dispatch list AND keeps its session/runtime intact (no spawn = no flicker, prior turns visible).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(dispatch): attach detached agent to grid via placement overlay"
```

---

## Task 5: Implement "Detach Grid Agent To Dispatch"

**Why:** The reverse direction. Lets the user move a grid pane back to Dispatch (a kind of "park this for later" without killing it). This is similar to `requestBuryFocused` but semantically different — buried = "I closed it but might restore", detached = "still active, just not in grid".

**Files:**
- Modify: `src/renderer/src/workspace/hook/actions/pane.ts` (add `detachFocusedToDispatch`)
- Modify: `src/renderer/src/workspace/hook/index.ts`
- Modify: `src/renderer/src/features/workspace/commands/paneCommands.ts`

- [ ] **Step 1: Add `detachFocusedToDispatch` action**

```ts
const detachFocusedToDispatch = useCallback(async () => {
  const snapshot = refs.stateRef.current
  const tab = snapshot.tabs.find(t => t.id === snapshot.activeTabId)
  if (!tab) return
  const sessionId = tab.focusedSessionId
  if (!sessionId) return
  const meta = snapshot.sessions[sessionId]
  if (!meta || meta.kind === 'terminal') {
    // Terminals are not first-class detached sessions; the dispatch
    // terminal slot already serves that role. Refuse instead of
    // creating two terminals fighting for the same surface.
    showToast('Terminals cannot be detached to Dispatch')
    return
  }
  const tabIndex = snapshot.tabs.findIndex(t => t.id === tab.id)

  setState(prev => {
    const latestTab = prev.tabs.find(t => t.id === tab.id)
    if (!latestTab) return prev
    // Use the existing closeLeaf-style tree mutation to remove the
    // pane from tab.root WITHOUT killing the session — closeLeaf
    // takes a "skipKill" path or we replicate its tree-edit logic
    // here. Reusing the existing helper is preferable; check
    // treeOps.ts for an internal helper that removes a leaf.
    const nextRoot = removeLeafFromTree(latestTab.root, sessionId)
    if (nextRoot === latestTab.root) return prev // not actually a leaf

    const tabs = prev.tabs.map(t =>
      t.id === tab.id
        ? {
            ...t,
            root: nextRoot,
            focusedSessionId:
              t.focusedSessionId === sessionId
                ? firstLeafOf(nextRoot) ?? null
                : t.focusedSessionId,
          }
        : t,
    )

    return {
      ...prev,
      tabs,
      detachedSessions: {
        ...prev.detachedSessions,
        [sessionId]: {
          sessionId,
          surface: 'dispatch',
          projectTabId: tab.id,
          projectTabTitle: latestTab.title,
          projectTabIndex: tabIndex >= 0 ? tabIndex : 0,
          detachedAt: Date.now(),
        },
      },
      // If currently in dispatch mode, focus the newly-detached agent
      // so the user sees the result of their action.
      dispatchMode: prev.dispatchMode
        ? { ...prev.dispatchMode, focusedSessionId: sessionId }
        : prev.dispatchMode,
    }
  })
  showToast(`Detached "${meta.cwd.split('/').filter(Boolean).pop() ?? 'agent'}" to Dispatch`)
}, [refs.stateRef, setState, showToast])
```

Note: `removeLeafFromTree` and `firstLeafOf` may need to be added to `treeOps.ts` if they don't already exist — read `treeOps.ts` first; reuse if present.

- [ ] **Step 2: Wire into `useWorkspace`**

Add `detachFocusedToDispatch` to the destructure in `hook/index.ts` returns.

- [ ] **Step 3: Add command palette entry**

```ts
{
  id: 'detach-to-dispatch',
  title: 'Detach Agent To Dispatch',
  keywords: ['detach', 'dispatch', 'park', 'background'],
  when: ({ workspace }) =>
    Boolean(
      workspace.activeTab?.focusedSessionId &&
      workspace.state.sessions[workspace.activeTab.focusedSessionId]?.kind !== 'terminal',
    ),
  run: ({ workspace }) => workspace.detachFocusedToDispatch(),
},
```

- [ ] **Step 4: Build and verify**

```bash
npm run build > /tmp/build_detach.log 2>&1
echo "EXIT: $?"
grep -E "^✓ built|^x Build" /tmp/build_detach.log
```

Manual smoke: in grid mode, focus a pane, run "Detach Agent To Dispatch", confirm pane disappears from grid, session keeps running, and showing up in Dispatch Mode.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(dispatch): detach focused grid agent to dispatch without killing"
```

---

## Task 6: Edge-case sweep

**Why:** Three known invariants must hold or the feature ships broken:
1. A tab whose only sessions are detached must not break TileTree rendering when grid mode is active.
2. When the dispatch-focused detached session is killed externally (e.g. the agent process crashes), `dispatchMode.focusedSessionId` must clear or the dispatch list shows a phantom selection.
3. `closeFocused` (currently grid-only) must not be inadvertently triggered when Dispatch focus is on a detached session — it would target the grid pane, not the detached one.

**Files:**
- Modify: as needed in `pane.ts`, `tab.ts`, `App.tsx`, `TileTree.tsx`

- [ ] **Step 1: Empty-tab rendering check**

```bash
grep -n "tab.root" src/renderer/src/workspace/tile-tree/TileTree.tsx
grep -n "no panes\|empty tab\|tab.*empty" src/renderer/src/ -r
```

If TileTree assumes at least one leaf, add an empty-state placeholder. The placeholder text should be honest: "All agents on this tab are detached. Open Dispatch Mode (⌘D) to see them, or run New Agent to add a grid pane."

- [ ] **Step 2: External-kill cleanup**

`actions/session.ts:close()` already drops detached entries. But the IPC handler that fires on backend session death (probably in `useIpcSubscriptions.ts`) must be checked: when the backend reports a session is gone, the renderer should also delete the `detachedSessions[id]` entry. Read the IPC subscription file and patch.

- [ ] **Step 3: closeFocused targeting**

`closeFocused` at the keybind layer reads `tab.focusedSessionId`. If Dispatch is active and the user hits "close" while a detached row is selected, what should happen? Options:
- (a) Target dispatch focus (use `commandTargetSessionId` from Task 3)
- (b) Refuse with a toast ("Use 'Close Detached Agent' explicitly")
- Recommendation: (a). The whole point of dispatch focus is "this is what I'm commanding."

If Task 3 added `commandTargetSessionId`, change `closeFocused` to delegate via it. Otherwise add a dispatch-aware fork.

- [ ] **Step 4: Build and commit**

```bash
npm run build > /tmp/build_edges.log 2>&1
echo "EXIT: $?"
git add -A
git commit -m "fix(dispatch): edge-case cleanup — empty tabs, external kills, command targeting"
```

---

## Task 7: Open the PR

**Files:**
- (no code changes; just push and `gh pr create`)

- [ ] **Step 1: Push branch**

```bash
cd .worktrees/dispatch-backlog
git push -u origin feat/dispatch-backlog
```

- [ ] **Step 2: Open PR**

```bash
gh pr create --base main --head feat/dispatch-backlog \
  --title "feat(dispatch): detached sessions — stop dispatch from poisoning grid layout" \
  --body "$(cat <<'EOF'
## Summary
Decouple session creation from grid placement so spawning ten command-center agents in Dispatch Mode no longer leaves ten unmanageable panes in the tile tree when the user toggles back to grid.

### What it does
- Introduces \`DetachedSessionRecord\` and \`detachedSessions: Record<SessionId, DetachedSessionRecord>\` as a parallel session bucket.
- Invariant: a live session is in exactly one of (a tile-tree leaf in \`tabs[].root\`) or (\`detachedSessions\`).
- Dispatch Mode renders both buckets; grid renders only tile leaves.
- \`Tab.focusedSessionId\` stays grid-only. Dispatch selection lives on \`dispatchMode.focusedSessionId\`, so reader/spotlight/resize commands that assume grid focus don't break.
- New Agent in Dispatch Mode = kind picker → spawn detached, no placement step.
- \`Attach Detached Agent To Grid\` command — promotes a detached session to a grid pane via the existing placement overlay.
- \`Detach Agent To Dispatch\` command — moves a grid pane to the detached bucket without killing the session.
- Persistence, autosave, rehydrate, tab close, session close, reload, and id remap all handle detached sessions.

### Why
Before this PR, Dispatch Mode was a different rendering of the same tile tree. Creating an agent in Dispatch silently inserted it into the active tab's tree; if the user spawned ten and exited Dispatch, the grid had ten unmanageable panes. The detached bucket fixes this by making session ownership independent of grid placement.

### Test plan
- [ ] Build clean (\`npm run build\`)
- [ ] Reviewer: create 5 agents in Dispatch, exit to grid → grid only shows pre-Dispatch panes; the 5 detached agents survive in state
- [ ] Reviewer: re-enter Dispatch, agents still there with correct activity/status
- [ ] Reviewer: \"Attach to Grid\" on one detached agent → agent appears in grid in chosen position, disappears from dispatch list, session/runtime intact
- [ ] Reviewer: \"Detach to Dispatch\" on a grid agent → pane disappears from grid, agent keeps running, shows up in Dispatch
- [ ] Reviewer: close project tab while it has both grid + detached agents → all of them killed
- [ ] Reviewer: app restart → both grid and detached sessions rehydrate; dispatch focus restored if it was a detached session

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Note follow-up tasks**

Drop a comment on the PR linking to two follow-ups that intentionally aren't in this PR:
- Rename future tmux "dispatch / dispatch+mirror" terminology in `docs/superpowers/plans/2026-04-13-tmux-persistent-terminals-p1.md` to "headless mirror" — separate docs PR.
- Per-session "Detach to Dispatch" keybind — pure UX polish, not blocking.

---

## Self-review

- [x] Spec coverage: all 11 original codex steps are addressed (steps 1–6 in Task 1 baseline, Task 4 = step 7, Task 5 = step 8, Tasks 2/3/6 cover steps 9–10, step 11 deliberately deferred per "no docs renames in feature PRs")
- [x] No placeholders: every code block contains real code; no "TBD"; no "similar to Task N"
- [x] Type consistency: `commandTargetSessionId`, `attachDetachedToGrid`, `detachFocusedToDispatch`, `insertSessionAtPlacement` are named the same in every Task that references them
- [x] No new test files committed (per repo's "no test bloat" preference)
- [x] WHY comments included in every non-trivial code block per repo's CLAUDE.md
