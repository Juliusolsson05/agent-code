# Goal loop: a drain for in-flight work (#1341, plus #1296 items 3 and 7)

## Problem
`GoalLoopService` starts work it never lets anyone await:
- **Fire-and-forget promises:** `void this.persist()` (5 sites) and `void this.maybeContinue()` (2 sites).
- **Zero-delay deferrals:** `setTimeout(() => this.requestContinue(id), 0)`, used after a Stop hook and in `scheduleContinueCheck`.
- **Future polls:** the 1 s hold poll and the delivery-retry backoff.

Consequences, all in tests:
- **#1341.** `afterEach` removes the temp dir while a `persist()` is still writing. On main CI run 36156560842, the GoalLoopService worker logged 13 `[goal-loop] persisting loop state failed: ENOENT … rename …tmp` warnings, against 13 distinct temp dirs.
- **#1296 item 3.** `goalLoopTurnHooks.system.test.ts` sleeps 20 ms (`settle`) before `rm`, and hits ENOTEMPTY under load.
- **#1296 item 7.** Weak negatives: a fixed sleep (10 ms, 25 ms, 50 ms, 300 ms, 400 ms, 1.5 s) followed by "not called" passes vacuously when the work simply has not run yet. Sites:
  - `GoalLoopService.test.ts` :76, :86, :217, :343, :552, :739, :748;
  - `goalLoop.system.test.ts` :59;
  - `goalLoopTurnHooks.system.test.ts` `settle`.

## Decisions (defaults)
- **`whenSettled(): Promise<void>`** resolves when no tracked work is in flight. Tracked work is every promise the service starts without awaiting, plus every **zero-delay** deferral (a scheduled `requestContinue` counts as in flight until it has run and its own work has settled). It loops until the set stays empty, because settling work can start more (a persist that finishes a continuation can re-trigger one).
  - The future polls (hold poll, retry backoff) are **not** in flight. They are scheduled future work, and a test drives them with fake timers.
  - With that definition, "nothing happened" is provable: after an event, `await svc.whenSettled()` and then assert.
- **`dispose(): Promise<void>`** stops new work (a `disposed` flag that `requestContinue` and the schedulers check), clears every timer (continue checks, hold polls, retries, deferrals), then awaits `whenSettled()`. The tests' `afterEach` disposes every service before removing its directory. That fixes the ENOENT and ENOTEMPTY noise at the root instead of sleeping.
- **Not a test-only seam:** both are ordinary public methods of the service. **Wiring `dispose()` into the app's shutdown inventory (`installApplicationShutdown`) is left out.** That composition has its own exhaustive inventory and owner, and a lost final persist at quit is pre-existing behaviour. It is filed as a follow-up.
- **The log is not swallowed** (the issue's instruction). A write that fails for a real reason still warns.
- Sleeps become `whenSettled()` (or `vi.waitFor` on the positive condition). No timeout is widened.

## Tests
- **Fail-first:** a test that disposes a service while a slow store write is in flight asserts that the write finished before `dispose()` resolved, and that nothing was scheduled afterwards. It fails on main, where there is no drain.
- A negative made real: after a held turn, `whenSettled()` resolves and delivery is still 0. Mutating `whenSettled` to resolve immediately must turn some test red; the proof is recorded in the PR.
- The GoalLoopService worker must log zero ENOENT warnings in a full run of the three files. The run is checked by grepping its output.
