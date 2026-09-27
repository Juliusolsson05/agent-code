# A git command that timed out never reads as "clean" or "not a repo" (#1250 row 11)

Short plan: a bug with a known root cause. The row comes from `temp/quality-loop/hunt-c3.md` (row 11, P3). #1250 is a batch issue, so this PR is `Refs #1250`.

## Outcome
In a large repo, or on a busy disk, a git command can exceed the runner's 5 s timeout. Today every failure returns `''` by contract, so:
- **Worktrees panel** (a cleanup tool): a timed-out `git status` makes a dirty worktree read CLEAN. A timed-out `git cherry` reads as zero patch-unique commits, so the row becomes "patch-equivalent", a cleanup suggestion. The answer is cached for 30 s.
- **Worktrees panel / GitBar:** a timed-out list or branch probe reads "Not a Git repository."
- **GitBar:** a timed-out diff or log shows a partial, clean-looking status.

After this change, a timeout is recorded and said, and it never makes a worktree look safe to remove.

## Root cause (verified in source, origin/main)
- `src/main/ipc/git.ts` `runGitCommand` returns `''` for every failure. The contract is documented and callers rely on it. Only a missing binary is latched (`gitMissing`, #495 A5); a timeout is invisible.

## Design (contract)
- **A timeout trace.** `runGitCommand` recognises an execFile timeout (`killed` with `SIGTERM`) and marks the trace captured when the command was queued. The trace is an `AsyncLocalStorage<{ timedOut: boolean }>` read synchronously in `git()`, so the queue does not lose it. `''` is still returned, so the contract holds for every existing caller.
- **Worktree status rows** (`computeWorktreeStatusForCwd`), each under its own trace:
  - a timed-out `git status` sets `dirty: true`;
  - any timeout in the row sets `statusTimedOut: true` and category `review` (never `cleanup-merged` or `patch-equivalent`);
  - a list with any timed-out row is not cached.
  - `GitWorktreeStatus` gains optional `statusTimedOut?: boolean`.
- **The worktree list** (`git:worktrees`, `git:worktree-status`) and **GitBar's branch probe** (`git:status`): a timed-out probe answers `{ ok: false, gitMissing, timedOut: true }`.
- **`git:status`:** a timeout in a later command answers `ok: true` with `incomplete: true`.
- **Renderer:**
  - GitBar and the Worktrees panel say "Git took too long to answer here. It will try again." instead of "Not a Git repository.";
  - GitBar adds "Git took too long; this may be incomplete." under an incomplete status;
  - a timed-out worktree row shows "status unknown (git timed out)" in place of the dirty chip.

## Tests
- **`src/main/ipc/git.timeout.test.ts`:** the real handlers, with `execFile` replaced (the edge) to time out chosen commands as Node does (`killed: true, signal: 'SIGTERM'`).
  - A timed-out `git status` for a row gives `dirty: true, statusTimedOut: true, category: 'review'`.
  - A timed-out `git cherry` is never `patch-equivalent`.
  - A timed-out list gives `timedOut: true`.
  - A timed-out branch probe gives `timedOut: true`; a timed-out log gives `incomplete: true`.
  - A timed-out list is not cached (the next call runs git again).
  - All red on main.
- **Renderer:** GitBar says the timeout (not "Not a Git repository") and marks an incomplete status. The Worktrees panel says the timeout, and a timed-out row shows its chip.

## Out of scope
- #1250's other rows.
- The 5 s timeout value itself.

## Review round 1 (a, b: FIX-BEFORE-MERGE)
- **a1 / b1: `worktrees.read` (the control surface) dropped the timeout**, so an agent read a slow repo as "not a repository". It now reports `gitTimedOut`, and its description says so. Test through `execute` (which validates the output schema), with the real `loadWorktreeDump`. It fails on the previous head and kills b's surviving mutation (`gitTimedOut: false` in `loadWorktreeDump`).
- **b2 / b3: other consumers of the plain list** (the conversation-picker family, worktree activity, the agent-activity repo root, renderer history context) still read a timed-out list as empty. Each self-heals on the next call, and none is part of the Worktrees panel and GitBar surfaces this row covers. Split into #1430, which names each consumer and the fix direction.
