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
  - If it times out again it throws `RepoRootUnknown`. The recorder then
    records the interval's repository as UNKNOWN (`''`, the store's
    existing "no repository" value, which the summary labels Unknown) and
    warns. The worktree row keeps its `cwd`, and the next interval asks git
    again.
  - Steering q126: the first version fell back to the cwd. The store
    persisted it, and summarize grouped by it, so a worktree folder became
    a repository of its own that no later interval could fold back. It
    never healed.
  - Ruling: one retry, never a loop. The recorder awaits this on every
    interval open.
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
- `AgentActivityRecorder` (steering q126), the real interval path and a real
  store: two timeouts, then success. The first interval is under Unknown,
  the second under the repository, and there is never a bucket keyed by the
  worktree folder. Before: a `/dev/agent-code/.worktrees/fix` repository.
- `loadWorktreeDump` / `formatWorktreeDump`: the activity line says the
  git timeout.
- `initialHistory`: a `timedOut` worktrees answer leaves `workActivity`
  untouched. Before: it was ingested against `[]`.

## Verification

`npx tsc -b` and the scoped vitest runs. The app is not launched.

## Out of scope

`listWorktreesForCwd`'s other callers (MCP read paths) already go through
#1429's surfaces.

## Review round 1 (a, b: FIX-BEFORE-MERGE), each fix fail-first

- **a (major): pages from two families.** Page 1 was built while git timed
  out (the cwd alone), and page 2 after git recovered (the whole
  repository). Appending lost the rows the recovered order puts before the
  cursor, and page 2's family cleared the warning.
  - Fix: `useConversationList` compares the page's family (root, roots,
    `gitTimedOut`) with what it appends to. On a change it discards the page
    and reloads page 1.
  - Pinned: a picker test drives ArrowDown paging across recovery.
- **a + b (major): skipped history lost its worktree evidence.** Skipping
  attribution on a timeout meant the reconciler, which replays only what it
  observed, never saw the chunk. A quiet session stayed on the launch folder
  after git recovered.
  - Fix: `WorkspaceRefs.worktreeReconcilerRef` publishes the live
    reconciler. Both history loaders hand a timed-out chunk to it
    (`handHistoryToReconciler`: `observe` plus `refresh`), and its bounded
    window replays the chunk when a later refresh gets the catalog. Failed
    probes are not cached, so the next refresh retries.
  - Pinned: the real reconciler with the recorded `codex-0151` window
    reaches `.../worktree-2` after git recovers, and a loader-level test
    shows the timed-out chunk is handed over. Removing that call turns it
    red.
- **b (minor): the note showed in Everywhere,** where the family removes no
  rows. It now shows only in Repository scope. Pinned.
- **a (surviving mutation): the repository-unknown warning.** It is now
  asserted.
- **c (MERGE-READY), minors:**
  - The older-history loader's hand-off and its null guard are pinned by a
    `loadOlderHistory` test with git timing out. Both of c's mutations are
    now red.
  - The dead `listWorktreesForCwd` export is removed.
  - The body's counts are corrected.
  - Residual, accepted: the production publish of `worktreeReconcilerRef`
    in `useIpcSubscriptions` is unasserted, because mounting that hook is
    heavy. Every loader and reconciler test injects the ref.

## Verification pass (a, b: FIX-BEFORE-MERGE), each fix fail-first

Both findings are gaps in the round-1 hand-off.

- **a (major): a fresh cached catalog never repainted.** A live event had
  already cached the catalog, and only the history's own `gitWorktrees`
  call timed out. `refresh()` answered `cached` and never called
  `onCatalogReady`, so the handed-over chunk sat in the window.
  - Fix: `LiveWorktreeReconciler.replayCachedCatalog(cwd)` replays the
    retained evidence against a real cached catalog. It does nothing for
    the empty placeholder an in-flight probe writes.
    `handHistoryToReconciler` calls it when `refresh` answers `cached`.
  - Pinned: the recorded `codex-0151` window, with the catalog loaded
    first, reaches `worktree-2`. Before the fix it stayed on the main
    checkout.
- **b (major): an older page could replace a newer context.** The
  reconciler appends what it observes as the newest evidence.
  - Fix: the older-history loader hands a page over only while
    `workContext` is unknown. This is the same recency rule as its
    answered-git backfill.
  - Pinned: a pane with a known context hands nothing over and keeps it.
  - Ruling: initial history needs no such guard. It is the transcript's
    tail, the newest evidence there is.

## Manager verification (B6 at f5fc3585: FIX), fixed fail-first

- **A scroll-up during a git timeout outranked the newest chunk.** The
  sequence: the initial history (worktree-1) is handed over during a
  timeout, then the user scrolls up while git still times out, and the
  older page (worktree-2) is handed over too. It was appended as the
  newest evidence, and once git recovered the pane landed on worktree-2.
  - Fix: `observe(..., position)`. An older page enters at the OLD end of
    the window (`retainOlder`), under the same 2 × limit bound.
  - Overflow is the oldest evidence there is, so it is dropped rather than
    folded when a catalog is cached. The folded baseline holds newer
    records, and folding on top of them would make the page newest again.
  - `handHistoryToReconciler(..., 'older')` is used by the older-history
    loader.
  - Pinned: the recorded `codex-0151` window as the older page, with the
    same records moved to worktree-1 and 1 h later as the newest chunk,
    and the recorded three-worktree catalog. It now lands on worktree-1.
  - Mutations: appending instead of prepending, and the loader passing
    newest, are each 1 red.
- The `resolveRepoRoot.ts` header now says Unknown, not the cwd.
- Filed separately by B6, out of scope here: a git failure that is not a
  timeout is still read as "not a repository".
