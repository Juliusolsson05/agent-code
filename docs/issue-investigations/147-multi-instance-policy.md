# Issue #147: Multiple Agent Code Instances

## Issue Summary

GitHub issue #147 asks whether Agent Code is safe when 2-4 app instances run against the same app state, workspace files, provider session transcripts, debug logs, proxy logs, and derived indexes.

The current code already attempts to enforce one Electron primary process with `app.requestSingleInstanceLock()` in `src/main/index.ts`. A second instance quits and focuses the existing window. That is the right default policy for the current architecture.

The important finding is that the rest of the persistence model is not designed as a multi-writer database. Several files are protected against crash-time truncation by temp-file rename or append-only JSONL, but most do not have cross-process merge semantics. If the Electron lock is bypassed, if dev/prod builds use different Electron profiles while still sharing `~/.config/agent-code`, or if a future multi-window implementation accidentally starts multiple main processes, state can be lost or caches can race.

## Current Behavior And Relevant Files

- `src/main/index.ts`
  - `app.requestSingleInstanceLock()` is called at module startup.
  - If the lock is not acquired, the process calls `app.quit()`.
  - On `second-instance`, the existing main window is focused through `focusMainWindow()`.
  - Services are constructed before `startApp()`, but disk-writing startup work is inside `startApp()` after the lock branch.

- `src/main/window/mainWindow.ts`
  - Holds one module-scoped `mainWindow`.
  - `createMainWindow()` overwrites that reference.
  - `sendToMainWindow()` targets only that one window.
  - This is a single-window renderer model, not a multi-window primary-process model.

- `src/main/storage/paths.ts`
  - App-owned durable state is under `~/.config/agent-code`, not Electron `app.getPath('userData')`.
  - Key paths include `workspace.json`, `feed-debug/`, `debug-bundles/`, `proxy/`, and `performance/runs/`.
  - Because this path is independent of Electron's profile path, separate dev/prod app identities can still collide on these files if both are allowed to run.

- `src/renderer/src/workspace/hook/persistence/useAutoSave.ts`
  - Renderer owns workspace layout/session metadata.
  - Autosave serializes a full workspace snapshot after a 400 ms debounce and on `beforeunload`.
  - This is last-writer-wins at the file level. It is safe for one renderer/main process, but two independent app processes would overwrite each other's layout/session changes.

- `src/main/ipc/workspace.ts`
  - `workspace:load` reads `~/.config/agent-code/workspace.json`.
  - `workspace:save` writes a unique temp sibling and renames to `workspace.json`.
  - The unique temp path avoids same-process overlapping-save temp collisions and avoids partial-file corruption, but it does not merge concurrent process snapshots.

- `src/main/worktreeActivity/indexStore.ts`
  - `worktree-activity-index.json` is a derived cache.
  - `saveWorktreeActivityIndex()` currently writes to fixed `worktree-activity-index.json.tmp` and renames.
  - Same-process refreshes are serialized by `WorktreeActivityIndex.refreshing`; cross-process refreshes are not. Two processes can race on the shared temp file, causing `ENOENT`, stale overwrites, or a cache rebuild on next load.

- `src/main/aiWorkspace/AiWorkspaceRegistry.ts`
  - `ai-workspaces.json` is main-owned MCP/UI state.
  - Writes use unique temp sibling plus rename, so crash-time corruption is unlikely.
  - The registry loads once into a process-local `Map`; two processes can independently mutate then save, losing the other process's workspace records or file attachments.

- `src/main/setup/setupState.ts`
  - `setup.json` uses a process-local write queue but direct `writeFile`.
  - A crash during write can leave a truncated file, and two processes can overwrite each other's setup state.

- `src/main/ghostJournal.ts`, `src/main/dictationJournal.ts`, `src/main/pasteDebugJournal.ts`
  - Append-only JSONL under Electron `userData`, with one file per session/debug id and process-local batching.
  - Usually low collision risk because ids are fresh UUID-like values. If two processes ever append to the same file, line-level atomicity is filesystem-dependent and not a formal app invariant.

- `src/main/storage/feedDebugLog.ts`
  - Append-only JSONL under `~/.config/agent-code/feed-debug`, keyed by Agent Code session id.
  - It serializes per session id inside one process. Cross-process appends are not coordinated.
  - The dedupe cursor `lastWrittenFeedDebugId` is intentionally process-local.

- `src/main/storage/performanceLog.ts`
  - Append-only JSONL under a per-run directory. The run folder name includes process identity via `PerformanceService`.
  - Low collision risk, but queues are only process-local.

- `src/main/storage/debugRetention.ts`
  - Startup and append paths schedule best-effort pruning across shared debug/proxy/performance roots.
  - Multiple processes pruning while others write is tolerated by broad catch blocks, but it can delete another instance's recent-looking artifact if mtimes/budget rules classify it as removable.

- `src/main/setup/runtimeTools.ts`
  - Bundled mitmproxy extraction uses in-process locks and atomic tmp-dir rename.
  - The file already documents a same-userData, no-cross-process-lock limitation for multi-version dev/prod instances cleaning each other's runtime directories.

- Provider transcript paths
  - Claude and Codex CLIs own their native transcripts. Agent Code mostly tails/reads them.
  - `src/main/providerSwitch/shared.ts` writes new clone/rewind/switch transcript files using fresh provider session ids.
  - Two Agent Code app processes can still spawn duplicate resumes of the same provider session if both restore the same `workspace.json`, making provider CLI behavior and transcript tails the main correctness risk.

## Inventory Of Shared State, Log, And Index Write Paths

| Path | Writer | Pattern | Multi-process assessment |
| --- | --- | --- | --- |
| `~/.config/agent-code/workspace.json` | `workspace:save` | unique temp + rename | Not corrupt-prone, but last writer wins and restore becomes nondeterministic. |
| `~/.config/agent-code/worktree-activity-index.json` | `saveWorktreeActivityIndex` | fixed temp + rename | Race-prone if multiple main processes refresh. Derived cache, but should still be fixed. |
| `~/.config/agent-code/ai-workspaces.json` | `AiWorkspaceRegistry.save` | unique temp + rename | Not corrupt-prone, but process-local map causes lost updates. |
| `~/.config/agent-code/setup.json` | `saveSetupState` | direct write with process-local queue | Can truncate on crash and last writer wins across processes. |
| `~/.config/agent-code/feed-debug/*.jsonl` | `queueFeedDebugAppend` | append with per-process queue | Usually okay for unique session ids; not guaranteed for same-file cross-process writers. |
| `~/.config/agent-code/debug-bundles/*` | `saveDebugBundle` | mkdir + per-file writes | Timestamped bundles reduce collisions; retention can race but is best-effort. |
| `~/.config/agent-code/proxy/**/proxy-events.jsonl` | Claude/Codex proxy runtimes | per-run JSONL | Timestamped per-run dirs reduce collisions; shared `_shared-conf` and retention remain cross-process areas to verify. |
| `~/.config/agent-code/performance/runs/*/*.jsonl` | `PerformanceService` | per-run append | Low collision risk if run dir names remain unique. |
| Electron `userData` `ghost-logs/*.ghost.jsonl` | `GhostJournal` | append with per-process queue | Safe under one process. Same-file multi-process append is not an app-level guarantee. |
| Electron `userData` `dictation-debug/*.dictation.jsonl` | `DictationDebugJournal` | append with per-process queue | Low collision risk due renderer UUIDs, no cross-process lock. |
| Electron `userData` `paste-debug/*.paste.jsonl` | `PasteDebugJournal` | append with per-process queue | Low collision risk due renderer UUIDs, no cross-process lock. |
| Electron `userData` `runtime/mitmproxy-*` | `resolveBundledTool` | in-process lock, tmp dir + rename | Known no-cross-process-lock limitation during multi-version cleanup. |
| Provider transcripts under `~/.claude`, `~/.codex` | Provider CLIs plus clone/rewind helpers | provider-owned append / Agent Code full-file write for new ids | Concurrent resume of the same provider session is policy-sensitive and should be avoided by app single-instance enforcement. |

## Policy Recommendation

Recommended policy: enforce a single Agent Code primary process, and treat multiple visible workspaces as future windows owned by that one primary process.

Do not try to support safe multi-instance as the first fix. Safe multi-instance would require file locks, revision checks, or append/merge formats for `workspace.json`, `ai-workspaces.json`, `setup.json`, and `worktree-activity-index.json`, plus provider-session ownership rules so two app processes do not resume the same Claude/Codex session and both tail/write related state. That is a larger data-model project than this issue needs.

Also do not turn the current app into "multi-window" by launching more main processes. If multi-window is desired later, it should be one Electron primary process with a window registry, one `SessionManager`, one `AiWorkspaceRegistry`, one worktree index service, and explicit routing for window-specific UI state. The current `mainWindow` singleton means that is a real architecture change, not a small flag flip.

## Proposed Implementation Plan

1. Make the single-instance policy explicit in bootstrap comments near `requestSingleInstanceLock()`.
   - Explain that the lock protects `~/.config/agent-code` state and provider session resumes, not just UI focus.
   - Keep the lock before any startup disk-writing work.

2. Add a small test or smoke harness for second-instance behavior.
   - Launch an app instance, attempt a second launch, assert the second exits and the first receives `second-instance`.
   - For Electron integration this may be a manual verification script if automated CI cannot launch GUI Electron reliably.

3. Harden the derived worktree index even though the policy is single-instance.
   - Change `saveWorktreeActivityIndex()` to use a unique temp sibling, matching `workspace:save` and `AiWorkspaceRegistry.save`.
   - This is cheap and removes one obvious footgun for dev/prod bypass scenarios.

4. Harden `setup.json` to use temp + rename.
   - It is small user-visible configuration state and currently uses direct `writeFile`.
   - This is not required for multi-instance semantics, but it improves crash safety.

5. Add a startup diagnostic if another likely Agent Code process is detected but Electron still acquired the lock.
   - This can catch dev/prod or app-identity split cases where the Electron lock namespace differs but `STATE_DIR` is shared.
   - A simple advisory lock file under `STATE_DIR` with PID/startedAt could warn and exit. If implemented, document why it is advisory and why stale PID cleanup is safe.

6. If/when multi-window is needed, implement it inside the primary process.
   - Replace the `mainWindow` singleton with a window registry.
   - Route events by workspace/window when needed.
   - Keep all disk-owning services singleton-scoped in main.

## Risk Areas And Open Questions

- Does Electron's single-instance lock namespace always line up across packaged, preview, and dev launches on macOS for this app? This matters because `STATE_DIR` is hardcoded to `~/.config/agent-code`.
- Can a packaged app and `npm run start` both run at once and share `~/.config/agent-code` despite different Electron identities?
- What happens if two app processes resume the same persisted Claude/Codex provider session? Provider CLIs may append to the same native transcript or expose inconsistent tails.
- Should `app.getPath('userData')` writers and `~/.config/agent-code` writers be unified under one root, or is the split intentional enough to document?
- Should debug retention skip active run directories with an explicit lock/marker instead of relying on mtime grace?
- Should AI Workspace writes gain optimistic revision checks even in a single process, because MCP tools and UI edits can happen close together?

## Suggested Tests And Manual Verification

- Packaged app: launch Agent Code, launch it again from Finder/CLI, verify only one main process remains and the existing window focuses.
- Dev preview: run `npm run start` twice, verify the second process quits or cannot reach `startApp()`.
- Dev/prod collision: run a packaged app and `npm run start` simultaneously, verify whether Electron prevents it; if not, confirm the proposed advisory state lock catches it.
- Workspace persistence: with one instance, create tabs/sessions, quit, relaunch, verify deterministic restore.
- Bypass experiment in a throwaway profile: temporarily disable the Electron lock, run two processes, edit layouts in both, and confirm `workspace.json` is last-writer-wins. Use this only as evidence, not as supported behavior.
- Worktree activity index: trigger refreshes from two bypassed processes and verify the fixed-temp implementation no longer produces temp `ENOENT`; derived cache may still be last-writer-wins, which is acceptable if single-instance remains policy.
- AI Workspace: create/attach from UI/MCP in one process; under bypass, verify lost update risk exists and document that single-instance/advisory lock is the mitigation.
- Debug logs: run active sessions with feed/proxy/ghost logging, save debug bundle, and verify JSONL files parse line-by-line after normal single-process use.

## Size Estimate

Small if the chosen policy is "single primary process only" plus documentation, a second-instance smoke test, unique temp for the worktree index, and atomic `setup.json`.

Medium if adding an advisory `STATE_DIR` process lock that catches dev/prod identity splits and has robust stale-PID cleanup.

Large if supporting true safe multi-instance or multi-window UI in this issue. That would require shared-state merge semantics, cross-process locks or revisions, provider session ownership, and a main-process window registry.

## Implementation Notes

Implemented policy: single Agent Code primary process.

- Normal duplicate launches are blocked by Electron `requestSingleInstanceLock()` and focus the existing window.
- Identity-split launches that might bypass Electron's lock but still share `~/.config/agent-code` are blocked by a new advisory state lock at `~/.config/agent-code/agent-code.process-lock.json`.
- The state lock is acquired before startup storage work begins. If an active owner is found, the new process quits instead of writing shared state.
- The lock is token-owned so shutdown cannot remove another process's replacement lock.
- Stale locks are recoverable when the recorded PID is no longer running.
- `worktree-activity-index.json` now uses a unique temp sibling before rename.
- `setup.json` now uses temp + rename for crash safety.

Verification run during implementation:

- `npm run test:process-lock` passed.
- `npm run test:worktree-activity` passed.
- `npm run test:review-fixes` passed.
- `npx tsc --noEmit -p tsconfig.node.json` still fails on pre-existing package alias/type issues around `agent-voice-dictation`, `claude-code-headless`, `codex-headless`, and `pidusage`.
- `npm run build` currently fails before app compilation because `packages/claude-code-headless/src/proxy/mitmAddon.py` is missing in this checkout; the existing Vite resource-copy plugin expects that file.
