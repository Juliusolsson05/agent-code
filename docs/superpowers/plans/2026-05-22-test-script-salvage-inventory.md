# Test Script Salvage Inventory

Status: inventory for `test/vitest-ground-zero`, written 2026-05-22.

## Source Issues

- #182: Add a proper unit and integration testing suite for Agent Code
- #183: Add comprehensive rendering regression tests for feed ownership and streaming behavior

#182 is the direct mandate. It says the existing focused scripts are useful,
but not a consistent testing setup. This branch treats the scripts as incident
notes to mine, not as a suite to preserve.

## Decision Rule

Do not migrate script files one-for-one. For each script, salvage the invariant
only if it still protects a current subsystem or open issue. Rewrite that
invariant as a Vitest test at the subsystem boundary.

Delete the script after its intent is either:

- rewritten in Vitest,
- documented as intentionally dropped, or
- moved to a manual tool/harness directory because it is not a test.

## Keep By Rewriting

These scripts protect real behavior and should become first-class Vitest tests.

| Script | Verdict | New home |
|---|---|---|
| `scripts/test-feed-render-model.ts` | Rewrite, high priority. Salvage cases around `FeedRenderItem[]`, semantic history/current ordering, work rows, queue rows, duplicate suppression. | `src/renderer/src/features/feed/model/renderModel.test.ts` |
| `scripts/test-ghost-fallback.ts` | Rewrite, high priority. Keep the ghost predicate matrix and reference-stability assertions. | `src/renderer/src/workspace/ghosts.test.ts` and `src/renderer/src/workspace/mergedEntries.test.ts` |
| `scripts/test-semantic-committed-text.ts` | Rewrite, high priority. Keep Codex `resp_*` vs rollout id duplicate text suppression. | `src/renderer/src/features/feed/ui/semantic/renderUnits.test.ts` or future render pipeline tests |
| `scripts/test-semantic-fold-codex-replace.ts` | Rewrite, high priority. Keep proxy replacing empty non-proxy shell and stale-turn protection. | `src/renderer/src/workspace/semantic/foldEvent.test.ts` |
| `scripts/test-codex-optimistic-submit.ts` | Rewrite, high priority. Keep prompt queue/optimistic ownership cases from #239/#241. | `src/renderer/src/workspace/hook/actions/streaming.test.ts` and `src/renderer/src/workspace/queueInvariants.test.ts` |
| `scripts/test-codex-semantic-channel.ts` | Rewrite. Protect headless semantic lifecycle behavior. | `packages/codex-headless/src/channels/SemanticChannel.test.ts` |
| `scripts/test-claude-proxy-api-error-release.ts` | Rewrite. Good transport-level regression for failed active flow release. | `packages/claude-code-headless/src/proxy/ClaudeProxyAdapter.test.ts` |
| `scripts/test-session-ownership.ts` | Rewrite. Protect dispatch/grid/buried/detached ownership. | `src/renderer/src/workspace/sessionOwnership.test.ts` |
| `scripts/test-dispatch-terminals.ts` | Rewrite. Protect command targeting across terminal/agent dispatch rows. | `src/renderer/src/workspace/hook/selectors/commandTargetSessionId.test.ts` plus command registry tests |
| `scripts/test-rehydrate-relationship-remap.ts` | Rewrite. Small, clear persistence invariant. | `src/renderer/src/workspace/hook/persistence/rehydrate.test.ts` |
| `scripts/test-agent-transcripts.ts` | Rewrite. Real MCP transcript reader behavior with temp JSONL fixtures. | `src/main/agentTranscripts/AgentTranscriptReader.test.ts` |
| `scripts/test-built-in-mcp-lifecycle-cache.ts` | Rewrite. High-value server lifecycle behavior, but keep it integration-labeled. | `src/mcp/runtime/BuiltInMcpHttpHost.integration.test.ts` |
| `scripts/test-provider-switch-duplicate.ts` | Rewrite. Protects transcript/provider identity, relevant to #173/#193. | `src/main/providerSwitch/providerSwitch.integration.test.ts` |
| `scripts/test-codex-ready-for-prompt.ts` | Rewrite. Small parser unit test. | `src/providers/codex/runtime/codexReadyForPrompt.test.ts` |
| `scripts/test-rendered-content-targets.ts` | Rewrite. Security-sensitive link/path classification. | `src/shared/renderedContent/targets.test.ts` |
| `scripts/test-settings-coerce.ts` | Rewrite. Small stable settings coercion surface. | `src/renderer/src/app-state/settings/persistence.test.ts` |
| `scripts/test-debug-bundle-storage.ts` | Rewrite. Storage path invariants. | `src/main/storage/debugBundleLog.test.ts` |
| `scripts/test-editor-fs-cache.ts` | Rewrite. Clear cache behavior. | `src/main/ipc/editorFsCache.test.ts` |
| `scripts/test-process-lock.ts` | Rewrite. Multi-instance protection. | `src/main/storage/processLock.integration.test.ts` |
| `scripts/test-worktree-activity-index.ts` | Rewrite. Small pure index behavior. | `src/main/worktreeActivity/WorktreeActivityIndex.test.ts` |
| `scripts/test-work-context.ts` | Rewrite selectively. Keep reducer/tracker cases; split UI color assignment into its own test if still relevant. | `src/shared/work-context/*.test.ts` and renderer color test |
| `scripts/test-undo-close.ts` | Rewrite. Still relevant to #153 and closed #154 behavior. | `src/renderer/src/lib/undoClose.test.ts` |
| `scripts/test-agent-status-model.ts` | Rewrite if Agent Status remains important. Low risk but clear model behavior. | `src/renderer/src/features/agent-status/model/agentStatusModel.test.ts` |
| `scripts/test-orchestration-mcp.ts` | Rewrite selectively. It is large and likely mixes several concerns. Split into orchestration prompt, MCP tool behavior, and runtime state tests. | `src/renderer/src/workspace/orchestrationMcp.test.ts` and `src/mcp/shared/orchestrationPrompt.test.ts` |

## Drop Or Defer

These should not be carried forward blindly.

| Script | Verdict | Reason |
|---|---|---|
| `scripts/test-prompt-templates.ts` | Defer or rewrite only if prompt templates are actively changing. | Useful but not part of the testing spine; simple CRUD can be recovered later. |
| `scripts/test-dictation-imports.ts` | Drop from root app tests. | It is an import smoke for a package boundary. Package-local dictation tests already exist; root should not keep a script-shaped import probe. |

## Move To Manual Tools, Not Tests

| Script | New home | Reason |
|---|---|---|
| `scripts/proxy-harness.mts` | `tools/proxy-harness/` or `testing/manual/proxy-harness/` | Manual investigation harness, not CI. |
| `scripts/proxy-harness-real.mts` | `tools/proxy-harness/` or `testing/manual/proxy-harness/` | Manual live-provider harness. |
| `scripts/proxy-harness-semantic.mts` | `tools/proxy-harness/` or `testing/manual/proxy-harness/` | Manual semantic investigation harness. |

## Move To Build/Tools

| Script | New home | Reason |
|---|---|---|
| `scripts/copy-packaged-resources.mjs` | `build/copy-packaged-resources.mjs` | Build helper, not a miscellaneous script. |
| `scripts/check-upstream.mjs` | `tools/upstream/check.mjs` | Operational maintenance tool. |
| `scripts/runtime-tools/*.mjs` | `tools/runtime/*.mjs` | Runtime fetch/verify tools. |

## Priority Order

1. Rendering and ownership: feed render model, ghost fallback, semantic fold,
   semantic committed text, Codex optimistic/queue.
2. Provider/session identity: provider switch duplicate, Codex ready screen,
   Codex/Claude semantic channel/proxy adapter.
3. Workspace/session safety: session ownership, rehydrate relationship remap,
   undo close, dispatch terminal targeting.
4. Main process storage/runtime: process lock, debug bundle storage, editor fs
   cache, worktree activity.
5. Lower-value app model tests: agent status, prompt templates, work context
   split cleanup.

## What Must Not Happen

- Do not keep both a Vitest test and a `scripts/test-*` script for the same
  invariant long term.
- Do not port a 700-line script as a 700-line test file. Split it by invariant.
- Do not use live providers as the main test mechanism.
- Do not use snapshots to test ownership logic.
- Do not let `scripts/` remain the default place future agents add tests.

