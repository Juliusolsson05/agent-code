import { stat } from 'node:fs/promises'
import path from 'node:path'

/**
 * The session's workspace directory is gone from disk.
 *
 * WHY this is a typed error carrying a quotable message, when every other
 * spawn failure is deliberately flattened to "Session failed to start. Check
 * provider setup and retry.": that flattening exists to keep provider launch
 * exceptions — which can contain environment values, proxy URLs and scoped
 * MCP tokens — off IPC. A missing cwd carries none of that. The path is
 * already rendered in the pane header, and this is the one start failure the
 * user can actually act on.
 */
export class MissingWorkspaceDirectoryError extends Error {
  constructor(readonly cwd: string) {
    super(`Workspace folder is missing: ${cwd}`)
    this.name = 'MissingWorkspaceDirectoryError'
  }
}

/**
 * Resolve-and-stat a spawn cwd before any backend is started.
 *
 * WHY this check exists at all: node-pty performs the chdir INSIDE the forked
 * child (`node_modules/node-pty/src/unix/pty.cc`: `if (chdir(cwd_) == -1)
 * _exit(1)`). A deleted directory therefore produces a *successful* PTY
 * creation followed by an immediate exit(1), and every layer above reports
 * good news on the way up: the provider start resolves ok, `recover()`
 * returns `ok: true` with disposition 'spawned', and the failure only
 * surfaces much later as the readiness wait giving up with "Agent exited
 * before it became ready for input (start-failed)".
 *
 * That is exactly what the 2026-09-08 incident journal shows for six sessions
 * whose git worktrees had been deleted 33 minutes before the app launched.
 * The message named neither the directory nor the cause, so the failure read
 * as a mysterious provider fault.
 *
 * Trading one stat() per spawn for an error that says what is actually wrong
 * is worth it here in particular, because worktree-per-branch is the standing
 * workflow in this repo: panes routinely outlive the directory they were
 * opened in.
 *
 * WHY stat and not lstat: symlinked worktrees are common, and the question is
 * only whether the child's chdir will succeed. chdir follows symlinks, so a
 * dangling symlink must fail here for the same reason a deleted directory
 * does, and reporting one message for both is the correct answer.
 */
export async function assertWorkspaceDirectoryExists(cwd: string): Promise<void> {
  const resolved = path.resolve(cwd)
  let isDirectory: boolean
  try {
    isDirectory = (await stat(resolved)).isDirectory()
  } catch {
    // Anything that makes the directory unusable from here (ENOENT, ENOTDIR,
    // a dangling symlink, EACCES on a parent) would fail the child's chdir
    // for the same practical reason. One message keeps the user pointed at
    // the folder rather than at an errno.
    throw new MissingWorkspaceDirectoryError(resolved)
  }
  if (!isDirectory) throw new MissingWorkspaceDirectoryError(resolved)
}
