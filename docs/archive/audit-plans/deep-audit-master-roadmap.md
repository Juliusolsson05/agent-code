# Deep Audit Master Roadmap

Branch: `integration/deep-audit-cleanup`

Worktree: `/Users/juliusolsson/Desktop/Development/agent-code-integration-deep-audit-cleanup`

Base context: this roadmap synthesizes the 18 verified audit implementation plans written in isolated audit worktrees from `main` around `e3001cf`.

Status: planning artifact only. No product/runtime fixes are implemented in this file.

## 1. Operating Model

This is not a single cleanup PR. The audit files describe hundreds of findings across renderer state, main session lifecycle, provider packages, IPC contracts, debug storage, feed rendering, Dispatch, dictation, and package boundaries. The right execution model is an integration branch plus many small PRs merged into that branch, then a final integration PR to `main` after the series has stabilized.

The integration branch should be used as the coordination target because many fixes share files and source-of-truth decisions. Direct independent PRs to `main` will conflict and can land half of a contract move without the companion cleanup.

Recommended branch flow:

1. Keep `integration/deep-audit-cleanup` as the long-lived coordination branch.
2. Create one worktree and branch per implementation PR from this integration branch.
3. Merge implementation PRs into the integration branch only after local typecheck/tests/manual smoke pass.
4. Periodically rebase the integration branch onto `main` only when the active PR batch is quiet.
5. Avoid broad automatic refactors until the first behavior bug fixes and shared type foundations have landed.

Recommended parallelism:

- Use orchestrated agents again, but cap implementation concurrency at 3-4 active code-changing agents.
- Give every agent a file/module ownership boundary and tell them other agents are working in the codebase.
- Do not run 18 code-changing agents at once. The previous bottleneck was worktree/session pressure, and the implementation work will collide harder than planning did.
- Use read-only/explorer agents freely for focused verification, but use code-changing workers only in disjoint scopes.

Review rule:

- Every PR must state which audit plan findings it addresses and which related findings it deliberately does not address.
- Every PR that moves a source of truth must include either tests or a before/after grep proving no old source remains active.
- Every PR that deletes dead code must include the confirmation search requested by the relevant audit plan.

## 2. Source Inventory

The 18 source plans reviewed for this roadmap:

| Plan | Lines | Primary theme |
|---|---:|---|
| `commands-ui-shell.md` | 712 | Command palette, app state, uiShell, settings, command context wiring |
| `conditions-framework.md` | 1366 | Condition snapshots, legacy pending mirrors, attention, slash picker, condition IPC |
| `cross-app-duplication.md` | 1414 | Duplicated provider paths, JSONL tailers, timestamps, terminal attach, helper extraction |
| `cross-app-type-contracts.md` | 1664 | Shared provider/session kinds, session IPC maps, semantic event typing, orchestration contracts |
| `cross-app-weirdness.md` | 608 | Typecheck gap, runtime weirdness, stale diagnostics, sidecar/condition/prompt oddities |
| `dictation.md` | 821 | Voice dictation dead provider paths, journaling, sha8, hot-path instrumentation |
| `dispatch-tiling.md` | 1233 | Tiled Dispatch target correctness, hibernated wake, terminal duplicate lanes |
| `feed-rendering.md` | 1682 | Feed map invalidation, semantic auto-scroll, live/committed row convergence |
| `global-dead-code.md` | 528 | Dead files, stale scripts, shared helper candidates |
| `headless-packages.md` | 1666 | Headless package safety, session listers, prompt extraction, package/shared boundaries |
| `ipc-preload-api.md` | 1039 | Stale IPC channels, shared IPC payload types, preload surface cleanup |
| `main-session-lifecycle.md` | 719 | SessionManager leaks, teardown cleanup, spawn contracts, tmux attach/replay |
| `provider-boundary.md` | 736 | Renderer provider registry, provider capabilities, feed/tool row dispatch |
| `renderer-workspace-state.md` | 384 | Runtime seeding, stale diagnostics, workspace state duplication |
| `setup-packaging-runtime.md` | 677 | Release/runtime tool packaging, runtime-tool script duplication, vendor policy |
| `shared-types-parsers.md` | 1313 | Shared IPC types, parser helpers, alias parity, package mirror guardrails |
| `storage-debug-perf.md` | 1410 | Debug retention, render trace correctness, feed-debug durability, journals |
| `subagent-orchestration.md` | 682 | Orchestration subagent state, Codex rollout polling, inheritance dead surface |

Two of these came from disconnected worktrees outside the orchestration registry but were read as first-class sources:

- `renderer-workspace-state.md`
- `main-session-lifecycle.md`

## 3. Global Synthesis

The audit findings cluster into nine implementation themes:

1. Build/typecheck/release foundations.
2. Stale IPC and shared cross-boundary contracts.
3. Main session lifecycle and orchestration process correctness.
4. Renderer workspace, Dispatch, and hibernated runtime state.
5. Feed rendering correctness and provider row convergence.
6. Provider/headless package source-of-truth cleanup.
7. Debug/storage/performance forensic correctness.
8. Dictation and paste-debug lifecycle cleanup.
9. Low-risk dead code and mechanical helper extraction.

The most important cross-cutting rule is: fix behavioral correctness bugs before doing broad dedupe. Several plans explicitly warn that duplicated code is sometimes preserving provider-package independence or UI-specific policy. The goal is not "one helper for everything"; the goal is one source of truth per actual contract.

## 4. Cross-Plan Dependencies

### Typecheck Gate

`cross-app-weirdness` identifies the absence of a typecheck gate as the highest-leverage systemic issue. Many plans propose shared type moves, but without a reliable typecheck target those moves are too easy to break silently.

First decision:

- Add or confirm `npm run typecheck` scripts for main/preload/renderer/package contexts.
- Add CI coverage once local typecheck is real.
- Include `src/shared/lib/**/*` and `src/shared/git/**/*` in `tsconfig.web.json` if they are currently excluded.

This should happen before large shared-contract work. It does not need to block small behavior bug fixes.

### Runtime Packaging Release Gate

`setup-packaging-runtime` identifies a release blocker: release CI creates runtime manifests but does not prime the runtime-tool payload cache. DMGs can ship without required `mitmdump`/`tmux` payloads.

This should be an independent early PR:

- Add `npm run runtime:prepare:mac` before `npm run build` in release CI.
- Keep this separate from cleanup/refactor work.

### PR #355 Worktree Freeze Fix

PR #355 (`fix/orchestration-worktree-freeze`) is already open and applied uncommitted to main for local testing. Treat it as a separate prerequisite for running many agents, not as part of this integration roadmap.

Do not duplicate PR #355 changes into this integration branch unless the user explicitly wants the integration branch to include orchestration freeze fixes. The master roadmap can refer to it as an execution dependency.

### Package Boundary Rule

Several plans warn that packages must stay standalone:

- `claude-code-headless`
- `codex-headless`
- `agent-transcript-parser`
- `opencode-headless`

Do not make packages import app `src/shared` unless the package is intentionally becoming app-coupled. For package/app shared behavior, prefer:

- a workspace shared package,
- package-local helpers plus parity tests,
- or app-side wrappers around package exports.

### Condition Source Of Truth

`conditions-framework`, `provider-boundary`, and `ipc-preload-api` all converge on the same path:

- modern `session:conditions` snapshots should be the app source of truth;
- legacy per-prompt IPC channels are stale at the app/preload boundary;
- legacy `pending*` runtime mirrors should be compatibility-only during migration, then removed.

Do not delete legacy mirrors before moving production consumers, especially compaction status.

### Feed And Semantic Event Ordering

`feed-rendering`, `cross-app-type-contracts`, and `headless-packages` all touch semantic events. The order should be:

1. Fix feed correctness bugs with existing event shape.
2. Add renderer-local semantic event adapter/types and tests.
3. Only then consider broader provider event contracts.

This prevents a type refactor from hiding known rendering bugs.

## 5. Must-Fix Early Bugs

These are the strongest candidates for the first implementation wave because they are high-impact and relatively bounded.

### E1. Codex CommittedChannel Must Not Emit `error`

Sources: `headless-packages`.

Problem:

- `packages/codex-headless/src/channels/CommittedChannel.ts` emits EventEmitter's special `error` event.
- No committed-channel `error` listener was found.
- Node can throw synchronously for unhandled `error`.

Implementation:

- Rename the committed-channel event to `rollout_error` or `history_error`.
- Prefer `rollout_error` to match top-level `rollout-error`.
- Do not emit both old and new names.
- Add package test that `publishError()` without listeners does not throw.
- Update API docs.

Why early:

- It is a small package bug with direct process-stability risk.

### E2. Release CI Must Prime Runtime Tool Payloads

Sources: `setup-packaging-runtime`.

Problem:

- Release CI packages runtime manifests without ensuring runtime payloads exist.

Implementation:

- Add `npm run runtime:prepare:mac` before app build in release workflow.
- Verify packaged app includes expected runtime tools.

Why early:

- It is a release blocker and independent of app refactors.

### E3. Heap Snapshots Must Enter Debug Retention

Sources: `storage-debug-perf`.

Problem:

- Heap snapshots are large and written under `STATE_DIR/heap-snapshots`.
- `debugRetention.ts` does not collect/prune them.

Implementation:

- Add `HEAP_SNAPSHOT_DIR` in storage paths.
- Use it from heap watchdog and manual performance IPC.
- Add `heap-snapshots` retention bucket and tests.

Why early:

- It fixes unbounded disk growth with narrow code impact.

### E4. Render Trace Pruning Must Preserve Valid Checkpoints

Sources: `storage-debug-perf`, `feed-rendering`.

Problem:

- Pruning can store latest HTML content under an older commit hash.
- Debug bundle replay metadata can become internally inconsistent.

Implementation:

- Add failing hash/replay test.
- Keep nearest checkpoint at or before retained window, or otherwise ensure checkpoint content matches hash.
- Add `forgetDebugTrace(sessionId)` and wire cleanup separately in same or follow-up PR.

Why early:

- Debug bundles are forensic artifacts. Wrong replay evidence is worse than missing evidence.

### E5. Feed Tool Index Context Must Invalidate Consumers

Sources: `feed-rendering`.

Problem:

- Tool-use/result maps mutate in place.
- React context value identity can remain stable.
- Memoized rows can miss paired result updates, especially rich git cards.

Implementation:

- Add `toolIndexVersion` or versioned context wrapper.
- Bump on actual tool-use/result map mutations.
- Make `Feed` context depend on version.
- Add regression test for git card updating after result arrives.

Why early:

- It is likely user-visible and can leave correct transcript state rendered stale.

### E6. Semantic Auto-Scroll Must Observe Block Deltas

Sources: `feed-rendering`.

Problem:

- Sticky-bottom signal ignores text/tool input/tool output deltas inside existing semantic blocks.

Implementation:

- Add `SemanticLiveTurn.revision` or a pure scroll signal helper.
- Increment/reflect visible deltas.
- Use it in Feed's scroll effect.

Why early:

- It is an isolated renderer correctness bug with high UX impact.

### E7. Session Exit Must Clear Condition State

Sources: `conditions-framework`.

Problem:

- Session exit clears many runtime fields but not `conditions`, `picker`, or legacy prompt mirrors.
- Stale prompt UI can survive process exit.

Implementation:

- Add `clearConditionRuntimeState`.
- Call it in `onSessionExit`.
- Replace `conditions !== null` hybrid display check with `hasVisibleConditions`.
- Add tests for exit and empty snapshot display mode.

Why early:

- It is a direct lifecycle correctness bug and prepares later condition cleanup.

### E8. Strict Tiled Dispatch Targeting

Sources: `dispatch-tiling`.

Problem:

- Empty/stale focused Tiled lanes can command fallback sessions.
- Attach-to-grid can use stale active tab rather than visible lane tab.

Implementation:

- Add strict Dispatch visual target resolver.
- Thread `{ sessionId, targetTabId }` through attach intent.
- Use strict target semantics for lifecycle/destructive commands.

Why early:

- It prevents commands from acting on a different session/tab than the user sees.

### E9. Hibernated Sessions Need Explicit Runtime State And Wake

Sources: `dispatch-tiling`, `renderer-workspace-state`.

Problem:

- Detached/buried sessions can rehydrate as `started/inputReady` without a backend process.

Implementation:

- Add `processStatus: 'hibernated'` or equivalent.
- Set `inputReady: false`.
- Add explicit `wakeHibernatedSession`.
- Block submit with clear message until wake.
- Wire attach to wake only after tests.

Why early but not first:

- It is high-risk and important, but crosses renderer persistence, spawn, ownership remapping, and UI. Do after strict target semantics.

## 6. Master PR Waves

### Wave 0: Foundation And Guardrails

Goal: make future changes safer without broad behavior changes.

Candidate PRs:

1. `runtime-release-cache-prime`
   - Source: `setup-packaging-runtime`.
   - Add release CI runtime cache preparation.

2. `typecheck-foundation`
   - Source: `cross-app-weirdness`.
   - Add/confirm typecheck scripts and tsconfig shared includes.
   - Do not combine with broad type cleanup.

3. `rendering-harness-alias-fix`
   - Source: `shared-types-parsers`.
   - Fix `testing/rendering/electron.vite.config.ts` aliases to `packages/*`.
   - Run `npm run testing:rendering:build` if available.

4. `provider-kind-source-of-truth`
   - Sources: `cross-app-type-contracts`, `shared-types-parsers`.
   - Add `src/shared/types/providerKind.ts`.
   - Define `AgentProviderKind`, `SessionKind`, `AGENT_PROVIDER_KINDS`, `isAgentProviderKind`.
   - Type provider registries as exhaustive records.

5. `session-info-contract-cleanup`
   - Sources: `cross-app-type-contracts`, `headless-packages`, `shared-types-parsers`.
   - Re-export `SessionInfo` from shared/preload.
   - Remove renderer local `SessionInfo` copies.
   - Add package/app parity tests where direct imports are not legal.

### Wave 1: Small High-Impact Safety Fixes

Goal: ship bounded bugs and stale surface cleanup.

Candidate PRs:

1. `codex-committed-rollout-error`
   - Source: `headless-packages`.
   - Rename committed `error` event.

2. `condition-exit-clear`
   - Source: `conditions-framework`.
   - Clear condition/picker/pending mirrors on exit.
   - Add `hasVisibleConditions`.

3. `heap-snapshot-retention`
   - Source: `storage-debug-perf`.
   - Add heap snapshot bucket to retention.

4. `render-trace-prune-and-cleanup`
   - Source: `storage-debug-perf`.
   - Fix checkpoint corruption.
   - Add `forgetDebugTrace`.

5. `remove-xcript-diag-or-gate`
   - Sources: `renderer-workspace-state`, `dispatch-tiling`, `cross-app-weirdness`.
   - Remove/gate issue #283 xcript diagnostic logs after confirming not needed.

6. `jsonl-tail-dead-file-delete`
   - Sources: `global-dead-code`, `main-session-lifecycle`, `headless-packages`.
   - Delete `src/shared/runtime/jsonlTailer.ts` after final `rg` confirmation.
   - Do not delete `streamJsonl.ts`.

7. `command-settings-dead-code-sweep`
   - Source: `commands-ui-shell`.
   - Dead Escape ternary.
   - Remove unused `SettingsList.onChange`.
   - Optionally remove orphaned `:settings` read as a separate PR if reviewer wants persistence isolation.

### Wave 2: Stale IPC And Boundary Contracts

Goal: shrink stale APIs before moving types.

Candidate PRs:

1. `remove-singular-jsonl-preload`
   - Sources: `ipc-preload-api`, `conditions-framework`.
   - Remove `onSessionJsonlEntry` and stale singular type.
   - Mark old historical plan text as obsolete.

2. `remove-legacy-condition-preload`
   - Sources: `ipc-preload-api`, `conditions-framework`, `provider-boundary`.
   - Remove preload legacy prompt listeners and main-window forwarding after condition tests.
   - Keep provider/headless package events unless separately deprecated.

3. `small-unused-ipc-cleanup`
   - Sources: `ipc-preload-api`, `dictation`.
   - Remove `listDictationProviders`.
   - Decide `startCaffeinate`/`stopCaffeinate`, `changeLspDocument`, and staged mutation endpoints separately.

4. `caffeinate-ipc-types-shared`
   - Source: `ipc-preload-api`.
   - Move caffeinate payload types out of preload so main no longer imports from `@preload`.

5. `session-ipc-contract-map-type-only`
   - Source: `cross-app-type-contracts`.
   - Add `src/shared/contracts/sessionIpc.ts`.
   - Add type-only parity tests.
   - No runtime wrapper yet.

6. `replace-session-ipc-inline-types`
   - Source: `cross-app-type-contracts`, `main-session-lifecycle`.
   - Replace spawn/history/transcript path inline types with shared types.

7. `ai-workspace-debug-bundle-contracts`
   - Sources: `cross-app-type-contracts`, `storage-debug-perf`.
   - Add `AiWorkspaceWriteFileParams`.
   - Add shared debug bundle payload contracts.

### Wave 3: Main Session Lifecycle And Orchestration

Goal: fix leaks/teardown first, then optimize/refactor.

Candidate PRs:

1. `session-last-activity-leak`
   - Source: `main-session-lifecycle`.
   - Bound/delete `lastActivityAt` after confirming telemetry post-exit usage.
   - Mark activity on interactive prompts or document idle semantics.

2. `session-removed-cleanup-event`
   - Source: `main-session-lifecycle`.
   - Add internal removed signal.
   - Move `flushAndDropJsonl` and `subAgents.stop` cleanup to removal path.
   - Ensure kill without exit still cleans watchers/coalescer.

3. `session-state-map-consolidation`
   - Source: `main-session-lifecycle`.
   - Collapse per-session maps into discriminated `SessionState` map.
   - Depends on the leak cleanup tests.

4. `spawn-options-shared-contract`
   - Sources: `main-session-lifecycle`, `ipc-preload-api`.
   - Share `SessionSpawnOptions` / `SessionSpawnResult`.

5. `codex-orchestration-slice-trap`
   - Source: `subagent-orchestration`.
   - Fix Codex `headlineFromInput` V8 slice-trap leak.

6. `codex-orchestration-incremental-rollout`
   - Source: `subagent-orchestration`.
   - Stop re-reading entire child rollout each poll.
   - Add incremental offset fold.

7. `orchestration-inherit-context-deprecation`
   - Sources: `subagent-orchestration`, `cross-app-type-contracts`.
   - Deprecate/narrow `inheritParentContext`.
   - Preserve clean child behavior.

8. `orchestration-identity-helper`
   - Sources: `renderer-workspace-state`, `cross-app-type-contracts`.
   - Add `deriveOrchestrationIdentity`.
   - Preserve fallback for old metadata, but make fallback explicit.

### Wave 4: Dispatch, Workspace Runtime, And Hibernation

Goal: make command targeting and runtime readiness truthful.

Candidate PRs:

1. `dispatch-strict-target-and-attach-tab`
   - Source: `dispatch-tiling`.
   - Strict Tiled target resolver.
   - Attach intent carries target tab.

2. `linked-agent-tiled-focus`
   - Source: `dispatch-tiling`.
   - Reuse/generalize `applyDispatchSpawnFocus` for linked agents.

3. `tiled-lane-state-helpers`
   - Source: `dispatch-tiling`.
   - Fix Up/Down empty-lane math.
   - Prune stale tiled lane ids in `pruneSessionOwnership`.

4. `hibernated-runtime-state`
   - Source: `dispatch-tiling`.
   - Add explicit hibernated process state.
   - Rehydrate detached/buried metadata as not writable.

5. `wake-hibernated-session`
   - Source: `dispatch-tiling`.
   - Add wake action and attach wake path.
   - Preserve drafts/metadata on failure.

6. `terminal-duplicate-lane-policy`
   - Sources: `dispatch-tiling`, `main-session-lifecycle`.
   - Block duplicate terminal lanes first, or implement terminal multi-attach later.
   - Keep Claude/Codex duplicates allowed.

7. `workspace-runtime-seeding-helper`
   - Source: `renderer-workspace-state`.
   - Extract `seedResumedRuntimeFields`.

8. `workspace-stale-selection-prune`
   - Source: `renderer-workspace-state`.
   - Ensure `pruneSessionOwnership` also scrubs grid related and tiled lane selections.

### Wave 5: Feed Rendering Correctness

Goal: fix user-visible renderer correctness before large provider refactors.

Candidate PRs:

1. `feed-semantic-regression-tests`
   - Source: `feed-rendering`.
   - Add tests for renderability, semantic scroll signal, subagent output normalization, and tool index invalidation helpers.

2. `feed-tool-index-version`
   - Source: `feed-rendering`.
   - Add `toolIndexVersion`.
   - Update context consumers.

3. `semantic-scroll-revision`
   - Source: `feed-rendering`.
   - Add turn revision or scroll signal for visible block deltas.

4. `semantic-renderability-dom`
   - Source: `feed-rendering`.
   - Running collapsed activity should not count as renderable DOM.

5. `feed-dead-prop-and-context-imports`
   - Source: `feed-rendering`.
   - Remove dead `activityStatus` prop from `Feed`.
   - Import `CodeRenderContext` from `context.tsx`.
   - Fix stale semantic comments.

6. `live-codex-output-result-renderer`
   - Source: `feed-rendering`.
   - Render live Codex output through `CodexToolResultRow` when possible.

7. `live-tool-dispatch-convergence`
   - Sources: `feed-rendering`, `provider-boundary`.
   - Share committed/live dispatch for git cards and `spawn_agent`/`Agent`.

8. `codex-subagent-structured-output`
   - Source: `feed-rendering`.
   - Parse structured array output for Codex `spawn_agent`.

### Wave 6: Conditions Source Of Truth

Goal: remove legacy prompt mirrors and make condition snapshot authority consistent.

Candidate PRs:

1. `condition-selector-foundation`
   - Source: `conditions-framework`.
   - Add selectors for active/visible/actionable conditions, attention, compaction, slash picker.

2. `compaction-condition-authority`
   - Source: `conditions-framework`.
   - Move status model/formatter to condition selectors.
   - Define compact-summary clearing behavior.

3. `condition-attention-unread`
   - Source: `conditions-framework`.
   - Normalize `AttentionLevel`.
   - Include AUQ in unread/attention via shared selector.

4. `slash-picker-authority`
   - Source: `conditions-framework`.
   - Move composer to `slashPickerFromRuntime`.
   - Make screen picker fallback explicit.

5. `remove-pending-mirrors`
   - Source: `conditions-framework`.
   - Remove `pendingApproval`, `pendingTrustDialog`, `pendingResumePrompt`, `pendingPermissionPrompt`, `pendingCompaction` after all consumers move.

6. `condition-harness-support`
   - Source: `conditions-framework`.
   - Rendering harness forwards/subscribes to modern conditions.

7. `condition-core-sync-check`
   - Sources: `conditions-framework`, `headless-packages`.
   - Add sync script `--check` mode or shared package plan.

### Wave 7: Provider Boundary And Headless Package Ownership

Goal: move provider-specific behavior behind explicit registries/capabilities with tests.

Candidate PRs:

1. `provider-renderer-registry-cleanup`
   - Source: `provider-boundary`.
   - Delete dead `extractAssistantInProgress` registry field if choosing standalone dispatcher.
   - Delete `getAllRendererProviders`.
   - Remove default `'claude'` fallback in extractor.

2. `provider-row-shared-primitives`
   - Sources: `provider-boundary`, `feed-rendering`, `global-dead-code`.
   - Extract shared `escapeHtml`, `toHighlightLanguage`, `DiffSlab`, file header pieces.

3. `renderer-provider-capability-foundation`
   - Source: `provider-boundary`.
   - Add provider capabilities to renderer config, populated but minimally consumed.

4. `provider-tool-row-dispatch`
   - Source: `provider-boundary`.
   - Move committed/live tool-row dispatch to provider registry methods.

5. `provider-condition-views-registry`
   - Source: `provider-boundary`.
   - Replace binary condition fallback with registry lookup.

6. `main-provider-resolve-transcript-path`
   - Sources: `provider-boundary`, `main-session-lifecycle`.
   - Add `resolveTranscriptPath` to `MainProviderConfig`.
   - Unify Codex newest-mtime resolver.

7. `package-session-listers`
   - Sources: `headless-packages`, `shared-types-parsers`, `cross-app-type-contracts`.
   - Migrate global Codex listing and session index to package lister or package-backed adapter.

8. `provider-prompt-extraction-helpers`
   - Sources: `headless-packages`, `feed-rendering`.
   - Centralize Codex synthetic prompt filtering and prompt cleanup.
   - Reuse fixtures across renderer, main, and package listers.

9. `parser-owned-resume-sanitizers`
   - Sources: `headless-packages`, `feed-rendering`.
   - Move duplicate/switch sanitizers into `agent-transcript-parser`.

10. `conditions-core-shared-package-design`
   - Source: `headless-packages`.
   - Create shared package only after sync check/parity tests.

11. `opencode-capability-design`
   - Sources: `headless-packages`, `provider-boundary`.
   - Design provider capability/permission contract before active registry integration.

### Wave 8: Debug, Dictation, And Journal Refactors

Goal: fix diagnostic durability, then consolidate duplicate storage primitives.

Candidate PRs:

1. `feed-debug-durable-queue`
   - Source: `storage-debug-perf`.
   - Separate UI ring from durable outgoing queue.
   - Add gap warnings/tests.

2. `proxy-bundle-match-quality`
   - Source: `storage-debug-perf`.
   - Stop silently bundling fallback session proxy logs by default.
   - Add exact/fallback/none metadata.

3. `debug-bundle-storage-class`
   - Source: `storage-debug-perf`.
   - Add explicit `retentionClass`/`captureKind`.
   - Stop inferring autosave/manual from reason prefix only.

4. `dev-debug-ipc-gate`
   - Source: `storage-debug-perf`.
   - Gate paste readback behind dev-debug flag.

5. `dictation-deepgram-only-cleanup`
   - Source: `dictation`.
   - Remove unreachable non-Deepgram provider cases, polish branch, and provider listing IPC.

6. `shared-sha8`
   - Source: `dictation`.
   - Add shared Node/Web `sha8` helpers.
   - Update dictation and paste call sites.

7. `batched-jsonl-writer`
   - Sources: `dictation`, `storage-debug-perf`.
   - Extract writer for ghost/dictation/paste.
   - Keep event schemas unchanged.

8. `dictation-hot-path-gating`
   - Source: `dictation`.
   - Gate chunk hashes/audio-level forensic spam behind dump/verbose flag after journal scan.

9. `dictation-hook-helper-extraction`
   - Source: `dictation`.
   - Extract device/meter/mime helpers.
   - Do not split composer vs terminal lifecycle.

10. `manual-bundle-emergency-retention`
   - Source: `storage-debug-perf`.
   - Product decision needed before implementing.

### Wave 9: Low-Risk Shared Helpers And Cosmetic Dedupe

Goal: reduce maintenance cost after behavior is stable.

Candidate PRs:

1. `as-record-json-guards`
   - Sources: `global-dead-code`, `shared-types-parsers`, `cross-app-duplication`, `feed-rendering`.
   - Extend shared `asRecord` with parse helpers.
   - Migrate app-local duplicates.
   - Package copies need parity or package-local helper.

2. `performance-serialization-shared`
   - Sources: `global-dead-code`, `shared-types-parsers`.
   - Share `serializeError`, `sanitizeData`, and parameterized `areaFromName`.

3. `gitbar-status-contracts`
   - Source: `shared-types-parsers`.
   - Add shared GitBar status types and `parseNumstat`.

4. `cwd-path-display-helper`
   - Sources: `commands-ui-shell`, `cross-app-duplication`.
   - Move/broaden `cwdBasename`.
   - Preserve caller-specific fallbacks and segment counts.

5. `resume-command-helper`
   - Source: `cross-app-duplication`.
   - Share renderer `buildProviderResumeCommand`.

6. `timestamp-parse-format-helpers`
   - Source: `cross-app-duplication`.
   - Shared parse helper and renderer formatting helper.

7. `command-session-mcp-factory`
   - Source: `commands-ui-shell`.
   - Factory for built-in MCP domain toggle commands.
   - Preserve ping dev-debug gate.

8. `use-command-context`
   - Source: `commands-ui-shell`.
   - Collapse 63-prop wall and 70-entry dependency array.
   - Land alone.

9. `ui-shell-modal-consolidation`
   - Source: `commands-ui-shell`.
   - Defer; design required.

## 7. Top First Backlog

If we want the next 20 concrete branches, use this order:

1. `fix/codex-committed-rollout-error`
2. `fix/runtime-release-cache-prime`
3. `test/typecheck-foundation`
4. `fix/rendering-harness-aliases`
5. `fix/heap-snapshot-retention`
6. `fix/render-trace-pruning`
7. `fix/condition-exit-clear`
8. `fix/feed-tool-index-version`
9. `fix/semantic-scroll-revision`
10. `fix/dispatch-strict-targets`
11. `fix/session-removed-cleanup`
12. `fix/session-last-activity-leak`
13. `cleanup/singular-jsonl-ipc`
14. `cleanup/legacy-condition-ipc`
15. `types/provider-kind-source`
16. `types/session-info-contract`
17. `types/session-ipc-contract-map`
18. `fix/feed-debug-durable-queue`
19. `fix/proxy-bundle-match-quality`
20. `cleanup/dictation-deepgram-only`

This order intentionally mixes areas. It avoids one huge renderer PR stack while still front-loading bugs, release safety, and type foundations.

## 8. Decision Register

These need explicit product/architecture decisions before implementation:

1. Manual debug bundle retention:
   - Should old manual bundles ever be pruned under extreme disk pressure?
   - Recommended: protected from normal TTL, not immune to emergency global cap.

2. Hibernated session UX:
   - Wake on attach, explicit Wake command, or wake on submit?
   - Recommended: explicit wake/attach path; block submit.

3. Terminal duplicate lanes:
   - Block duplicate terminal lanes now or implement terminal multi-attach?
   - Recommended: block terminal duplicates first.

4. `inheritParentContext` compatibility:
   - Reject `true`, accept but ignore, or remove public field?
   - Recommended: deprecate and accept-but-ignore for stale clients first.

5. OpenCode integration:
   - Is OpenCode intended as active provider now or research package?
   - Recommended: add capability/design note, do not register runtime until permission mapping is designed.

6. Provider renderer registry direction:
   - Short-term standalone dispatch helpers vs fully registry-owned renderer capabilities.
   - Recommended: remove dead registry fields first, then add capabilities in behavior-neutral PR.

7. `:settings` orphaned persistence key:
   - Delete old key reader or repoint to real Zustand store key for pre-paint theme?
   - Recommended: delete orphan reader unless a measured FOUC needs a real pre-paint persisted read.

8. Dictation non-Deepgram providers:
   - Keep dead multi-provider code for future or narrow to actual Deepgram-only app behavior?
   - Recommended: narrow to Deepgram now; package can still own multi-provider STT.

9. Codex/Claude provider path shared module:
   - New workspace shared package vs package-local helpers plus parity tests?
   - Recommended: parity tests first; shared package only after dependency direction is confirmed.

10. Conditions-core future:
   - Keep sync script with check mode or extract shared package?
   - Recommended: add check mode first; shared package later if package dependency wiring is acceptable.

11. Editor FS and AI workspace unused mutation IPC:
   - Remove until UI exists or keep with explicit security/roadmap comments?
   - Recommended: keep only with explicit owner/first-caller comments and tests; otherwise remove from preload.

12. Before-unload debug autosave:
   - Best-effort only, rolling autosave, or main-renderer close handshake?
   - Recommended: document best-effort first; add close handshake only if product requires stronger guarantee.

## 9. Agent Execution Template

Use this prompt shape for each worker:

```text
You are working in the Agent Code repo on branch <branch> from integration/deep-audit-cleanup.
You are not alone in the codebase. Do not revert edits made by other agents. Own only these files/modules: <ownership>.

Task:
Implement <specific PR title> from docs/audit-plans/deep-audit-master-roadmap.md.

Source audit plans to reread before editing:
- <plan paths>

Required constraints:
- Preserve existing behavior outside the named finding.
- Add thick WHY comments where a new invariant/source of truth is introduced.
- Add or update focused tests listed in the roadmap where practical.
- Run <specific commands>.
- In your final response, list changed files, tests run, and any findings not implemented.
```

For any task touching package boundaries, add:

```text
Do not make headless packages import app src/shared unless you have verified package build and dependency direction. Prefer parity tests or package-local helper extraction.
```

For any task touching renderer state, add:

```text
Do not rely on incidental re-renders. If a mutable object is passed through React context or memoized props, include an explicit identity/version invalidation plan.
```

For any task deleting code, add:

```text
Before deletion, rerun the exact rg confirmation from the source audit plan and include the command/output summary in your final response.
```

## 10. Verification Baseline

The implementation series should converge on these commands. The exact scripts may need Wave 0 work first:

- Typecheck main/preload/renderer.
- Unit tests for touched helpers/reducers.
- Rendering harness build after alias fix.
- Package tests for touched headless packages.
- Manual app smoke for Claude, Codex, terminal, Dispatch, feed, condition prompts, dictation if touched.

Suggested manual smoke matrix after the first few waves:

1. Start Claude, Codex, and terminal sessions.
2. Resume a large Claude and Codex transcript.
3. Trigger Claude trust/permission/resume/compaction and verify condition UI clears on exit.
4. Trigger Codex approval/trust and verify condition UI still works.
5. Run `git status`/`git diff` in Claude and Codex and verify rich cards update when results arrive.
6. Stream long Codex command output while at bottom; verify sticky-bottom holds.
7. Open global Tiled Dispatch, focus empty lane, verify lifecycle commands do not target fallback rows.
8. Rehydrate parked detached sessions and verify they are not writable until wake.
9. Save a debug bundle and inspect render trace/proxy metadata.
10. Run dictation with dump off and on if dictation hot-path gating lands.

## 11. What Not To Do

Do not:

- make one mega PR for all audit cleanup;
- run many code-changing agents in the same files at once;
- delete headless package public APIs without compatibility notes;
- merge package/app shared code by importing app `src/shared` into standalone packages without proving builds;
- collapse all provider differences into one weak optional-field type;
- remove condition mirrors before compaction/status/unread consumers move;
- treat OpenCode as active app provider before permission/condition design;
- mass-rename IPC channels for style only;
- abstract path normalization helpers that have different domain semantics;
- delete `streamJsonl.ts` when the dead file finding is about `jsonlTailer.ts`;
- rely on larger UI caps as a substitute for feed-debug durability.

## 12. Current Integration Branch Next Step

After this roadmap lands, the next practical step is not to launch all implementation agents immediately. The next step is to open 3-4 focused worker branches:

1. Codex committed error event safety.
2. Release runtime cache prime.
3. Heap snapshot retention.
4. Feed tool index invalidation tests/fix.

Those four are independent enough to run in parallel and will validate the integration workflow before larger waves start.
