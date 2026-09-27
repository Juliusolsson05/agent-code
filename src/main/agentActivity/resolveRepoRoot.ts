/**
 * The repository an agent's activity is filed under: the main checkout, i.e.
 * the first entry of `git worktree list` (#1430).
 *
 * WHY a timeout is retried once and then THROWN rather than answered with the
 * cwd: the recorder files each interval under the root this returns, so a
 * timed-out (empty) list used to file a worktree's activity under the worktree
 * itself — a silent, persisted mis-grouping. A timeout is almost always the
 * git queue being busy (#1429's shared queue of five), which drains, so one
 * retry usually answers. Two timeouts are "unknown", and unknown is thrown:
 * the recorder records that one interval's repository as UNKNOWN (`''`, the
 * store's "no repository" value) and warns, and the next interval asks again.
 * Not the cwd (steering q126): the store persisted it, and a worktree folder
 * became a repository of its own that no later interval could fold back.
 * Never a loop — the recorder awaits this on every interval open.
 *
 * A non-repository (git answered, no worktrees) is not a timeout: the cwd is
 * then the honest root, exactly as before.
 */
export class RepoRootUnknown extends Error {
  constructor(cwd: string) {
    super(`git worktree list timed out twice for ${cwd}`)
    this.name = 'RepoRootUnknown'
  }
}

export async function resolveRepoRootAfterGit(
  listDetailed: (cwd: string) => Promise<{ worktrees: ReadonlyArray<{ path: string }>; timedOut: boolean }>,
  cwd: string,
): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { worktrees, timedOut } = await listDetailed(cwd)
    if (!timedOut) return worktrees[0]?.path ?? cwd
  }
  throw new RepoRootUnknown(cwd)
}
