# Debug / Dictation / Release Implementation Log

Worktree: `/Users/juliusolsson/Desktop/Development/agent-code-cluster-worktrees/debug-dictation-release`

Branch: `cluster/debug-dictation-release`

Date: 2026-06-24

## Scope Read

Read before editing:

- `/Users/juliusolsson/Desktop/Development/agent-code-audit-worktrees/storage-debug-perf/docs/audit-plans/storage-debug-perf.md`
- `/Users/juliusolsson/Desktop/Development/agent-code-audit-worktrees/dictation/docs/audit-plans/dictation.md`
- `/Users/juliusolsson/Desktop/Development/agent-code-audit-worktrees/setup-packaging-runtime/docs/audit-plans/setup-packaging-runtime.md`
- `docs/audit-plans/deep-audit-master-roadmap.md`
- `AGENTS.md`

## Required Confirmation Searches

Before deleting dictation provider/listing code:

```text
rg -n "listDictationProviders|dictation:list-providers|listSelectableProviders|transcribeAssemblyAi|transcribeElevenLabs|transcribeGladia|transcribeOpenAi|polish" src packages package.json
```

Result summary: only the preload `listDictationProviders` method, main `dictation:list-providers` handler/import, controller's non-Deepgram imports/cases, and the unwired `polish` controller branch matched. The only other `polish` hit was an unrelated settings comment about UI polish.

After deletion:

```text
rg -n "dictation:list-providers|listDictationProviders|listSelectableProviders|transcribeAssemblyAi|transcribeElevenLabs|transcribeGladia|transcribeOpenAi|polishTranscriptWithOpenRouter|polish\?:|input\.polish" src packages
```

Result summary: no matches.

Before changing heap snapshot retention:

```text
rg -n "heap-snapshots|writeHeapSnapshot|HEAP_SNAPSHOT|DebugStorageBucket|bucketCaps|collectArtifacts" src/main
```

Result summary: heap writers duplicated `join(STATE_DIR, 'heap-snapshots')` in `heapWatchdog.ts` and `ipc/performance.ts`; `debugRetention.ts` had no heap bucket or collector.

After retention path changes:

```text
rg -n "heap-snapshots|HEAP_SNAPSHOT_DIR|heap-snapshots'|writeHeapSnapshot" src/main
```

Result summary: both heap snapshot writers now use `HEAP_SNAPSHOT_DIR`, and `debugRetention.ts` now defines/collects a `heap-snapshots` bucket.

Before shared sha8 extraction:

```text
rg -n "sha8\(|function sha8|const sha8|createHash\('sha256'|crypto\.subtle\.digest" src packages
```

Result summary: four 8-hex SHA-256 prefix implementations existed across dictation renderer/main and paste renderer/main; the unrelated mac hotkey helper uses a 12-hex source hash and was left alone.

After extraction:

```text
rg -n "function sha8|const sha8|digest\('hex'\)\.slice\(0, 8\)|crypto\.subtle\.digest\('SHA-256'" src/main src/renderer/src src/shared
```

Result summary: no raw `digest('hex').slice(0, 8)` copies remain; renderer call sites use `sha8Web`; main call sites use `sha8FromDigestBytes` after Node hashing.

Release runtime cache confirmation:

```text
rg -n "runtime:prepare|runtime:fetch|fetch-mitmproxy|fetch-tmux" .github package.json scripts third_party docs
```

Result summary: `.github` had no release step invoking `runtime:prepare:mac`; the only script definition lived in `package.json`.

## Implemented

- Added `HEAP_SNAPSHOT_DIR` in `src/main/storage/paths.ts`.
- Moved automatic and manual heap snapshot writers to `HEAP_SNAPSHOT_DIR`.
- Added `heap-snapshots` to debug retention collection and budget caps. Heap snapshots are not protected from TTL/global pruning; active grace still protects just-written captures.
- Fixed render trace pruning so it keeps a real checkpoint at or before the retained window instead of synthesizing a checkpoint with latest HTML under an older hash.
- Added `forgetDebugTrace(sessionId)` and wired it into session close/kill paths that already drop runtime/screen refs.
- Added a renderer regression test for checkpoint hash/content consistency and trace forgetting.
- Stopped manual proxy bundles from silently attaching a different session's proxy log by default. The reader now returns `match`, `requestedSessionKey`, and `matchedSessionSegment`; missing exact matches produce no payload and manifest metadata explains the omission.
- Removed grep-confirmed dead dictation provider/listing surface: non-Deepgram app controller cases/imports, OpenRouter polish branch, `dictation:list-providers`, and preload `listDictationProviders`.
- Narrowed app dictation provider/status contracts through `src/shared/types/dictation.ts`.
- Extracted shared sha8 width/format primitives in `src/shared/code/sha8.ts` and migrated dictation/paste call sites while preserving the historical 8-hex output.
- Gated `dev-debug:read-paste-events` behind `AGENT_CODE_DEV_DEBUG`; `dev-debug:get-config` stays available.
- Added `npm run runtime:prepare:mac` to the release `build-app` job before `npm run build`, where `copy-packaged-resources.mjs` reads the cache into `out`.
- Updated setup mitmdump env production to write primary `CLAUDE_HEADLESS_MITMDUMP` while keeping legacy `CC_PROXY_TEST_MITMDUMP` in sync.
- Removed the stale `bump-mitmproxy.mjs` README sentence.
- Corrected stale feed-debug comments for the actual `STATE_DIR` root and unified retention owner.

## Deliberately Not Implemented

- Manual debug bundle emergency pruning: the audit marks this as a product-policy decision. Current behavior remains protected from TTL/per-bucket/global pruning.
- Feed-debug durable queue: comments were corrected, but the full fix requires threading a second non-UI persistence buffer through every `appendFeedDebugLog` producer or an equivalent runtime/ref contract. I did not half-migrate this because a partial queue would create false durability confidence.
- Batched JSONL writer consolidation for ghost/dictation/paste: valuable but larger and not needed to fix the retention/forensic correctness bugs landed here. Paste-debug on-disk schema remains untouched because the audit says it is in active investigative use.
- Runtime-tool script library extraction: deferred behind the release cache priming fix so CI can catch script behavior changes later.
- Vendor submodule policy: requires maintainer decision per the setup/runtime audit.
- Dictation hot-path debug gating: requires the audit's verify-first scan of real recent dictation journals for current chunk mismatches.

## Verification

Installed dependencies in this worktree with:

```text
npm ci --include=dev
```

This populated `node_modules` only; no lockfile changes were produced.

Passed:

```text
npm run test:renderer -- src/renderer/src/features/debug/renderTrace.renderer.test.ts
```

Result: 1 file passed, 2 tests passed.

Attempted:

```text
npx tsc -b
```

Result: failed before a useful clean gate because this worktree still has broader unresolved package/submodule/typecheck issues, including missing `claude-code-headless`, `codex-headless`, `agent-transcript-parser`, `agent-voice-dictation/*` declarations, missing `pidusage` declarations, and unrelated existing renderer/workspace type errors such as `workspace.reader` and `inheritParentContext`.

Attempted:

```text
npm run build:app
```

Result: failed during resource copy because `packages/claude-code-headless/src/proxy/mitmAddon.py` is absent in this worktree. Vite transformed 59 modules before the copy hook failed.

## Remaining Risks

- The new proxy default omits payloads when a specific session key does not match. That is intentional for forensic correctness, but users who relied on broad fallback logs will see fewer bundled proxy files until a product decision adds explicit fallback UX.
- Heap snapshot bucket cap is conservative but still competes with other debug artifacts under the global budget. Recent captures are protected by active grace, not by permanent manual-bundle style immunity.
- Full typecheck/build verification still depends on restoring the package/submodule state and resolving the existing typecheck baseline.
