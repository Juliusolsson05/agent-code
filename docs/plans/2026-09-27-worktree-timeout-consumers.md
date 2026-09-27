# A timed-out worktree list is never read as "no family" (#1430)

Size: short plan. It is a follow-up of #1429, which is merged; each
consumer's fix is small and bounded.

## Outcome

When `git worktree list` times out, none of the four remaining consumers
treats the empty answer as "this checkout has no siblings". Each either
says it or stays unknown, and none caches or records the wrong family.

## Evidence (verified 2026-09-27 on origin/main after #1429, do not re-derive)

- `src/main/ipc/git.ts`: `listWorktreesForCwd` returns `[]` on a timeout.
  `listWorktreesForCwdDetailed` returns `{ worktrees, timedOut }` but is not
  exported. Timed-out results are never cached (#1429).
- **Conversations:** `family.ts` `resolveFamily` falls back to the cwd
  alone when the list is empty, so from a linked checkout the main
  checkout's conversations drop out. `service.ts` `discover` caches that
  family's discovery for `DISCOVERY_FRESH_MS` (3 s). The response
  (`ConversationListResponse.family`) says nothing.
- **Worktree activity:** `ipc/worktreeActivity.ts` throws "not a git
  worktree" on `[]` and answers `{ ok: false }`, which `loadWorktreeDump`
  shows as "Agent activity: unavailable", the same as a non-repository.
- **Agent activity repo root:** `index.ts` `resolveRepoRoot` is
  `listWorktreesForCwd(cwd).then(w => w[0]?.path ?? cwd)`. On a timeout it
  records the cwd as the repo root in `AgentActivityRecorder` context, so
  a worktree's activity is filed under the worktree, not its repository.
- **Renderer history:** `initialHistory.ts:301-303` and `history.ts:111-112`
  map any non-ok `gitWorktrees` answer (including `timedOut`) to `[]`, and
  feed it into `ingestWorktreeRawEvent`, which attributes against an empty
  family.

## Change

- `git.ts`: export `listWorktreesForCwdDetailed`.
- **Conversations:**
  - the `ListWorktrees` dependency returns `{ worktrees, timedOut }`;
  - `RepositoryFamily.gitTimedOut: boolean`;
  - a discovery whose family timed out is returned but NOT kept as
    `this.discovery`, so the next request asks git again;
  - `ConversationListResponse.family.gitTimedOut?: true`, and the picker
    shows a muted line: "Git didn't answer in time. Conversations from this
    repository's other worktrees may be missing."
- **Worktree activity:** `{ ok: false, timedOut: true }` on a timeout, and
  the preload type matches. `loadWorktreeDump` gets `activityTimedOut`, and
  the dump line reads "unavailable (Git timed out)".
- **Repo root:** `resolveRepoRootAfterGit(listDetailed, cwd)` lives in
  `agentActivity/`.
  - It retries once when the list timed out: the git queue is the usual
    cause, and it drains.
  - If it times out again it throws. The recorder already catches with
    the cwd, and it now warns that this row's repository is unknown.
  - Ruling: one retry, never a loop. The recorder awaits this on every
    interval open. Cost if wrong: one mis-filed interval, which heals on
    the next.
- **Renderer history:** a `gitWorktrees` answer with `timedOut` skips
  worktree attribution for that chunk, and `workActivity`/`workContext`
  stay as they were. "Unknown" stays unknown; the live reconciler fills it
  in later. A non-repository (`ok: false` without `timedOut`) keeps
  today's `[]`.

## Tests (fail-first, with #1429's execFile timeout fake where main reads git)

- `family`/`service`: a timed-out list gives `gitTimedOut` on the family
  and response, and a second request re-asks git (it isn't cached).
  Before: a cwd-only family, cached.
- `worktreeActivity` IPC: timeout → `{ ok: false, timedOut: true }`.
  Before: `{ ok: false }`.
- `resolveRepoRootAfterGit`:
  - timeout then success → the main checkout;
  - two timeouts → throws;
  - a success first → no retry.
- `loadWorktreeDump` / `formatWorktreeDump`: the activity line says the
  git timeout.
- `initialHistory`: a `timedOut` worktrees answer leaves `workActivity`
  untouched. Before: it was ingested against `[]`.

## Verification

`npx tsc -b` and the scoped vitest runs. The app is not launched.

## Out of scope

`listWorktreesForCwd`'s other callers (MCP read paths) already go through
#1429's surfaces.
