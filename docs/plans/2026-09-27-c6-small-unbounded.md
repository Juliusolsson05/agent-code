# C6 small unbounded growth (#1278)

Source: the Stage 3 C6 hunt (`temp/quality-loop/hunt-c6.md`, rows 7–14 and part of 5). Each item was verified on origin/main `5e22c7b0` by a read-only Explore pass, then re-read by hand at the fix site. Every fix has a test that fails without it (fail-first, or the fix removed as a mutation).

**Owner rule (2026-09-27): "do not delete stuff often."** Fixes bound *memory* and repair a cleanup that was already intended. None of them adds a new deletion policy for user-visible data.

| # | Item | Verdict on main | Change | Test |
|---|---|---|---|---|
| 1 | `pasteDebugJournal.ts` `journals` Map | Real. A paste id is a fresh UUID and `dispose()` has no caller, so there was one writer per paste forever. | Cap at 64 with oldest-first eviction, and make `flushAll` await evicted flushes. The same bound and shape as `dictationJournal` (#1276). | New `pasteDebugJournal.test.ts`. Mutant: dropping the evicted-flush drain goes red. |
| 2 | Empty proxy parent dirs | **A bug, not a missing feature.** `removeEmptyParents` called `rm(dir, { recursive: false })`, which always throws EISDIR (confirmed on Node 24.14.1), so no parent was ever removed. The author's machine has 2,978 empty dirs, walked on every prune. | `rmdir`, which removes only an empty dir and does it atomically: a concurrent new run makes it fail with ENOTEMPTY. `root + sep` keeps sibling roots out of scope. | Real-filesystem test. Red on main; the old `rm` as a mutant goes red. |
| 3a | Legacy `saved-debug-bundles.jsonl` re-parsed on every prune | Real (18.4 MB, every 5 min). Nothing appends to it any more. | Cache the parsed set by file identity (mtime + size), so any edit re-parses. | Parse count test. Mutant: dropping the cache goes red. |
| 3b | `autosaved-debug-bundles.jsonl` append-only | Real, but small per line. Its append-only design as an operator index is a stated choice. | **Residual.** Trimming a ledger is a deletion policy; left for the owner. | none |
| 4 | WorkflowBridge `runsBySession` / `latestLifecycleByRunId` | Grows with the durable workflow-mcp store (`start()` reloads every stored run). | **Residual:** bounded by the store once #1275's retention (90 days, resumable never deleted) lands. Pruning the maps alone bounds nothing. | none |
| 5 | `sessionManager` `lastActivityAt` | Intentional; WHY at `sessionManager.ts:1095-1099` (telemetry asks about exited panes). One number per session id. | None. | none |
| 6 | Conversation caches | Grow with the transcript store plus deleted transcripts, not over time. | **Codex `heads`:** entries for files the (scope-independent) walk no longer finds are swept; this is exact. **Search `promptCache`:** LRU 1024, the same bound as the prompt folder's, via a new shared `LruMap` that now also backs `promptFolder.ts` (its private LRU functions are gone). **Claude `summaries`, codex `rolloutPaths`:** residual; a scoped discovery cannot tell a deleted transcript from an unwalked one, and a count cap below the store size would re-read the store on every full discovery. | Codex heads sweep test (mutant red); `lruMap.test.ts`; `promptFolder` suite 13/13 unchanged. |
| 7 | `cli-update-logs/` | Real but tiny. This machine has 13 files and 52 KB since 2026-09-03. `cliUpdateOrchestrator.ts:57-61` keeps them on purpose ("the diagnostic value of a two-year-old failed-update log is nonzero"). | **None.** Adding age deletion here would contradict both the WHY and the owner's rule. | none |
| 8 | `windowRegistry` `retiredWebContentsIds` | Real. The comment's "cleared with the registry" only ever happened in the test reset. | Cap at 256 by insertion order. Only a save dequeued moments after `closed` needs a tombstone, and webContents ids are never reused. | Red on main (id 1 still resolved after 300 closes). |
| 9 | `worktree-activity-index.json` rewritten whole | Derived cache, rebuilt from current candidates, so it grows with the corpus and not over time. | **Out of scope:** #767 item 3 (save on an all-cache-hit refresh) is the tracked remainder. | none |

## Overlap

#1411 (C5 rows) also edits `codex.ts`, `codex.system.test.ts`, `debugRetention.ts` and `debugRetention.test.ts`, in different hunks. Both PRs append tests at the same anchors, so whichever merges second resolves a trivial test-file conflict.
