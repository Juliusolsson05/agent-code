# Default-off diagnostics: feed-debug persistence, worktree index no-op saves, daily profile (#767 items 1, 3, 7)

## Problem (from the issue's 2026-09-25 status)

#767 tracked every always-on diagnostic subsystem. Items 2 (memory sampler) and 5 (mitmproxy reaping,
#777) have landed. Open, per the acceptance line:

1. **feed-debug has no gate.** `appendFeedDebugLog` feeds a per-session renderer ring from every
   streaming path. `useFeedDebugPersist` then ships the ring's tail to main **every second, for every
   session, in every build** (`debug:append-feed-log` → `queueFeedDebugAppend` →
   `STATE_DIR/feed-debug/<session>.jsonl`, up to 128 MiB per file, 22 % of the 10-15 GiB debug budget).
   #748/#750 paced it but never gated it. The only related setting, `aggressiveDebugPersistence`,
   gates the debug-bundle autosave, not this.
3. **`WorktreeActivityIndex.refreshNow` saves on an all-cache-hit refresh.** It stamps `updatedAt`,
   stringifies the whole index (30 MB+ for heavy users) and writes temp+rename even when every
   candidate was a cache hit. The background refresh fires at least every 60 s, and `collectSummaries`
   keys its cache on `updatedAt`, so the refresh also throws away the summary cache that exists to
   stop re-parsing the index on every 10 s UI poll. `saveWorktreeActivityIndex` re-stamps `updatedAt`
   a second time, so the in-memory and on-disk values differ by a few ms.
   `WorktreeActivityIndex.ts` has **no tests**.
6. **The recorder and feed-debug sinks still run on main.**
7. **There is no documented daily profile.** No README section, no `.env.example`. The flags are
   described only in historical plan docs.

## Evidence

- Source map (current `origin/main`):
  - `feedDebug.ts:120-149` appends with no gate;
  - `workspace/hook/index.ts:1018` calls `useFeedDebugPersist` unconditionally;
  - `ipc/debug.ts:33-48` forwards to `feedDebugLog.ts:156`;
  - `WorktreeActivityIndex.ts:292,298` stamps and saves unconditionally;
  - `indexStore.ts:142-169` stringifies and replaces the whole index, and `:149` re-stamps.
- **Debug bundles take feed-debug from the renderer ring (`runtime.feedDebugLog`), not the disk file**
  (`saveDebugBundle.ts:283,341`). Gating the disk copy keeps "Save Debug Logs" intact. Only
  after-crash forensics (the renderer ring is gone once the renderer dies) need the persisted copy.
- The issue's original measurements: 167–172 appends/min (bursts of 20/s), up to 731 ms on main,
  89 MB on disk.

## Decisions (defaults — owner may override)

1. **Disk persistence of feed-debug is on only when diagnostics are asked for:**
   `AGENT_CODE_DEV_DEBUG=1` (the existing dev-debug switch) **or** the existing
   `aggressiveDebugPersistence` setting.
   - Nothing else changes: the renderer ring still records, so Save Debug Logs and the Feed Debug panel
     work as today.
   - The renderer decides, because it already has both inputs (dev-debug config and settings) and it
     is the side that pays the 1 s IPC. With persistence off, `useFeedDebugPersist` schedules nothing.
   - *UNCONFIRMED default:* this reuses `aggressiveDebugPersistence` ("keep more debug data on disk")
     rather than adding a new setting. Owner may prefer a dedicated toggle.
   - **Declined: a "sampled ring in packaged builds".** The ring is already bounded by #750 (500
     entries and 4 MiB per session). Sampling would drop exactly the consecutive rows a bug report
     needs to reconstruct a feed.
2. **Worktree index: persist only when content changed.**
   - `refreshNow` tracks whether any entry was added, replaced or evicted, or whether the totals
     changed. If nothing did, it updates only `status.lastIndexedAt` (the "last checked" time the
     Worktrees dump shows). It skips the stringify and write, and leaves `updatedAt` (the content
     generation that keys the summary cache) untouched.
   - `saveWorktreeActivityIndex` persists the caller's `updatedAt` instead of stamping a second
     timestamp.
3. **Item 6 is split into its own issue.** Moving the recorder and feed-debug sinks into a
   `utilityProcess` is an architecture change. The app has three `utilityProcess.fork` templates
   (`MonitorCoordinator`, `ElectronWorkflowWorkerLauncher`, extension `serviceHost`). It deserves its
   own plan and PR, and it is far smaller once item 1 stops the feed-debug sink running by default.
   This PR therefore uses `Refs #767`, not `Fixes`.
4. **Item 7: a short "Diagnostics flags" section in the root README.** It lists each flag and setting
   with its default and cost, and the recommended daily profile (everything off; `DEV_DEBUG=1` only to
   record on demand).

## Tests

- **Worktree index (new `WorktreeActivityIndex.test.ts`,** real index files in a temp dir, fixtures
  built through the real transcript scanner):
  - a second refresh with no changes writes nothing (index file mtime and bytes unchanged) and keeps
    `updatedAt`, so a cached summary survives;
  - a changed transcript (mtime/size), a deleted one, and a new one each do persist and bump
    `updatedAt`;
  - the on-disk `updatedAt` equals the in-memory one.
  - Fail-first: the no-change case fails on `origin/main`.
- **feed-debug gate (renderer test beside `useFeedDebugPersist.renderer.test.tsx`):**
  - with dev-debug off and the setting off, streaming appends to the ring and no `appendFeedLog` IPC
    is made;
  - with either switch on, it persists as before.
  - Fail-first: the off case fails on `origin/main`.
