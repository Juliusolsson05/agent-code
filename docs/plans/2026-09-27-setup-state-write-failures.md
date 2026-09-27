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

## Review round 1 (a, b: FIX-BEFORE-MERGE; c: MERGE-READY with minors)
- **The restore design was wrong (a, b, c).** Every save was built from the optimistic cache:
  - two queued failures made the second "restore" the first one's unwritten state;
  - a failure followed by a good save carried the failed value to disk while the row said "Nothing was changed".
  The `cache === snapshot` ruling above is **withdrawn**.
  - **Ruling:** a save is an UPDATE function (`updateSetupState(update)`). At write time it is applied to `durable` (the last state known on disk), never to another save's unwritten result. `cache` is `durable` plus the still-pending updates, recomputed as each one settles, so a failed update drops out of memory and out of every later write.
  - Readers still see a change synchronously once the state is loaded.
  - `saveSetupState(next)` stays as a whole-state update.
  - The first read is shared, so a late duplicate read cannot reset `durable`.
  - **Cost if wrong:** none known. Updates are pure functions of the state.
- **Provider toggles build per key** (`setProviderEnablementOverride(kind, enabled | null)`), not from a whole map computed off the optimistic cache.
- **Reset persisted, then rejected (a, b).**
  - `mutate` rejects only when the write fails.
  - A refresh failure after a landed write resolves: the saved state is shown against the last detection that succeeded, or fails open to "all installed", the same as `enabledAgentProviderKindsSync`.
  - Found on the way: a rejected detection probe stayed "in flight" for the process lifetime. It is now cleared in `finally`.
- **SetupGate (b), in scope because it writes the same file:**
  - a failed manual path shows the fixed sentence, not the raw IPC error;
  - a failed skip or acknowledgment (the panel still closes, per #1047) is said after the close as a toast;
  - a failed check stores a fixed sentence (the raw error goes to the console).
- **Test gaps (b, c):** the reset alert is tested on its own render; clearing after a later success is pinned for all three rows; each ordered queue case has a real-filesystem test with a one-shot rename fault.
- **c (minor):** the body's test count is corrected.

Tests, each red on `6707e7cf` (verified by swapping in that file):
- `setupState.test.ts`: 4 queue cases.
- `providerEnablement.test.ts` (new): a reset with a failing re-probe, and the stuck in-flight probe.
- `firstRun.renderer.test.tsx`: the skip toast and the manual path.
- The row tests kill b's four surviving mutations.

## Verification (a, b: FIX-BEFORE-MERGE)
- **b (Major): a saved setup answer reported as unsaved.** Every setup IPC saves the answer, then runs `checkPrerequisites`, whose tool-path write-back hits the same file. When only the write-back failed, the IPC rejected, and SetupGate said the answer was not saved.
  - **Ruling:** the write-back is best effort (warned). It persists a cache of the probe, and the result returned is the probe's own answer.
  - **Cost:** the toolchain keeps its last persisted paths until a later write-back lands.
  - This also stops Install and a provider reset from rejecting after their own work succeeded.
  - Test: `src/main/ipc/setup.test.ts`, with the real handlers, real setup state and real check. Skip, acknowledgment and manual path each resolve with the answer on disk; a failing answer write still rejects. Red with the old `prerequisites.ts`.
- **b (Major): Install rendered the raw rejection.** It now shows "Could not install <target>." The installer's own output on a non-ok result is unchanged. Test in `firstRun.renderer.test.tsx`, red on the old SetupGate.
- **a (Major): an older provider refresh could overwrite and broadcast a newer one** (a pre-existing race in the touched path). Refreshes are numbered; only one started after the applied refresh may replace it. Test: the first row's credential probe is held while the second row's refresh finishes; the cache and the last broadcast keep Claude off. It fails without the ordering.
- **Survivors, each pinned:**
  - the shared first read: a held first read that finishes after a save no longer resets the durable baseline;
  - the fallback uses the last good detection, not "all installed".
- **c (MERGE-READY):** its two survivors are the two pinned above. Its suspicion, an update that throws staying pending forever, is closed: the update leaves `pending` on every path. Test added.

## Recheck (a, b: FIX-BEFORE-MERGE)
- **b and a2 (Major): a provider snapshot published a toggle whose write then failed.** A refresh read the optimistic cache, which already held another toggle still in flight (from a second toggle's refresh, or from an overlapping `get`).
  - **Ruling:** published provider snapshots are built from the DURABLE state (`loadDurableSetupState`). Every refresh runs after its own write has landed, so nothing optimistic is needed there.
  - Two tests: a successful toggle during a failing one, and an overlapping read. Both fail with the optimistic read.
- **a1 (Major): a failed write-back left the toolchain on the last persisted, possibly dead, path while the check said "found at X".** `refreshToolchainFromState(unsaved)` applies the probed paths in memory when they could not be persisted, so the check and a launch agree in this process.
  - Test: new `prerequisites.test.ts`, with the real check, toolchain and setup state. It fails without the overlay.
  - It also kills a's survivor (the refresh removed).
