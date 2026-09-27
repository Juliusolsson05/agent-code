# A failed setup-state write is reported and not half-applied (#1250 rows 6 and 13)

Short plan: bugs with a known root cause. The rows come from `temp/quality-loop/hunt-c3.md`. #1250 is a batch issue, so this PR is `Refs #1250`; the other rows stay open.

## Outcome
Changing a provider's enablement (row 6), the OpenCode usage source, or the CLI update behaviour (row 13) either takes effect, or tells the user it did not and leaves everything as it was. Today a failed write (a full disk, a read-only or permission-broken state directory) is invisible:
- the switch or card flips back with no message, or stays flipped until restart;
- main keeps the unwritten value in memory, so the app behaves as if it were saved, then silently reverts on the next launch.

## Root cause (verified in source, origin/main)
- **`saveSetupState` (`src/main/setup/setupState.ts`)** assigns `cache` to the new state BEFORE the queued write, and never restores it when the write rejects. Every later `loadSetupState()` returns the unwritten value:
  - `providerEnablement.mutate` re-resolves from it on the next poll;
  - the CLI-update orchestrator is not told (the IPC handler throws first), while the cache says otherwise.
- **`ProviderEnablementRow`** toggle and reset use `try/finally` with no `catch`, called via `void`: an unhandled rejection with nothing shown.
- **`OpencodeUsageSourceRow`** catches, but shows the raw IPC `error.message`, which for a filesystem failure can carry a path (q22: user-visible text is curated).
- **`setCliUpdateBehavior` (renderer store)** has no rejection handler at all, and `CliUpdateBehaviorRow` has nowhere to say it failed.

## Design (contract)
- **`saveSetupState`:** keep the previous cache. If the write rejects and no newer save has replaced the cache since (`cache === snapshot`), restore it, then rethrow.
  - **Ruling:** a newer save built from the failed state is left alone. It would persist the failed value too, which is what the user asked for, and restoring under it would discard a write that succeeded. Cost: in that narrow race, a change reported as failed lands later.
- **Renderer:** each row catches and shows a fixed sentence: "Couldn't save this change. Nothing was changed." The row's own value comes from main's snapshot, so it shows the unchanged state.
  - `setCliUpdateBehavior` returns its promise.
  - `CliUpdateBehaviorRow` holds an error, like `UpdateChannelRow`.
  - No IPC or filesystem text is shown.

## Tests
- **`setupState.test.ts` (new), real filesystem in a scratch `STATE_DIR`:** a directory at `setup.json` makes the rename fail. Then:
  - the save rejects;
  - `loadSetupState()` returns the previous value, not the unwritten one;
  - a later good save still lands.

  Red on main: the cache keeps the unwritten value.
- **Renderer:** a rejecting `providerEnablementSet` / `providerEnablementReset` / usage-source call / `cliUpdatesSetBehavior` shows the fixed sentence and no raw text, and there is no unhandled rejection. Red on main for rows 6 and 13.

## Out of scope
- #1250 rows 7–12, 14 and 15.
- Row 15 needs `src/main/index.ts`, which open PR #1216 also edits; it is raised with the manager.
