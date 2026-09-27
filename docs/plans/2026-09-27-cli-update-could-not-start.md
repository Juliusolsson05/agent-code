# An update that cannot start says so and stays dismissable (#1425)

Size: short plan. The root cause is known and the change is bounded
(found by #1423's review b).

## Outcome

When **Update Now** or an automatic update cannot start, the CLI update
banner stops showing an undismissable "Updating…" row forever. It shows a
dismissable failure in fixed words, with **Update now** to retry. A click
whose IPC call rejects is also said instead of dropped.

## Evidence (verified 2026-09-27, do not re-derive)

- `CliUpdateOrchestrator.runUpdate` publishes `updating`, then awaits
  `openLog(cli)`, which `mkdir`s `CLI_UPDATE_LOG_DIR` outside any catch.
  An EACCES or ENOSPC there rejects, and the snapshot stays `updating`.
  `describeState` marks `updating` as `undismissable`.
- Every later await in `runUpdate` already swallows or returns a result:
  - `appendLog` and `appendDiagnostics` catch;
  - `readInstalledVersion` returns `{ ok }`;
  - the command runs inside a try.

  So `openLog` is the one throw that strands the state.
- `CliUpdateBanner` fires `cliUpdatesUpdateNow` with `void` in both the
  `notify` and the user-`deferred` rows. The IPC handler's rejection
  (`updateOnce` throwing) is dropped, and nothing is said.
- #1423 already gave banner actions a result contract: `onClick` may
  resolve `false`, and the row then shows `failureText`, keyed by
  `resultKey`.
- `failed.logPath` is read only by the `cli-updates:open-log` handler and
  the banner's `resultKey`.

## Change

- `@shared/types/cliUpdate`:
  - `failed.logPath: string | null` (null = there is no log, because the
    update never started);
  - `CliUpdateFailureReason` adds `'could-not-start'`.
- `runUpdate`: `openLog` runs in a try. On rejection it warns the cause
  in main's log (never the renderer; q22) and publishes
  `failed { reason: 'could-not-start', logPath: null }`, then returns
  without running the command.
  - Ruling: do not run the update without a log. A state dir we cannot
    write to (ENOSPC, EACCES) makes a package install likely to fail too,
    and a failure with no log would leave the user nothing to look at.
    Cost if wrong: one retry after the user fixes the disk.
- `cli-updates:open-log`: a `failed` state with `logPath === null` opens
  nothing and answers `false`. The banner shows no View Log for it anyway.
- Banner:
  - `could-not-start` reads: "Couldn't start the <label> update: Agent
    Code couldn't create its update log." The hint names disk space or
    permissions on the Agent Code data folder. The action is **Update
    now**, as a retry. Fixed words only.
  - Every Update now action awaits `cliUpdatesUpdateNow`, resolves
    `false` on rejection, and has `failureText` "Couldn't start the
    update. Try again."

## Tests (fail-first)

- Orchestrator test: `mkdir` of the log dir rejects (EACCES). The snapshot
  goes `updating` → `failed { reason: 'could-not-start', logPath: null }`,
  the update command is never run, and nothing stays `updating`. Before
  the fix: `updateOnce` rejects and the state stays `updating`.
- Banner renderer test:
  - a rejecting `cliUpdatesUpdateNow` shows the failure alert;
  - `describeState` for `could-not-start` is dismissable, shows the fixed
    sentence and offers Update now.
  - Before the fix: no alert, and there is no such state.
- `cli-updates:open-log` with a null `logPath` answers `false` without
  calling `shell.openPath`.

## Verification

`npx tsc -b` and the scoped vitest runs. Boundary: the app is never
launched, and a read-only state dir is simulated at the `fs` boundary.

## Out of scope

- Pruning `cli-update-logs` (nothing prunes it; unchanged).
- The phone has no CLI update surface.
