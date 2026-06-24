# Lifecycle Orchestration Runtime Implementation Log

Date: 2026-06-24
Branch: `cluster/lifecycle-orchestration-runtime`
Base: `integration/deep-audit-cleanup`

## Findings Implemented

- Main session lifecycle A1/A2/A4:
  - Added a manager-level `removed` event and moved JSONL coalescer/subagent watcher cleanup to that signal.
  - Made `kill()` authoritative when `stop()` resolves without `exit`, while avoiding duplicate cleanup if `exit` fired synchronously.
  - Centralized SessionManager per-session map cleanup in `cleanupSessionState()`.
  - Deleted `lastActivityAt` with the rest of per-session state.
  - Marked trust/resume/permission/compaction prompt events as activity for telemetry.
- Main session lifecycle B1/B2/B3/B4/C1/C2/C3/C5:
  - Deleted dead `src/shared/runtime/jsonlTailer.ts`.
  - Repointed the stale `streamJsonl.ts` live-tailer comment.
  - Switched history loading and transcript-template resolution to `resolveProviderTranscriptPath()` so Claude path math and Codex newest-mtime rollout resolution have one source of truth.
  - Added shared `SessionSpawnOptions` / `SessionSpawnResult` preload contract and imported it in main IPC/preload/manager.
  - Fixed tmux `recovered` telemetry to reflect actual reattach.
  - Aligned `TmuxRegistry.listManagedSessions()` with `isAvailable()` null-state behavior.
  - Parallelized tmux orphan cleanup.
  - Documented the hardcoded tmux detach keybinding coupling.
- Subagent orchestration F1/F2/F4/F5/F6/F7/F8/F9:
  - Extracted shared subagent primitives in `src/main/subagents/shared.ts`.
  - Ported Codex subagent tracker from full-file read-per-poll to byte-offset incremental folding with partial-line handling.
  - Shared the V8 slice-trap-safe headline helper across Claude/Codex while preserving Codex's visible `...` suffix.
  - Deleted the dead Claude `buildSubAgentState()` array builder and reworded accumulator comments so the incremental fold is the documented source of truth.
  - Gated the Codex poll timer on first known child id.
  - Removed redundant `finalAssistantText` fields/set-sites.
  - Documented dormant inheritance fields/path instead of deleting them.
  - Added linked comments for renderer lifecycle derivation and main prompt-delivery overlay.
  - Reduced orchestration close tombstone pre-reads from 100 messages to 5.
- Renderer workspace F1/F2/F3/F4/F5/F6/F9:
  - Removed `[xcript-diag #283]` and `[xcript-heal #283]` renderer logging plus the rehydrate diagnostic loop.
  - Removed dead `WorkspaceHookContext` aggregate scaffolding and dead `applyRuntimeUpdate()`.
  - Added `seedResumedRuntimeFields()` and replaced spawn/rehydrate/reload copies.
  - Added `isSessionExited()` and routed main deadness reads through it.
  - Removed debug-only markdown screen fields from the 60Hz no-op/change gates while preserving their stored values for debug surfaces when the plain screen changes.
  - Scrubbed stale tiled Dispatch lane selections in `pruneSessionOwnership()`.

## Findings Partially Implemented

- Main session lifecycle A3:
  - Implemented a central cleanup helper and single external removal signal, but did not migrate all SessionManager maps into a discriminated `SessionState` map. That refactor is larger and should land with dedicated tests/manual smoke.
- Main session lifecycle B5:
  - Did not add terminal detach / `AttachableBuffer`. Current changes make cleanup safer but do not change terminal attach semantics.
- Subagent orchestration F3:
  - Quarantined/documented inheritance dead surface, retained fields and cut logic for pre-disable persisted sessions and redesign compatibility.
- Renderer workspace F3:
  - Added shared exited predicate but did not remove `processStatus: 'exited'` from the runtime union.
- Renderer workspace F7:
  - Did not introduce shared `OrchestrationIdentity`; this touches shared MCP/renderer contracts and should coordinate with the IPC/contracts cluster.

## Findings Skipped And Why

- Main session lifecycle D3: LSP forwarding remains inside `wireSessionForwarder`; low-value relocation and not required for cleanup correctness.
- Main session lifecycle C2 robust detach-client implementation: documented the invariant instead. Moving detach behind `TmuxRegistry` changes the TerminalSession/registry boundary and deserves a focused follow-up.
- Subagent orchestration F10: prompt metadata TTL for >24h live runs not changed; needs policy on long-running orchestration retention.
- Renderer workspace F8/F10/F11: left queue reconciliation abstraction, activity-model consolidation, and `providerReportsPendingQueue` removal for follow-up. These are lower-confidence or product-policy changes.

## Deletion Confirmation Searches

- Before deleting `src/shared/runtime/jsonlTailer.ts`, ran:
  - `rg -n "from .*jsonlTailer|import\(.*jsonlTailer|jsonlTailer|tailNewSessionFile|tailSessionFile|FileTailer|JsonlEntry" src packages ...`
  - `rg -n "jsonlTailer|tailNewSessionFile|tailSessionFile|FileTailer" tsconfig*.json vite*.ts electron.vite.config.* vitest.config.* package.json src packages ...`
- Results:
  - No live importers of `jsonlTailer`, `tailNewSessionFile`, `tailSessionFile`, or `FileTailer`.
  - The only live source reference outside the deleted file was the stale `streamJsonl.ts` comment, now updated.
  - `JsonlEntry` live usages come from `claude-code-headless` and preload types, not the deleted module.
- Before deleting orchestration `finalAssistantText`, ran grep for `finalAssistantText`; only type/set-sites were present in the edited files.

## Files Changed

- `src/main/sessionManager.ts`
- `src/main/providerSwitch/shared.ts`
- `src/main/sessions/forwarder.ts`
- `src/main/sessions/historyLoader.ts`
- `src/main/sessions/transcriptPaths.ts`
- `src/main/subagents/SubAgentWatcher.ts`
- `src/main/subagents/codexSubagentState.ts`
- `src/main/subagents/shared.ts`
- `src/main/subagents/subagentState.ts`
- `src/main/ipc/session.ts`
- `src/main/orchestration/OrchestrationBridge.ts`
- `src/main/tmux/TmuxRegistry.ts`
- `src/main/tmux/tmuxRecovery.ts`
- `src/mcp/shared/orchestrationTypes.ts`
- `src/preload/api/session.ts`
- `src/preload/api/types.ts`
- `src/renderer/src/workspace/dispatch/DispatchAgentList.tsx`
- `src/renderer/src/workspace/hook/actions/initialHistory.ts`
- `src/renderer/src/workspace/hook/actions/session.ts`
- `src/renderer/src/workspace/hook/context.ts`
- `src/renderer/src/workspace/hook/helpers.ts`
- `src/renderer/src/workspace/hook/index.ts`
- `src/renderer/src/workspace/hook/ipc/useIpcSubscriptions.ts`
- `src/renderer/src/workspace/hook/persistence/rehydrate.ts`
- `src/renderer/src/workspace/hook/persistence/useBootstrap.ts`
- `src/renderer/src/workspace/orchestrationMcp.ts`
- `src/renderer/src/workspace/providerSessionIdentity.ts`
- `src/renderer/src/workspace/sessionOwnership.ts`
- `src/renderer/src/workspace/tile-tree/TileLeaf.tsx`
- `src/renderer/src/workspace/tile-tree/TileLeaf/useComposerKeybinds.ts`
- `src/shared/runtime/jsonlTailer.ts` (deleted)
- `src/shared/runtime/streamJsonl.ts`
- `src/shared/runtime/terminalSession.ts`
- `docs/audit-plans/execution/lifecycle-orchestration-runtime-implementation-log.md`

## Tests Run

- `git diff --check` passed.
- `npm test -- src/main/subagents/codexSubagentState.test.ts src/main/subagents/SubAgentWatcher.test.ts` attempted but blocked: this worktree has no `node_modules`; Vitest config could not resolve `@vitejs/plugin-react` / `vitest/config`.
- `npx tsc --noEmit -p tsconfig.node.json` attempted but blocked: TypeScript is not installed in this worktree.
- `npx tsc --noEmit -p tsconfig.web.json` attempted but blocked for the same reason.
- Confirmed `node_modules`, local `tsc`, and local `vitest` are absent. Did not run `npm install` to avoid package-lock churn in this cluster worktree.

## Manual Verification

- Grep verified removal/cleanup wiring:
  - `manager.on('removed')` owns `flushAndDropJsonl()` and `subAgents.stop()`.
  - natural exits emit `removed` before `exit`.
  - `kill()` emits `removed` if `stop()` did not already trigger exit cleanup.
  - `lastActivityAt.delete()` is in the shared cleanup helper.
- Grep verified no live source references remain for:
  - `finalAssistantText`
  - `xcript-diag`
  - `xcript-heal`
  - `WorkspaceHookContext`
  - `applyRuntimeUpdate`
  - `jsonlTailer` / `tailNewSessionFile` / `FileTailer`
  - `findCodexRolloutPathByThreadId`
  - `readRolloutEntries`
  - old Codex `childEntryCountByAgentId` / `childStateByAgentId`

## Second Pass

### Re-read Scope

- Re-read the assigned plans end-to-end:
  - `/Users/juliusolsson/Desktop/Development/agent-code-audit-worktrees/main-session-lifecycle/docs/audit-plans/main-session-lifecycle.md`
  - `/Users/juliusolsson/Desktop/Development/agent-code-audit-worktrees/subagent-orchestration/docs/audit-plans/subagent-orchestration.md`
  - `/Users/juliusolsson/Desktop/Development/agent-code-audit-worktrees/renderer-workspace-state/docs/audit-plans/renderer-workspace-state.md`
- Rechecked `docs/audit-plans/deep-audit-master-roadmap.md` for cross-plan sequencing and cluster boundaries.
- Re-inspected the current diff and this execution log before applying additional edits.

### Second-Pass Changes Added

- Main session lifecycle B2/B3:
  - Added `resolveProviderTranscriptPath()` in `src/main/providerSwitch/shared.ts`.
  - Updated both `src/main/sessions/historyLoader.ts` and `src/main/sessions/transcriptPaths.ts` to use that helper.
  - Result: the private history loader resolver is still named distinctly (`resolveHistoryTranscriptPath`), but both history pagination and transcript-template lookup now share Claude path math and Codex newest-mtime rollout tie-break.
- Subagent orchestration F4:
  - Deleted the dead `buildSubAgentState()` array builder from `src/main/subagents/subagentState.ts` after confirming no live source caller.
  - Reworded `subagentState.ts` and `SubAgentWatcher.ts` comments so the accumulator fold is the documented source of truth, not a parity mirror of deleted code.
- Renderer workspace F4:
  - Removed `screenMarkdown` / `recentScreenMarkdown` from the 60Hz no-op equality gate and from `changed[]` accounting in `src/renderer/src/workspace/hook/ipc/useIpcSubscriptions.ts`.
  - Kept storing markdown fields whenever the plain screen changes so DebugPanel/debug bundles still have the data; markdown simply no longer schedules workspace-wide updates by itself.

### Concrete Plan Classification

- Main session lifecycle:
  - Done: A1 (`lastActivityAt` cleanup), A2 (`removed` cleanup signal for kill-without-exit), A4 (prompt events mark activity), B1 (`jsonlTailer.ts` deletion), B2/B3 (shared transcript resolver path), B4 (shared spawn contract), C1 (tmux recovered telemetry), C3 (`listManagedSessions` null policy), C5 (parallel orphan cleanup).
  - Intentionally deferred: A3 full discriminated `SessionState` map consolidation; B5 `AttachableBuffer`/`detachTerminal`; robust C2 tmux `detach-client`; D3 LSP forwarder relocation.
  - Partially done: C2 has the invariant documented at the hardcoded detach keybinding but does not move detach behind `TmuxRegistry`.
  - Invalid after verification: no main-session finding was invalidated; all assigned findings still stand with the deferred scope above.
- Subagent orchestration:
  - Done: F1 (Codex V8 slice-trap headline fix), F2 (Codex incremental byte-offset fold), F4 (delete dead Claude array builder), F5 (shared subagent primitives), F6 (remove `finalAssistantText`), F7 (linked lifecycle-stage comments), F8 (Codex timer gated on known child), F9 (close tombstone pre-read reduced).
  - Partially done: F3 inheritance surface is quarantined/documented but fields and cut path are retained for pre-disable persisted sessions and redesign compatibility.
  - Intentionally deferred: F10 prompt metadata TTL for >24h live runs; this needs a product/retention policy.
  - Invalid after verification: no subagent finding was invalidated; the second pass confirmed `buildSubAgentState()` was truly dead in live source before deletion.
- Renderer workspace state:
  - Done: F1 (`#283`/`#290` diagnostic logging removal), F2 (`seedResumedRuntimeFields`), F3 predicate extraction/read unification, F4 markdown fields removed from per-frame equality/change gates, F5 `applyRuntimeUpdate` deletion, F6 `WorkspaceHookContext`/`ctx` deletion, F9 tiled-lane stale selection pruning.
  - Partially done: F3 keeps `processStatus: 'exited'` in the union for compatibility; reads now go through `isSessionExited()`.
  - Intentionally deferred: F7 shared `OrchestrationIdentity` contract due likely overlap with IPC/contracts cluster; F8 Codex idle-queue reconciliation abstraction because the call sites intentionally differ; F10 activity-model consolidation as a larger architecture follow-up; F11 `providerReportsPendingQueue` because the plan itself marks it optional/documented YAGNI.
  - Invalid after verification: the plan's own retracted "dead type exports" remain untouched; only `applyRuntimeUpdate` was deleted.

### Second-Pass Verification

- `git diff --check` passed.
- Live-source grep passed with no hits for:
  - `buildSubAgentState`
  - `screenMarkdown ===`
  - `recentScreenMarkdown ===`
  - `changed.push('markdown')`
  - `findCodexRolloutPathByThreadId`
  - `readRolloutEntries`
  - `childEntryCountByAgentId`
  - `childStateByAgentId`
  - `finalAssistantText`
  - `xcript-diag`
  - `xcript-heal`
  - `WorkspaceHookContext`
  - `applyRuntimeUpdate`
  - `jsonlTailer` / `tailNewSessionFile` / `FileTailer`
- Confirmed again that `node_modules`, local `tsc`, and local `vitest` are absent in this worktree. Full typecheck/Vitest remain blocked unless dependencies are installed or an integration checkout with dependencies is used.

### Second-Pass Residual Risks

- The biggest untested code path remains `src/main/subagents/codexSubagentState.ts`; it changed from full-file polling to incremental accumulation and needs Vitest plus manual fan-out smoke once dependencies are available.
- `src/main/sessionManager.ts` now has a cleanup helper and removal signal, but the broader single-map consolidation is still deferred.
- Renderer screen markdown no longer independently invalidates runtime state; this matches the audit recommendation and preserves debug data on plain-frame changes, but it should be smoke-tested with debug bundle capture after dependencies/app runtime are available.

## Cross-Cluster Conflicts Or Merge Risks

- `src/preload/api/types.ts`, `src/main/ipc/session.ts`, and orchestration MCP shared types may overlap the IPC/contracts cluster.
- `src/renderer/src/workspace/providerSessionIdentity.ts`, rehydrate/session actions, and Dispatch lane cleanup may overlap renderer-state agents.
- `src/main/subagents/codexSubagentState.ts` changed substantially; any parallel subagent work will need careful merge/review.
- Full SessionManager map consolidation and terminal detach should be follow-up PRs to avoid mixing a broad internal migration with this cleanup patch.

## Recommended Follow-Up PRs

- Full `SessionManager` discriminated `SessionState` map consolidation with focused tests.
- Terminal `detachTerminal` / `AttachableBuffer` and renderer unmount wiring.
- Robust tmux detach via registry-owned `detach-client`.
- Shared `OrchestrationIdentity` once IPC/contracts ownership is ready.
- Decide policy for orchestration prompt metadata TTL on runs lasting over 24h.
- Re-run full Vitest/typecheck after installing dependencies in this worktree or using an integration checkout with dependencies.
