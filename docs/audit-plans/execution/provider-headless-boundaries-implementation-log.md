# Provider / Headless Boundaries Implementation Log

Worktree: `/Users/juliusolsson/Desktop/Development/agent-code-cluster-worktrees/provider-headless-boundaries`

Branch: `cluster/provider-headless-boundaries`

Date: 2026-06-24

## Implemented

### Provider boundary cleanup

- Removed the dead renderer-registry `extractAssistantInProgress` field and `getAllRendererProviders`.
- Removed the default Claude fallback from `extractAssistantInProgress(screen, provider)`.
- Made `TileLeafProps` describe the real pane props that `TileTree` passes, including related-agent tabs.
- Added renderer provider capabilities for condition views and committed tool-row dispatch.
- Split renderer capabilities into `src/providers/registry.renderer.capabilities.ts` so feed rows can use provider-owned row dispatch without importing the TileLeaf-mounting registry and creating a runtime cycle.
- Moved committed transcript tool-use/tool-result provider dispatch into provider-owned row dispatch modules:
  - `src/providers/claude/renderer/rows/dispatch.tsx`
  - `src/providers/codex/renderer/rows/dispatch.tsx`
- Replaced `ProviderConditionOutlet`'s binary Claude/Codex condition-view fallback with the provider capability registry.

### Shared row primitives

- Extracted `escapeHtml` and `toHighlightLanguage` to `src/shared/code/htmlHighlight.ts`.
- Extracted the duplicated Claude/Codex diff slab to `src/providers/shared/renderer/rows/DiffSlab.tsx`.
- Updated Claude, Codex, and Git rows to use the shared helper where applicable.

### Main provider path boundary

- Added `MainProviderConfig.resolveTranscriptPath(cwd, providerSessionId)`.
- Moved the Claude path join and Codex rollout filename search out of `historyLoader` and behind `registry.main.ts`.

### Dead IPC and dead tailer cleanup

- Removed the dead legacy per-event condition relay:
  - `trust-dialog`
  - `resume-prompt`
  - `permission-prompt`
  - `compaction-state`
- Removed the matching stale preload subscription methods and event types.
- Deleted `src/shared/runtime/jsonlTailer.ts`.
- Updated `streamJsonl.ts` so it no longer points future readers at the deleted app-local tailer.

### App duplicate helper cleanup

- Extended `src/shared/lib/asRecord.ts` with `isRecord`, `asRecordArray`, and `parseJsonRecord`.
- Migrated app-local JSON object guards in main and renderer call sites to the shared helper where package boundaries allow.
- Added focused tests for `asRecord` helpers.
- Extracted renderer resume command generation to `src/renderer/src/workspace/providerResumeCommand.ts`.
- Replaced duplicate command builders in session commands and prompt templates.
- Added focused tests for resume command quoting.

## Confirmation Searches

Before deleting `src/shared/runtime/jsonlTailer.ts`, ran:

```text
rg -n "extractAssistantInProgress|getAllRendererProviders|jsonlTailer|tailNewSessionFile|tailSessionFile|session:trust-dialog|session:resume-prompt|session:permission-prompt|session:compaction-state" src packages docs tests
```

Code hits for `jsonlTailer|tailNewSessionFile|tailSessionFile` were limited to the file being deleted and a stale comment in `streamJsonl.ts`; remaining hits were historical docs. After deletion and comment cleanup:

```text
rg -n "SessionTrustDialogEvent|SessionResumePromptEvent|SessionPermissionPromptEvent|SessionCompactionStateEvent|onSessionTrustDialog|onSessionResumePrompt|onSessionPermissionPrompt|onSessionCompactionState|session:trust-dialog|session:resume-prompt|session:permission-prompt|session:compaction-state|jsonlTailer|tailNewSessionFile|tailSessionFile" src packages
```

Result: no matches.

For renderer extractor cleanup:

```text
rg -n "getAllRendererProviders|\\.extractAssistantInProgress|extractAssistantInProgress\\([^,\\n]+\\)" src
```

Result: no matches.

## Skipped / Blocked

- Could not implement the Codex committed-channel `error` -> `rollout_error` package fix because all local headless package directories are empty in this worktree:
  - `packages/codex-headless`
  - `packages/claude-code-headless`
  - `packages/agent-transcript-parser`
  - `packages/opencode-headless`
- Did not move prompt extraction, parser-owned resume sanitizers, conditions-core, channel types, or package path helpers because the package sources are unavailable and package builds cannot be verified.
- Did not route live semantic `BlockRow` through `registry.renderer`. The live event type currently lives in renderer workspace state; forcing that through shared provider config would either import renderer types into shared or create a renderer registry cycle. The committed plane is now provider-owned; live-plane dispatch remains a follow-up that should start by splitting a renderer-safe live block dispatch contract.
- Did not register or design OpenCode integration. The audit calls that an architecture/product decision, not a mechanical provider-row cleanup.

## Verification

Attempted:

```text
npm run test:unit -- src/shared/lib/asRecord.test.ts src/renderer/src/workspace/providerResumeCommand.test.ts
```

Blocked: local dependencies are not installed. Vitest failed to load `vitest.config.ts` because `@vitejs/plugin-react` and `vitest/config` could not be resolved.

Attempted:

```text
npx tsc -b tsconfig.web.json --pretty false
```

Blocked: TypeScript is not installed in this worktree; `npx` resolved to the placeholder package message.

Completed:

```text
git diff --check
```

Result: passed.

Dependency baseline:

```text
test -d node_modules && echo node_modules-present || echo node_modules-missing
```

Result: `node_modules-missing`.

## Remaining Risks

- The focused test files were added but could not be executed without installing dependencies.
- Typecheck could not be run for the same reason.
- The package-level Codex committed-channel crash fix remains the highest-priority unimplemented item once package sources are present.
- Live semantic tool-row dispatch still duplicates provider tables in `BlockRow.tsx`.
- Session-index prompt extraction ownership remains unresolved because package APIs could not be inspected or changed in this worktree.

## Second Pass - 2026-06-24

### Rechecked Inputs

- Re-read/check-scanned the assigned plans and verified their sizes:
  - `provider-boundary.md`: 736 lines.
  - `headless-packages.md`: 1666 lines.
  - `cross-app-duplication.md`: 1414 lines.
- Re-inspected the current diff, first-pass log, and deletion confirmations before further edits.
- Confirmed the package source directories are empty in this worktree:
  - `find packages/codex-headless packages/claude-code-headless packages/agent-transcript-parser packages/opencode-headless -maxdepth 1 -mindepth 1 -print` produced no output.

### Classification Against Provider Boundary Plan

- Done: F1 (`RendererProviderConfig.extractAssistantInProgress` and `getAllRendererProviders` removed; explicit provider required by the standalone dispatcher).
- Done/partial by design: F2 renderer registry is now load-bearing for condition views and committed tool-row dispatch. The second pass removed the first-pass condition-view prop leak from `TileLeafProps`; `ProviderConditionOutlet` now uses `registry.renderer.capabilities.ts` directly, which avoids a `TileLeaf` runtime cycle and keeps condition view types renderer-owned.
- Done/partial by design: F3 committed transcript `tool_use` / `tool_result` dispatch is provider-owned. Live semantic `BlockRow` dispatch is intentionally deferred because its event types live in renderer workspace state; forcing it through shared provider config would import renderer state into shared or recreate the registry cycle.
- Done: F4 shared `DiffSlab`, `escapeHtml`, and highlight-language helpers extracted.
- Done: F5 `TileLeafProps` matches the real shell props without local casts; second pass removed the accidental condition-view registry from the shell prop contract.
- Done: F6 `MainProviderConfig.resolveTranscriptPath` owns Claude path join and Codex rollout filename lookup.
- Deferred: F7 turn-ownership policy remains untouched; the plan explicitly marks it last and behind streaming/replay tests.
- Partial/deferred: F8 capability descriptor now exists for concrete provider-owned surfaces added here, but broad `isAgentKind` and capability-flag migration remains separate.
- Done for owned surfaces: F9 default Claude fallback removed from `extractAssistantInProgress`; condition-view binary fallback removed. Other binary conditionals remain outside this cluster's safe vertical slice.
- Done: F10/A1 dead per-event condition relay removed through main, forwarder, preload, and types.
- Deferred: `shellSessionId` option normalization was not broadened; it is lower priority and tied to the wider F8 option-shape work.

### Classification Against Headless Packages Plan

- Blocked: Finding 1 Codex committed-channel `error` -> non-special event cannot be implemented because `packages/codex-headless` is empty locally. No package tests or API docs can be edited or run in this worktree.
- Done/partial: Finding 2 session listing now routes cwd listing through `MainProviderConfig`, routes global `session:list-all` through the provider registry, uses the package Codex lister there, and deletes the dead app-local `src/providers/codex/runtime/sessionList.ts`. Claude's app-local global walker remains as a compatibility shim because the available package API is cwd-scoped.
- Deferred: Finding 3 shared prompt extraction/synthetic filtering requires package helper/API work and fixtures; not safe with empty packages.
- Deferred: Finding 4 parser-owned resume sanitizers requires `agent-transcript-parser` source and package tests.
- Done: Finding 5 `SessionInfo` is now sourced from `src/shared/types/session.ts` in preload, renderer UI, and Claude's app-local lister shim.
- Deferred: Finding 6 conditions-core package extraction requires package sources and standalone package builds.
- Deferred: Finding 7 channel contracts / `LineDiff` extraction requires package source availability and package build verification.
- Deferred: Finding 8 OpenCode integration remains a product/architecture decision; provider is not registered.
- Deferred/invalid for this cluster: Finding 9 proxy API gaps include Electron packaging policy that the plan says should stay app-owned.
- Done: Finding 10 stale app JSONL tailer deleted after confirmation search.
- Deferred: Finding 11 project-dir helper consolidation still has main-process callers (`sessionIndex`, provider switch, worktree activity). Replacing them without package source/build verification would be a path-contract change.
- Deferred: Finding 12 subagent accumulator extraction is not on the critical provider/headless path and needs focused behavior tests.
- Deferred with reason: Finding 13 Claude committed tool-result bridge remains. The plan calls it a documented workaround until committed-event IPC/reducer handling exists.

### Classification Against Cross-App Duplication Plan

- Deferred: Finding 1 provider path derivation needs package path APIs and characterization tests.
- Partial/done for app cleanup: Finding 2 deleted the dead app JSONL tailer; shared package tailer extraction remains deferred because package tailers are unavailable.
- Deferred: Finding 3 timestamp parsing/formatting remains; not provider-boundary critical and needs output-stability checks across modals.
- Done for high-confidence local duplicates: Finding 4 `asRecord` / JSON record parsing now has shared helpers and remaining code hits are only the source helper.
- Deferred: Finding 5 terminal attach/replay is separate behavior work.
- Done: Finding 6 resume shell-command generation extracted to `providerResumeCommand.ts` with focused tests.
- Deferred: Finding 7 path label/basename consolidation is lower priority and has UI-display nuance.
- Deferred: Finding 8 generic error helpers are lower priority and several existing mappers are domain-specific.
- Deferred: Finding 9 capped buffers/rings require behavior tests and policy separation.
- Deferred: Finding 10 sidecar/ghost filtering is intentionally layered; no proxy sidecar flow changes were made.
- Done: Additional Finding B addressed for the strongest local pure helpers with `asRecord` and resume-command tests, although test execution is blocked by missing deps.

### Second-Pass Changes Added

- Added `MainProviderConfig.listAllSessions` as an optional provider-owned global listing capability for debug inventory paths.
- Switched `session:list-all` to use `getMainProvider(...).listAllSessions` instead of importing provider listers directly.
- Moved Codex global listing to the package lister through `registry.main.ts`.
- Deleted `src/providers/codex/runtime/sessionList.ts` after confirming no code callers remained.
- Removed condition view registries from `TileLeafProps` and `TileTree` plumbing.
- Changed `ProviderConditionOutlet` to resolve views through `registry.renderer.capabilities.ts`, avoiding both binary fallbacks and `TileLeaf` import cycles.
- Kept the shared provider config's condition-view field opaque (`Record<string, unknown>`) so shared provider types do not import renderer-only `ConditionView`.
- Migrated remaining local `parseJsonRecord` duplicates in `src/main/sessionIndex.ts` and `src/shared/work-context/extractors.ts` to `src/shared/lib/asRecord.ts`.
- Replaced remaining local `SessionInfo` shape copies in preload, renderer path picker, renderer command palette, and Claude's app-local lister shim with the shared type.

### Second-Pass Confirmation Searches

```text
rg -n "getAllRendererProviders|\\.extractAssistantInProgress|extractAssistantInProgress\\([^,\\n]+\\)|SessionTrustDialogEvent|SessionResumePromptEvent|SessionPermissionPromptEvent|SessionCompactionStateEvent|onSessionTrustDialog|onSessionResumePrompt|onSessionPermissionPrompt|onSessionCompactionState|session:trust-dialog|session:resume-prompt|session:permission-prompt|session:compaction-state|jsonlTailer|tailNewSessionFile|tailSessionFile" src packages
```

Result: no matches.

```text
rg -n "type SessionInfo =|interface SessionInfo|function parseJsonRecord|const parseJsonRecord|@providers/codex/runtime/sessionList|providers/codex/runtime/sessionList|listCodexSessions" src packages
```

Result: only the shared `SessionInfo`, shared `parseJsonRecord`, and package `listCodexSessions` references in `registry.main.ts`.

```text
rg -n "conditionViews=|registry=\\{conditionViews\\}|import type \\{ ConditionView \\} from '@shared/conditions-core/view'" src/renderer/src/workspace/tile-tree src/shared/types/providerConfig.ts src/providers/shared/renderer/conditions/ProviderConditionOutlet.tsx src/providers/registry.renderer.capabilities.ts
```

Result: only the intentional renderer capability-registry `ConditionView` import.

### Second-Pass Verification

Completed:

```text
git diff --check
```

Result: passed.

Completed:

```text
test -d node_modules && echo node_modules-present || echo node_modules-missing
```

Result: `node_modules-missing`.

Attempted again:

```text
npm run test:unit -- src/shared/lib/asRecord.test.ts src/renderer/src/workspace/providerResumeCommand.test.ts
```

Blocked: Vitest still cannot resolve `@vitejs/plugin-react` or `vitest/config` because dependencies are not installed.

Attempted again:

```text
npx tsc -b tsconfig.web.json --pretty false
```

Blocked: TypeScript is not installed in this worktree; `npx` returned the placeholder package message instead of a compiler run.

### Second-Pass Residual Risks

- Typecheck and focused tests remain unexecuted because `node_modules` is missing.
- Package-internal changes remain blocked because the assigned package directories are empty. The highest-priority remaining item is still the Codex committed-channel `error` event rename once `packages/codex-headless` is available.
- Deleting `src/providers/codex/runtime/sessionList.ts` now depends on the existing `codex-headless` package import resolving in the integrated workspace. This is consistent with `registry.main.ts` already using that package lister, but it could not be compiled here.
- Claude's app-local global session walker remains as a compatibility shim until `claude-code-headless` exposes and verifies an equivalent global listing API.
- Live semantic tool-row dispatch, prompt extraction, parser-owned resume sanitizers, project-dir helper consolidation, conditions-core extraction, channel contracts, and timestamp/path/error helper cleanup remain deliberate follow-up work.
