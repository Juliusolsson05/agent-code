# Dispatch Shell Cleanup Implementation Log

Branch: `cluster/dispatch-shell-cleanup`

Date: 2026-06-24

## Implemented

- Added strict Dispatch visual target semantics in `src/renderer/src/workspace/dispatch/dispatchTarget.ts`.
  - `commandTargetSessionIdForState` now uses strict Tiled-lane targeting while Dispatch is active.
  - Empty or stale focused Tiled lanes now return no command target instead of falling back to classic focus, grid focus, or row 1.
  - `closeFocused` uses the same strict command target and no-ops in Dispatch when no strict target exists.
- Threaded attach intent as `{ sessionId, targetTabId }`.
  - `openDispatchAttach` captures the visible row's tab id.
  - `NewAgentPlacementOverlay` builds placement targets from that captured tab.
  - `attachDetachedToGrid` mutates the explicit target tab and moves `activeTabId` to that tab as an explicit focus transition.
- Made linked-agent creation Tiled-lane aware.
  - Captures the focused lane before async spawn.
  - Reuses `applyDispatchSpawnFocus` so the newly linked child replaces the command lane and classic focus together.
- Added Tiled lane cleanup helpers.
  - `keepTiledLaneSessions` sanitizes lane ids at the autosave ownership boundary.
  - `nextTiledRowIndex` fixes Up/Down behavior from empty or stale lanes.
- Cleaned command/settings shell findings.
  - Removed dead Escape ternary.
  - Exported and reused the shared command-palette `fuzzyMatch`.
  - Removed unused `SettingsList.onChange` prop.
  - Removed orphaned `:settings` localStorage reader and `APP_SETTINGS_STORAGE_KEY`; settings now seed defaults and hydrate through the zustand persist store.
- Deleted confirmed dead files and stale references.
  - Deleted `src/shared/runtime/ptyScreen.ts`.
  - Deleted `src/shared/runtime/jsonlTailer.ts`.
  - Deleted `src/shared/work-context/reducer.ts`.
  - Removed the stale `ptyScreen` comment in `claudeSession.ts`.
  - Reworded `streamJsonl.ts` so it points at package-owned live tailers.
  - Removed broken `proxy-demo` script pointing at missing `experiments/`.
- Consolidated verified `asRecord` copies.
  - `ghosts.ts`, `codexResumeSanitizer.ts`, and `AgentTranscriptReader.ts` now import the canonical shared helper.
  - The Codex resume sanitizer now rejects arrays consistently with the shared contract.

## Confirmation Searches Before Deletion

Before deleting shared runtime/work-context files, ran:

```sh
rg -n 'ptyScreen|PtyScreen' --glob '!node_modules' --glob '!*.md'
```

Result summary: only `src/shared/runtime/ptyScreen.ts` and the stale `src/providers/claude/runtime/claudeSession.ts` comment referenced the symbol.

```sh
rg -n 'jsonlTailer|tailSessionFile|tailNewSessionFile' --glob '!node_modules' --glob '!*.md'
```

Result summary: only `src/shared/runtime/jsonlTailer.ts` and the stale `src/shared/runtime/streamJsonl.ts` comment referenced the tailer.

```sh
rg -n 'work-context/reducer|reduceWorkContextFromRaw' --glob '!node_modules'
```

Result summary: only `src/shared/work-context/reducer.ts` defined `reduceWorkContextFromRaw`; no imports.

```sh
ls experiments
git ls-files experiments
rg -l 'experiments/' --glob '!node_modules'
```

Result summary: `experiments/` did not exist, no tracked files existed under it, and `package.json` was the only non-node_modules `experiments/` reference in this branch.

After deletion, reran the non-doc searches for deleted runtime/work-context references and they returned no matches.

Before removing the orphan settings path, confirmed `APP_SETTINGS_STORAGE_KEY` only appeared as the legacy constant/import/read path and that no writer existed:

```sh
rg -n "APP_SETTINGS_STORAGE_KEY|loadInitialSettings|setItem\\(.*settings" src package.json --glob '!node_modules'
```

Result summary: the only live code references were the deleted constant/import/function path; no `:settings` writer was present.

## Tests And Checks

- Attempted:

```sh
npm test -- src/renderer/src/workspace/dispatch/dispatchSelectors.test.ts src/renderer/src/workspace/sessionOwnership.test.ts src/renderer/src/workspace/gridRelatedAgents.test.ts
```

Result: blocked before test execution because this worktree has no `node_modules`; Vitest config could not resolve `@vitejs/plugin-react` or `vitest/config`.

- Environment check:

```sh
test -d node_modules && echo node_modules-present || echo node_modules-missing
test -d node_modules/@vitejs/plugin-react && echo plugin-react-present || echo plugin-react-missing
test -d node_modules/vitest && echo vitest-present || echo vitest-missing
```

Result: `node_modules-missing`, `plugin-react-missing`, `vitest-missing`.

- Static checks run:

```sh
node -e "JSON.parse(require('fs').readFileSync('package.json','utf8')); console.log('package.json ok')"
rg -n "APP_SETTINGS_STORAGE_KEY|function asRecord\\(|attachDetachedSessionId|openDispatchAttach: \\(sessionId|dispatchFocusedSessionId\\(state.dispatchMode\\)|setMode\\(mode === 'save-prompt-template'|src/shared/runtime/ptyScreen|src/shared/runtime/jsonlTailer|FileTailer in|proxy-demo" src package.json --glob '!node_modules' --glob '!*.md'
```

Result: `package.json ok`; only the canonical shared `asRecord` and two unrelated feed semantic UI local helpers remained.

## Deferred

- Hibernated runtime state and wake-on-attach were not implemented in this pass.
  - The branch already contains some hibernation-aware comments in `rehydrate.ts`, but adding a real `processStatus: 'hibernated'` plus wake/remap behavior crosses persistence, spawn lifecycle, submit gating, and UI. It should land as its own vertical PR.
- Terminal duplicate lane policy was not implemented.
  - The audit identifies a product/architecture decision: block duplicate terminal lanes now or implement terminal multi-attach. I did not invent that policy in this shared pass.
- `sessionCommands.ts` MCP toggle factory/provider-label cleanup was left for follow-up.
  - It is a clean same-file refactor, but it carries user-visible toast strings and a ping-only dev-debug gate. I skipped it to avoid adding late churn after behavior changes and deletions.
- `useCommandContext` / command-palette prop-wall refactor was not implemented.
  - It is high value but intentionally large and should land alone with a full command surface smoke pass.
