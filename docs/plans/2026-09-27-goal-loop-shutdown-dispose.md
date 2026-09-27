# Dispose the goal loop at quit (#1372)

## Evidence
- **Mechanism, recorded:** #1341 (CI run 36156560842). `GoalLoopService` persists loop state with fire-and-forget `void this.persist()`. When its owner tore down first, the late write failed: 13 `[goal-loop] persisting loop state failed: ENOENT … rename …goal-loop.json.<uuid>.tmp` warnings, 12 `rename` and 1 `open`. There the owner was a test's `afterEach`. At quit it is the process exit, and there is no log line, because the process is gone.
- **The drain exists:** #1371 added `GoalLoopService.dispose()`, which cancels timers, detaches the session manager, and awaits in-flight persists and continuations. It was left out of the shutdown inventory on purpose, because that inventory has its own owner and test (#1371 body).
- **The gap, read from source:** `installApplicationShutdown` (`src/main/applicationShutdown.ts`) has no goal-loop stage, and `index.ts` keeps the service in a startup local, so shutdown cannot reach it.
- **Not recorded:** a real quit that lost loop state. No production incident exists; this closes the window the #1341 mechanism leaves open at quit.

## Constraints on placement
- **After sessions stop:** a turn boundary from a live session starts a persist (and possibly a continuation), so disposing before `killAll()` settles could lose that last write.
- **After the built-in MCP host stops:** `goal_loop_start` / `goal_loop_complete` reach the service through MCP tools, and a call after `dispose()` would be ignored.
- **Before quit is allowed:** its drain must settle.
That is the support-disposal wave beside control and caffeinate.

## Change
- `ApplicationShutdownServices.disposeGoalLoop` runs in that wave.
- `index.ts` publishes `disposeGoalLoop` once the service exists (the `disposeControlHost` pattern).

## Tests (fail-first)
- `applicationShutdown.test.ts`, with deferred inventory services:
  - dispose is not called while sessions are stopping or while the MCP host is stopping;
  - quit waits for its drain.
  - It fails on the pre-change inventory, and a mutation that disposes it in the first wave, beside sessions, also fails.
- The existing veto test iterates every inventory entry, so an editor veto disposes nothing.
- This models the inventory, not a real quit (the app is never launched in this loop).

## Overlap
W3's #1430 work (`.worktrees/worktree-timeout-consumers`) also edits `src/main/index.ts`, in different hunks (`resolveRepoRoot` / conversation setup). Merge order is the manager's call; the two changes do not interact.
