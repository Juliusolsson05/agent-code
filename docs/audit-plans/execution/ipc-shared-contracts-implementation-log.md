# IPC / Shared Contracts — Implementation Log

Cluster branch: `cluster/ipc-shared-contracts` (base `integration/deep-audit-cleanup`).

Source audit plans implemented from:
- `ipc-preload-api.md`
- `cross-app-type-contracts.md`
- `shared-types-parsers.md`

This log records: the confirmation searches run before any deletion (per the
master-roadmap review rule), every finding implemented / partial / skipped, the
files changed, the checks run, residual risks, and a **Second pass / recovery**
section documenting how an interrupted session was picked back up.

The unifying thesis of this cluster: **a value that crosses the renderer↔main
IPC boundary, or is mirrored across `src/main` / `src/preload` / `src/renderer`,
must have exactly one type definition and one parser.** Three identical copies
of a shape compile happily while silently drifting; the whole point is to turn
that silent drift into a compile error.

---

## Confirmation searches run before deletion

(Recorded verbatim so a reviewer can re-run them.)

### Singular JSONL (ipc-preload-api Finding 2)
```
rg -n "onSessionJsonlEntry\b|session:jsonl-entry\b" src packages testing
```
Result: only the dead preload method `onSessionJsonlEntry` + its `subscribe('session:jsonl-entry')`
in `src/preload/api/session.ts`, plus explanatory comments in
`jsonlCoalescer.ts` and `useIpcSubscriptions.ts`. No emitter, no renderer
subscriber. Safe to remove the preload method + `SessionJsonlEntryEvent` type.
Re-verified at recovery time — only comments remain (see Second pass).

### Legacy per-condition channels (ipc-preload-api Finding 1)
```
rg -n "onSession(TrustDialog|ResumePrompt|PermissionPrompt|CompactionState)|session:(trust-dialog|resume-prompt|permission-prompt|compaction-state)" src packages testing
rg -n "onSessionTrustDialog|onSessionResumePrompt|onSessionPermissionPrompt|onSessionCompactionState" src/renderer testing/rendering/renderer
```
Result: NO renderer/harness callers of the four `onSession*` preload listeners.
Forwarding existed in `forwarder.ts` (4 `sendToMainWindow`) and the harness
`testing/rendering/main.ts` (3 `send`). The renderer consumes only
`session:conditions`. Manager + provider runtime still emit the legacy events
internally — those are owned by the conditions-framework / provider-boundary
clusters and are intentionally LEFT IN PLACE here (see Skipped).

### Small unused renderer IPC (ipc-preload-api Finding 3)
```
rg -n "window\.api\.(changeLspDocument|listDictationProviders|startCaffeinate|stopCaffeinate|listAllSessions)" src/renderer testing/rendering/renderer
```
Result: `listAllSessions` IS used by `testing/rendering/renderer/RenderingHarnessApp.tsx:766`
→ NOT dead, kept. The other four have no callers but their removal is a
product decision (see Skipped).

### Removed-symbol cleanliness (re-run at recovery time)
```
rg -n "onSessionJsonlEntry\b|SessionJsonlEntryEvent|session:jsonl-entry\b" src testing   # only comments + coalescer
rg -n "onSession(TrustDialog|ResumePrompt|PermissionPrompt|CompactionState)" src testing # only comments
rg -n "Session(TrustDialog|ResumePrompt|PermissionPrompt|CompactionState)Event" src testing # only comments in preload/api/types.ts
rg -n "@preload" src/main                                                                # caffeinate hit is a comment; rest out of scope
```
Result: no live references to any removed symbol. `src/main` still imports a
handful of OTHER types from `@preload` (`SubAgentState`, `JsonlEntry`,
`DictationDebugEvent`, `PasteDebugEvent`) — those were out of this cluster's
scope; the caffeinate layering inversion specifically targeted by the plan IS
fixed (see Finding 9, "Caffeinate layering").

---

## Findings implemented

Each entry maps to the plan(s) it satisfies. "Pattern" notes whether the shape
was hoisted to a new shared module, aliased, or re-exported for back-compat.

### 1. GitBar `git:status` contract + numstat parser
Plans: shared-types Item 8.1 (primary).
- **New** `src/shared/types/gitStatus.ts` — `GitNumstatLine`, `GitRecentCommit`,
  `GitSubmoduleStatus`, `GitBarStatusResult` (discriminated `ok:true | ok:false`).
  Named `GitBar*` deliberately because `GitStatusResult` is already taken in
  `src/shared/git/gitParse.ts` for an unrelated porcelain-status parser.
- **New** `src/shared/git/numstat.ts` — `parseNumstat` extracted out of
  `main/ipc/git.ts` (pure, Node-free). Binary `-` rows coerce to 0/0; malformed
  lines skipped.
- Producer `src/main/ipc/git.ts`: `git:status` handler return annotated
  `Promise<GitBarStatusResult>`; local `NumstatLine` / `SubmoduleInfo` now alias
  the shared types; `commits` typed `GitRecentCommit[]`.
- Bridge `src/preload/api/git.ts`: `gitStatus()` returns `Promise<GitBarStatusResult>`
  (was a hand-inlined copy of the whole union).
- Consumer `src/renderer/src/features/git/ui/GitBar.tsx`: `GitFile` / `GitCommit`
  / `GitSubmodule` alias the shared types; `GitData = Extract<GitBarStatusResult, { ok: true }>`.
- All three boundary layers now reference one source of truth — the original
  audit-flagged "declared inline in three places" is closed end to end.

### 2. Editor FS IPC result contract
Plans: shared-types Item 1.1, ipc-preload Finding 4 (subset).
- **New** `src/shared/types/editorFs.ts` — `EditorFsEntry`, `EditorFsListResult`,
  `EditorFsReadResult`, `EditorFsWriteResult` (keeps `conflict?: boolean`),
  `EditorFsMutationResult`. `size: number | null` invariant preserved.
- `src/main/ipc/editorFs.ts` imports them (validation stays in main).
- `src/preload/api/editorFs.ts` re-exports them (renderer barrel imports keep working).
- `src/renderer/.../ExplorerPane.tsx` imports `EditorFsEntry` from shared (was local).

### 3. Performance telemetry serialization/redaction
Plans: shared-types Item 2.1.
- **New** `src/shared/performance/serialization.ts` — `serializePerformanceError`,
  `sanitizePerformanceData({verbose})`, `areaFromPerformanceName(name, fallback)`.
  This is a **privacy control** (drops `prompt|content|text|env|token|secret|key`
  unless verbose; truncates 300/2000); single-sourcing it means main and renderer
  can't redact differently. Per-process `area` fallback stays a caller param
  ('app' for main, 'renderer' for renderer).
- `src/main/performance/PerformanceService.ts` + `src/renderer/src/performance/client.ts`
  replace their byte-identical local copies with thin aliases over the shared fns.

### 4. Sanitizer consolidation (two distinct, named helpers)
Plans: shared-types Item 3.1, ipc-preload Finding 5.
- `src/shared/runtime/projectDir.ts` gains:
  - `sanitizePathSegment(value)` — dash-collapsing provider proxy-event storage
    segment sanitiser (shared by the Codex writer and the debug-bundle reader;
    the Claude headless package keeps an intentional package-local mirror).
    Returns `''` for empty/all-separator input; callers supply their own fallback.
  - `sanitizeFilenameToken(value)` — underscore escape rule for session-keyed
    storage file names (feed-debug JSONL, debug-bundle folder suffix). MUST NOT
    change output or existing on-disk logs/bundles orphan.
- Migrated call sites: `proxyEventsReader.ts` + `codexSession.ts` →
  `sanitizePathSegment` (codex keeps its `|| 'unknown'` fallback); `debugBundle.ts`
  + `feedDebugLog.ts` → `sanitizeFilenameToken`. Two semantics kept deliberately
  separate (the plan explicitly warned against one generic `sanitize`).

### 5. Provider/session kind source of truth
Plans: cross-app Finding 9, shared-types Item 4.1, ipc-preload Finding 4 (subset).
- **New** `src/shared/types/providerKind.ts` — `AGENT_PROVIDER_KINDS` (const
  array, the one place to add a provider), derived `AgentProviderKind`,
  `SessionKind = AgentProviderKind | 'terminal'`, `SESSION_KINDS`,
  `isAgentProviderKind` / `isSessionKind` guards. `'terminal'` deliberately is
  not an `AgentProviderKind`.
- `SessionKind` re-exported from `sessionManager.ts`, `preload/api/types.ts`,
  `renderer/workspace/types.ts`, `shared/types/session.ts` (all previously
  redeclared the bare union). Re-export keeps every existing import path working.
- Registries `registry.main.ts` / `registry.renderer.ts` typed
  `Record<AgentProviderKind, …>` (was `Record<string, …>`) + validate via
  `isAgentProviderKind` before indexing. Adding a kind without a config is now a
  **compile error** — the intended provider-integration checklist.
- `shared/types/providerConfig.ts`: `MainProviderConfig.id` / `RendererProviderConfig.id`
  narrowed from `string` to `AgentProviderKind`.

### 6. `SessionInfo` consolidation (renderer/harness duplicates removed)
Plans: cross-app Finding 2 (subset), shared-types Item 4.2, ipc-preload Finding 4.
- Canonical `SessionInfo` already lived at `src/shared/types/session.ts:44`.
- Removed local copies in `CommandPalette.tsx` (which had **dropped `fileSize`
  and `customTitle`** — a concrete instance of the drift this cluster prevents),
  `PathPickerModal.tsx`, and harness `RenderingHarnessApp.tsx`
  (`HarnessSessionInfo = SessionInfo & { provider: AgentProviderKind }`).

### 7. Unknown-JSON record guards (`asRecord` / `parseJsonRecord`)
Plans: shared-types Item 6.1, ipc-preload Finding 7.
- `src/shared/lib/asRecord.ts` gains `parseJsonRecord(text)` (JSON.parse +
  record-narrow + try/catch in one place).
- Migrated app-local copies to the shared helper:
  `AgentTranscriptReader.ts` (adapts with `?? undefined` for its 10 call sites),
  `codexResumeSanitizer.ts` (**behavior fix**: its local copy accepted arrays as
  records; the shared helper correctly excludes them), `AskUserQuestionRow.tsx`,
  `renderUnits.ts` (its `parseRecord` → `parseJsonRecord`), `ghosts.ts`.
- Package-local copies left in place (package independence).

### 8. Debug-bundle / LSP / Claude-image IPC contracts
Plans: shared-types Item 7.1, cross-app Finding 8 (subset), ipc-preload Finding 4.
- **New** `src/shared/types/debugBundle.ts` (`DebugBundleFile`,
  `SaveDebugBundleParams`, `SaveDebugBundleResult`), `src/shared/types/lsp.ts`
  (`LspDiagnostic`, `LspDiagnosticsEvent`, `LspSemanticLegend`),
  `src/shared/types/claudeImage.ts` (`SaveClaudeImageParams`, `SavedClaudeImage`).
- Main owners (`debugBundle.ts`, `lspManager.ts`, `claudeImageCache.ts`) import +
  re-export from shared so existing `@main/*` importers keep their paths;
  validation stays in main. `preload/api/types.ts` re-exports from shared (the
  stale "duplicated because of tsconfig contexts" comment was removed — both
  contexts already import `@shared/*`). `preload/api/fs.ts` uses
  `SaveClaudeImageParams` instead of inlining the params a third time.

### 9. Caffeinate type layering inversion
Plans: ipc-preload Finding 4 (the explicit `@preload` → `src/main` violation).
- **New** `src/shared/types/caffeinate.ts` (`CaffeinateStatus`,
  `CaffeinateCommandResult`). `main/caffeinate/CaffeinateController.ts` now
  imports them from `@shared` instead of `@preload/api/types` — a main module
  must not depend on the renderer bridge for its own types.
  `preload/api/types.ts` re-exports for back-compat.

### 10. AI-workspace write params contract
Plans: cross-app Finding 8 (Item F8-AiWorkspace-WriteParams-Contract).
- `src/mcp/shared/aiWorkspaceTypes.ts` gains `AiWorkspaceWriteFileParams`
  (`path`, `text`, `expectedMtimeMs?: number | null` — the optimistic-concurrency
  guard whose nullability must not drift across the three sites). Used by
  `AiWorkspaceRegistry.writeFile`, the `ai-workspace:write-file` IPC handler, and
  the `aiWorkspaceWriteFile` preload bridge (all three previously inlined it).

### 11. Legacy per-condition IPC channels removed
Plans: ipc-preload Finding 1.
- Removed renderer-facing exposure of `session:trust-dialog` /
  `:resume-prompt` / `:permission-prompt` / `:compaction-state`: the four
  `onSession*` preload listeners, their forwarding in `forwarder.ts`, the harness
  forwarding in `testing/rendering/main.ts`, the four `Session*Event` payload
  types in `preload/api/types.ts`, and their re-exports in `preload/index.ts`.
- The renderer derives all of that state from the unified
  `ProviderConditionSnapshot` via `onSessionConditions`. The manager + provider
  runtimes STILL emit the granular events internally — deprecating those is
  owned by the conditions-framework / provider-boundary clusters.

### 12. Dead singular JSONL bridge removed
Plans: ipc-preload Finding 2.
- Removed `onSessionJsonlEntry` preload method, `SessionJsonlEntryEvent` type,
  and its `preload/index.ts` re-export. Main emits JSONL only through the
  coalescer (`session:jsonl-entries`); a live single entry arrives as a
  1-element bulk burst. Thick comments left at the removal sites explaining why
  reviving a singular channel reintroduces the bootstrap-replay scroll cascade.

### 13. Rendering-harness headless package aliases fixed (real bug)
Plans: shared-types Additional Finding A.
- `testing/rendering/electron.vite.config.ts`: the `headlessAlias` map pointed at
  `repoRoot/claude-code-headless/...` etc. — directories that **do not exist**;
  the workspaces live under `packages/`. Corrected to `packages/<pkg>/src/index.ts`.
  Thick comment ties these to the tsconfig `paths` maps they must stay in step with.

---

## Findings partially implemented

- **`SessionInfo` / provider-lister unification (cross-app Finding 2, shared-types
  Finding 10).** Renderer/harness duplicates were removed (Finding 6 above), but
  the deeper consolidation — migrating `src/providers/codex/runtime/sessionList.ts`
  onto the `codex-headless` package lister and **deleting** the app-local file,
  plus a `ProviderSessionInfo = SessionInfo & { provider }` tagged type and
  cross-package parity tests — was NOT done. It touches provider-runtime parsing
  and performance spans (`providers.codex.listSessions`) and belongs with the
  provider-boundary cluster. Deferred.

- **Stale-docs cleanup (ipc-preload Finding 11, cross-app Finding 10).** The
  in-code stale comments were updated (the `@preload/api/types` duplication
  comment, the JSONL removal comments, the harness alias comment). The historical
  plan-doc banners (`docs/superpowers/plans/2026-04-15-bootstrap-replay-perf.md`,
  `…/2026-04-12-provider-isolation.md`, etc.) were NOT annotated — low value,
  history-only, and the no-enforcement-bloat guidance argues against churning
  archived plans. Deferred.

## Findings skipped and why

- **Session IPC channel-typing map (cross-app Finding 1: `SessionIpcInvokeMap` /
  `SessionIpcEventMap`).** A large, invasive change touching every `session:*`
  handler and the preload `invoke`/`subscribe` plumbing. High blast radius for a
  pre-open-source hardening pass; deferred to a dedicated PR. The concrete payload
  types it would map (`SpawnSessionOptions`, `SessionProcessStateEvent`, etc.)
  remain inline.
- **Semantic-event typed adapter (cross-app Finding 3).** Requires importing
  provider package event unions into the renderer and a `classifySemanticEvent`
  boundary. Forward-compat (`event: unknown`) must be preserved; non-trivial.
  Deferred.
- **`inheritParentContext` deprecation (cross-app Finding 5).** Public
  orchestration-schema change; needs an owner decision on whether to reject stale
  `true` callers. Deferred (explicitly owner-gated in the plan).
- **Orchestration identity helper (cross-app Finding 6).** Renderer orchestration
  projection refactor; out of the IPC/shared-types core. Deferred.
- **Unused renderer IPC removal (ipc-preload Finding 3: `listDictationProviders`,
  `changeLspDocument`, `startCaffeinate`/`stopCaffeinate`).** No in-repo callers,
  but each is a product decision (staged capability vs. truly dead). Left in place
  with the confirmation searches recorded above. AI-workspace attach/detach/delete
  and editor mutation methods likewise left staged.
- **`composeApiDomains` collision guard (ipc-preload Finding 8), channel-naming
  constants (Finding 9), condition-selector constants (Finding 10).** Convention/
  ergonomics improvements with no current bug; the no-scaffolding-bloat guidance
  argues against adding enforcement here. Deferred.
- **Parity/fixture test suites the plans propose** (diffLines tri-impl parity,
  alias-config parity, provider-condition assignability, transcript fixtures,
  hotkey-parser extraction, work-context accessor extraction). These are
  test-authoring / cross-package-extraction tasks, several explicitly package-
  boundary-sensitive. The cluster instead added focused unit tests for the shared
  helpers it actually created (see Tests). The broader parity suites are deferred
  to a test-hardening pass.
- **Remaining `@preload` imports in `src/main`** (`SubAgentState`, `JsonlEntry`,
  `DictationDebugEvent`, `PasteDebugEvent` in subagents / dictation / paste-debug
  journals). The plan's Finding 4 names these as a broader layering cleanup; this
  cluster scoped the layering fix to the caffeinate violation it called out
  specifically. The rest is residual debt (see Risks).

---

## Files changed

**New shared modules**
- `src/shared/types/gitStatus.ts`
- `src/shared/git/numstat.ts`
- `src/shared/types/editorFs.ts`
- `src/shared/types/caffeinate.ts`
- `src/shared/types/claudeImage.ts`
- `src/shared/types/debugBundle.ts`
- `src/shared/types/lsp.ts`
- `src/shared/types/providerKind.ts`
- `src/shared/performance/serialization.ts`

**New tests** (`testing/unit/shared/`)
- `asRecord.test.ts`, `performanceSerialization.test.ts`, `providerKind.test.ts`,
  `sanitizePath.test.ts`, `numstat.test.ts` (the last added during recovery — see
  Second pass).

**Modified — main**
- `agentTranscripts/AgentTranscriptReader.ts`, `aiWorkspace/AiWorkspaceRegistry.ts`,
  `caffeinate/CaffeinateController.ts`, `ipc/aiWorkspace.ts`, `ipc/editorFs.ts`,
  `ipc/git.ts`, `lspManager.ts`, `performance/PerformanceService.ts`,
  `providerSwitch/codexResumeSanitizer.ts`, `sessionManager.ts`,
  `sessions/forwarder.ts`, `storage/claudeImageCache.ts`, `storage/debugBundle.ts`,
  `storage/feedDebugLog.ts`, `storage/proxyEventsReader.ts`.

**Modified — shared / mcp**
- `shared/lib/asRecord.ts`, `shared/runtime/projectDir.ts`,
  `shared/types/providerConfig.ts`, `shared/types/session.ts`,
  `mcp/shared/aiWorkspaceTypes.ts`.

**Modified — preload**
- `preload/api/aiWorkspace.ts`, `preload/api/editorFs.ts`, `preload/api/fs.ts`,
  `preload/api/git.ts`, `preload/api/session.ts`, `preload/api/types.ts`,
  `preload/index.ts`.

**Modified — providers**
- `providers/codex/runtime/codexSession.ts`, `providers/registry.main.ts`,
  `providers/registry.renderer.ts`.

**Modified — renderer**
- `features/command-palette/ui/CommandPalette.tsx`, `features/editor/ui/ExplorerPane.tsx`,
  `features/feed/ui/semantic/AskUserQuestionRow.tsx`,
  `features/feed/ui/semantic/renderUnits.ts`, `features/git/ui/GitBar.tsx`,
  `features/path-picker/ui/PathPickerModal.tsx`, `performance/client.ts`,
  `workspace/ghosts.ts`, `workspace/types.ts`.

**Modified — testing harness**
- `testing/rendering/electron.vite.config.ts`, `testing/rendering/main.ts`,
  `testing/rendering/renderer/RenderingHarnessApp.tsx`.

---

## Tests run

- `npx vitest run testing/unit/shared` → **5 files, 31 tests, all pass**
  (asRecord/parseJsonRecord, performance serialization+redaction,
  providerKind guards/exhaustiveness, sanitizePathSegment/sanitizeFilenameToken,
  parseNumstat).
- `npx vitest run --project unit` → **64 tests pass**; 3 test files fail to
  *import* (`testing/unit/proxy/*`, `testing/unit/channels/semanticChannel.*`)
  because they `import` from `packages/claude-code-headless/src/proxy/*` modules
  that don't exist in this checkout. **Pre-existing and unrelated** — none of
  those files are touched by this cluster.
- `git diff --check` → clean (no whitespace/conflict markers).
- `tsc -p tsconfig.node.json --noEmit` and `tsc -p tsconfig.web.json --noEmit`:
  **zero type errors in any cluster-created or cluster-modified file.** The 43
  node-project errors are all in untouched files and are environmental —
  `TS2307 Cannot find module 'claude-code-headless'/'codex-headless'/'agent-voice-dictation'`
  (bare `tsc` doesn't apply the electron-vite workspace aliases) plus the
  implicit-`any` cascade those package-resolution failures produce. The two
  web-project `TS6305` notices ("output not built from source") were a composite-
  project build-ordering artifact referencing our two newest shared files, not a
  type error; the stray `.tsc-out/` they came from is gitignored and was removed.

## Manual verification performed / still needed

- Static verification done (typecheck filtered to cluster files, unit tests,
  removed-symbol greps).
- **Still needed — smoke test in the running app** (cannot be done headlessly
  here): open the **GitBar** in a repo with a dirty submodule (exercises
  `GitBarStatusResult` + `parseNumstat` across the IPC boundary); open the
  **command palette** resume list and the **⌘T path picker** (shared `SessionInfo`);
  paste an image into Claude (`SaveClaudeImageParams`); trigger an **editor FS**
  list/read/write conflict; confirm **conditions** UI (trust dialog / resume /
  permission / compaction) still renders purely from `session:conditions`;
  `npm run testing:rendering:build` to confirm the corrected headless aliases
  resolve.

## Cross-cluster conflicts / merge risks

- **Conditions-framework / provider-boundary clusters**: this cluster stops
  *bridging* the legacy per-condition events over IPC but leaves the manager/
  provider-runtime emitters intact. If another cluster removes those emitters,
  the two changes compose cleanly; if one re-adds renderer consumption of the
  granular channels, it conflicts with the removals here.
- **Provider-boundary cluster**: owns the Codex lister consolidation + deletion
  this cluster deferred. Both touch `providers/codex/runtime/sessionList.ts`'s
  callers.
- **Shared `providerKind.ts`** is now imported widely; another cluster adding a
  provider must edit `AGENT_PROVIDER_KINDS` (and will get a compile error in both
  registries until it adds configs — by design).

## Risks

- **Sanitizer output parity is load-bearing.** `sanitizeFilenameToken` must
  reproduce the old `feedDebugLog`/`debugBundle` regex output exactly or existing
  on-disk logs/bundles orphan; `sanitizePathSegment` must match the Codex proxy
  writer, the debug-bundle reader, AND the Claude headless package's intentional
  mirror or a debug bundle silently misses its proxy log. Both are unit-pinned,
  but the package-side mirror is NOT imported (package independence) and must be
  kept in step manually.
- **Privacy redaction** is now single-sourced in `sanitizePerformanceData`; the
  sensitive-key regex and truncation limits are unit-pinned. Any future change is
  a deliberate privacy decision, not an incidental edit.
- **Residual layering debt**: `src/main` still imports several non-caffeinate
  types from `@preload/api/types` (SubAgent/JSONL/dictation/paste-debug). Not a
  regression (pre-existing), but the layering inversion is only partly resolved.

## Recommended follow-up PRs

1. Session IPC channel-typing map (`SessionIpcInvokeMap`/`SessionIpcEventMap`) +
   inline payload type extraction (cross-app Finding 1).
2. Codex lister consolidation onto `codex-headless` + delete the app-local file
   (cross-app Finding 2 / shared-types Finding 10).
3. Semantic-event typed adapter (cross-app Finding 3).
4. Parity/fixture test suite (diffLines tri-impl, alias-config, provider-condition
   assignability, transcript fixtures) — coordinate with the no-test-bloat policy.
5. Finish the `@preload` → shared layering for the remaining main-side imports.
6. `inheritParentContext` deprecation once an owner decides on the compat window.

---

## SECOND PASS / recovery

This cluster's first session was **interrupted mid-edit**. Its last visible
action was: *"Let me annotate the handler return with `GitBarStatusResult` so
main can't drift from the contract:"* — i.e. it was in the middle of wiring the
GitBar contract, and this implementation log was still a placeholder scaffold
(`(filled in as slices land …)`).

A recovery session resumed from the dirty worktree (no work discarded, no new
worktree). What it found and did:

1. **Inspected** `git status` / `git diff` / this log. Confirmed a large,
   coherent, high-quality body of work was already in place (Findings 1–13
   above) and that the failure was an in-progress edit to the GitBar slice.

2. **Finished the interrupted GitBar edit:**
   - `src/main/ipc/git.ts` used `GitRecentCommit` (typing `commits`) but it was
     **missing from the import list** — the exact line the prior agent was typing
     when cut off. Added `GitRecentCommit` to the `@shared/types/gitStatus`
     import. Without this the main project would not compile.
   - The prior agent had created the shared type and wired *main only*; the
     contract's whole purpose (one type across all three layers) was unmet.
     Wired **`src/preload/api/git.ts`** (`gitStatus(): Promise<GitBarStatusResult>`,
     replacing a hand-inlined union copy) and **`GitBar.tsx`** (aliases + the
     `Extract<…, { ok: true }>` derivation, replacing 3 local type blocks).

3. **Closed a documentation/test inconsistency:** `numstat.ts` and `git.ts` both
   asserted `parseNumstat` was *"pure + unit-tested"*, but no test existed (its
   sibling extracted helpers — asRecord, sanitizePath, performance, providerKind —
   all had one). Added `testing/unit/shared/numstat.test.ts` covering the binary
   `-`→0 coercion, malformed-line skipping, tab parsing, empty input, and the
   non-numeric `|| 0` guard — making the code comment true.

4. **Re-verified against all three plans** (read every concrete finding) and
   confirmed the implemented set, partial set, and skipped set recorded above.

5. **Ran checks:** `git diff --check` (clean), the shared unit suite (31 pass),
   the unit project (64 pass; 3 pre-existing unrelated import failures), and
   filtered typechecks on both tsconfig projects (zero errors in cluster files).
   Removed a stray gitignored `.tsc-out/` left by the typecheck runs.

No prior edits were reverted; recovery was strictly additive (one missing
import, two consumer wirings the original slice intended, one missing test, and
this log).

### Final state
The GitBar contract is now enforced across main → preload → renderer, every
other implemented finding typechecks and is unit-covered where it added shared
logic, and the deferred/skipped items are documented with owners and rationale.
The branch is ready for the smoke-test pass listed under *Manual verification*
and for review.
