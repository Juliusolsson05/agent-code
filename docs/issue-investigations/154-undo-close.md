# Issue 154: Extend Undo Close History and Retention

## Issue Summary

GitHub issue #154 asks for Undo Close to behave like a small recovery history instead of a short-lived one-shot affordance. The desired policy is:

- keep the latest 10 restorable pane/tab closes
- retain entries for about 1 hour
- allow repeated `Cmd+Shift+T` and command-palette Undo Close to walk backward through the close stack
- handle stale entries gracefully, ideally without one stale pane anchor blocking older valid entries
- make command/toast copy clear that Undo Close can be used repeatedly

The existing implementation already has the correct broad shape: close actions push entries into an in-memory LIFO `UndoCloseStack`, and `Cmd+Shift+T` / command-palette Undo Close pops the most recent entry. The policy and stale-entry behavior are the main gaps.

## Current Behavior and Relevant Files

### Core stack

- `src/renderer/src/lib/undoClose.ts`
  - Defines `ClosedPane`, `ClosedTab`, `ClosedEntry`, `UndoCloseStack`, `findParentSplitInfo`, and `reinsertPane`.
  - Current constants:
    - `EXPIRY_MS = 2 * 60 * 1000`
    - `MAX_ENTRIES = 20`
  - `UndoCloseStack.push()` prunes expired entries, appends the new entry, then slices to the last `MAX_ENTRIES`.
  - `pop()`, `peek()`, and `length` all lazily prune by `Date.now() - EXPIRY_MS`.
  - The stack is in-memory only. It is created in `src/renderer/src/workspace/hook/refs.ts` with `useRef(new UndoCloseStack())`.

### Close capture paths

- `src/renderer/src/workspace/hook/actions/pane.ts`
  - `closeFocused()` captures pane closes when the closed leaf has a parent split, or captures a whole-tab entry when closing the last pane in a tab.
  - `closeSession()` does the same for caller-specified sessions, such as modal-driven closes.
  - Detached dispatch-only close currently does not push an undo entry. Detached agents are captured only when their owning tab is closed.
  - Toasts currently say `Closed ... - Cmd+Shift+T (Undo Close)`, which implies a single immediate undo more than a history.

- `src/renderer/src/workspace/hook/actions/tab.ts`
  - `closeTab()` captures the tab tree, per-leaf `SessionMeta`, tab index, and detached dispatch agents associated with the tab.
  - The close then kills all grid and captured detached sessions.

### Restore paths

- `src/renderer/src/workspace/hook/actions/undoClose.ts`
  - `undoClose()` calls `refs.undoStackRef.current.pop()` once.
  - Pane restore:
    - finds the current tab containing `entry.siblingLeafId`
    - spawns a new session with provider resume or tmux recovery hints
    - calls `reinsertPane()` to split the surviving anchor leaf and focus the new session
  - Tab restore:
    - respawns each captured grid session
    - remaps the old tree to new session ids
    - inserts a fresh tab at the original tab index, clamped to current bounds
    - respawns captured detached agents and attaches them to the restored tab
  - Important stale behavior: if a pane's `siblingLeafId` no longer exists, the entry is already popped and `undoClose()` returns. That stale entry blocks that invocation and is lost; older valid entries remain in the stack but require another Undo Close command. If `reinsertPane()` fails after spawn, the new session may have been spawned but not inserted.

### Command and shortcut surfaces

- `src/renderer/src/features/workspace/commands/paneCommands.ts`
  - Command `undo-close` is titled `Undo Close`, shortcut `Cmd+Shift+T`.
  - Description says it restores the last closed pane or tab. It does not mention repeated use or bounded history.

- `src/renderer/src/workspace/tile-tree/useKeybinds.ts`
  - Handles `Cmd+Shift+T` and calls `workspace.undoClose()`.

### Test setup

- This repo currently uses script-style tests with `tsx` from `package.json`; there is no Vitest/Jest config in the checkout.
- Existing examples live in `scripts/test-*.ts` and use `node:assert/strict`.
- A focused undo-close test can follow this pattern, e.g. `scripts/test-undo-close.ts` plus an npm script.

## Proposed Implementation Plan

1. Make the retention policy explicit in `src/renderer/src/lib/undoClose.ts`.
   - Change the cap to 10 and retention to 1 hour.
   - Prefer exported names such as `UNDO_CLOSE_MAX_ENTRIES` and `UNDO_CLOSE_RETENTION_MS` so tests and UI copy do not duplicate magic numbers.
   - Add a thick WHY comment explaining that this is deliberately in-memory, bounded, and long enough for cleanup mistakes without promising durable recovery after restart.

2. Add stack testability without broad architecture changes.
   - The simplest path is to let `UndoCloseStack` accept an optional clock function in its constructor, defaulting to `Date.now`.
   - That avoids monkey-patching global `Date.now` and keeps expiry tests deterministic.
   - Keep this local to `undoClose.ts`; no React or IPC code needs to know.

3. Update stale-entry restore behavior in `useUndoCloseAction`.
   - Replace the single `pop()` restore with a small loop that pops until one entry restores successfully or the stack is empty.
   - Treat pane entries whose sibling anchor is gone as stale and continue to the next entry.
   - Consider checking `reinsertPane()` can succeed before spawning, or make failed post-spawn insertion kill/cleanup the just-spawned replacement. The current spawn-before-insert sequence can leak a restored session if the anchor disappears between the pre-check and the state update.
   - For tab entries, keep the existing restore-what-we-can policy. If all spawns fail, continue to the next entry rather than silently consuming the user's Undo Close attempt.

4. Adjust UX copy.
   - Command description should say Undo Close restores the most recent item from a small recent-close history and can be run repeatedly.
   - Toast copy can stay compact but should hint at history, for example `Closed ... - Cmd+Shift+T Undo Close; repeat for earlier closes`.
   - Avoid adding a picker/history UI for this issue unless product scope changes; LIFO matches browser muscle memory and the issue asks whether a picker should be later.

5. Audit retention assumptions for agent and terminal recovery.
   - Claude/Codex panes rely on `providerSessionId` resume, so 1 hour should be acceptable if provider session transcripts remain available.
   - Terminal panes rely on `tmuxName`. Longer undo retention is only useful if `window.api.killSession(id)` does not destroy the tmux session immediately or if the main process keeps a recoverable tmux target for that hour.
   - This needs manual verification because the renderer code only passes `recoverTmuxName`; the tmux lifecycle guarantee lives outside the stack.

## Risk Areas and Open Questions

- Cap policy: issue proposes 10 but asks whether to keep 20. Recommendation: use 10 for now because it matches desired behavior and reduces stale anchors during long cleanup sessions.
- Retention exactness: recommendation is exactly 60 minutes in code, described in UX as "recent" rather than promising a wall-clock SLA.
- Persistence: recommendation is in-memory only for this issue. Persisting close history would require deciding how to validate provider sessions, tmux names, tab ids, and cwd permissions after app restart; that is a larger recovery feature.
- Stale pane anchors: current entries use a surviving sibling leaf id. If that leaf was also closed, the pane entry cannot restore in place. Skipping stale entries is low risk, but fallback insertion into an affinity-matched tab would be a product decision and overlaps with buried-pane revival behavior.
- Spawn-before-insert race: pane undo currently spawns before the `setState` call that rechecks `reinsertPane()`. If the anchor disappears between those steps, the session can be created without being attached to the tree.
- Detached dispatch agents: closing a detached agent directly is not undoable today. Issue text focuses on pane/tab closes; decide separately whether detached-only closes should enter Undo Close history.
- Command visibility: `undoCloseCount` reads `refs.undoStackRef.current.length` but stack mutations do not themselves trigger React renders. Existing close actions also mutate state, so the command palette likely refreshes enough in practice, but policy-only stack changes should not assume the count is reactive.

## Suggested Tests and Manual Verification

### Script tests

Add `scripts/test-undo-close.ts` using `node:assert/strict` and `tsx --tsconfig tsconfig.web.json`.

Cover:

- `UndoCloseStack` keeps only the latest 10 entries.
- Entries expire after 1 hour using an injected clock.
- `pop()` returns valid entries in LIFO order after pruning.
- `findParentSplitInfo()` records the expected side, ratio, direction, and sibling anchor.
- `reinsertPane()` restores beside a surviving anchor.
- `reinsertPane()` returns `null` for a missing anchor without mutating the tree.

### Hook/action tests

If keeping the repo's current script-test style, factor the restore loop into a small pure helper or action-local utility that can be called without React. Cover:

- repeated undo restores multiple entries in order
- a stale pane entry is skipped and the next valid entry is attempted
- an all-failed tab restore does not stop older entries from being attempted

### Manual verification

- Close three panes in one tab, press `Cmd+Shift+T` three times, and confirm panes return in reverse close order.
- Close two tabs, open a new tab in between, then undo twice and confirm restored tabs reinsert near their original indices.
- Close a pane, wait more than 2 minutes but less than 1 hour, and confirm Undo Close still works.
- Close a pane, close its surviving sibling/anchor, then press Undo Close and confirm the stale entry fails gracefully and older valid entries remain reachable or are restored automatically.
- Verify terminal pane recovery after a delayed undo by starting a long-running shell process, closing the terminal pane, waiting, undoing, and confirming tmux-backed state is recovered.
- Verify tab close with detached dispatch agents still restores those agents after the longer retention window.

## Size Assessment

This appears **medium-small**.

The retention/cap policy change is tiny. The meaningful work is making expiry deterministic in tests, updating UX copy, and hardening `undoClose()` so stale entries do not consume a user's recovery attempt or leak a respawned session. It should not require broad state architecture changes unless the team decides Undo Close history must survive app restart or gain a picker UI.
