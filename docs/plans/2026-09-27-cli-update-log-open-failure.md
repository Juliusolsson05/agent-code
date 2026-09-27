# "View Log" says when the log did not open (#1250 row 10)

Short plan: a bug with a known root cause. The row comes from `temp/quality-loop/hunt-c3.md` (row 10, P3). #1250 is a batch issue, so this PR is `Refs #1250`.

## Outcome
A failed CLI auto-update shows a **View Log** button. When the log cannot be opened (retention pruned it, or there is no handler for the file type), the banner now says so. Today the click does nothing visible.

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
