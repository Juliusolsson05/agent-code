# "View Log" says when the log did not open (#1250 row 10)

Short plan: a bug with a known root cause. The row comes from `temp/quality-loop/hunt-c3.md` (row 10, P3). #1250 is a batch issue, so this PR is `Refs #1250`.

## Outcome
A failed CLI auto-update shows a **View Log** button. When the log cannot be opened (removed by hand, or no handler for the file type; nothing prunes this directory automatically), the banner now says so. Today the click does nothing visible.

## Root cause (verified in source, origin/main)
- `src/main/ipc/cliUpdates.ts` `cli-updates:open-log`: `shell.openPath` RESOLVES with an error string on failure, and the handler discards it. Its comment says "the OS shell surfaces its own error dialog", but Electron's `openPath` on a missing file returns `Failed to open path` and shows nothing.
- The preload types the call `Promise<void>`, and the banner calls it `void`.

## Design (contract)
- **`cli-updates:open-log` returns `boolean`:** `true` only when `openPath` returned `''`. An error string, or a throw, is `false` and is warned to the console (diagnostic only).
- **Preload:** `cliUpdatesOpenLog(logPath): Promise<boolean>`.
- **`BannerEntry.action`** gains optional `failureText`. `BannerRow` awaits `onClick`; when it resolves `false`, it shows `failureText` in a `role="alert"` line on that row. A later click clears it.
- The failed state's View Log action gets `failureText`: "Couldn't open the update log. It may have been cleaned up; the next failed update writes a new one."
  - Fixed words (q22): no path or OS text.

## Tests
- **New `src/main/ipc/cliUpdates.test.ts`:** Electron's `ipcMain` is captured and `shell.openPath` stubbed (the edge). `''` answers `true`; `'Failed to open path'` answers `false`; a throw answers `false`.
- **`CliUpdateBanner.renderer.test.tsx`:** a failed state whose `cliUpdatesOpenLog` resolves `false` shows the fixed sentence after clicking View Log; one resolving `true` shows none.
- Red on main.

## Out of scope
- #1250's other rows.

## Review round 1 (a: FIX-BEFORE-MERGE)
- **a1 (Major, pre-existing but in the touched handler): the renderer could make main open ANY path.** `shell.openPath` opens applications too.
  - **Ruling:** `cli-updates:open-log` takes the CLI kind. Main opens that CLI's current `failed` state's `logPath`, which it wrote itself; anything else opens nothing.
  - Test: a path, an unknown CLI, or a CLI whose state is not failed opens nothing, and `openPath` is never called.
- **a2 (Minor): an older, slower answer could re-show the alert after a newer successful click.** Only the latest click sets the result. Test added.
- **a3 (Minor): the alert survived a new failed run with a new log.** The result is keyed by the action's `resultKey` (the log path). Test added.
- **a4:** the plan and comment claimed the debug-retention prune removes these logs. It does not (`cliUpdateOrchestrator.ts` says retention is not automated for this directory); both are corrected.
