// agent-activity-staging.ts — where a LIVE agent-activity extraction puts its unaudited output (#1296).
//
// WHY its own module: the extractor script runs on import, and the one property that matters here —
// the bytes land in the file this function created and nowhere else — needs a deterministic test
// that interleaves with the write (testing/unit/agentActivityStaging.test.ts).

import { randomUUID } from 'node:crypto'
import { open } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Create ONE new file under `root` and write `data` through its handle; return its path.
 *
 * WHY a single exclusive file written through its descriptor (review of #1353, round 5 a; manager
 * q82 — a valid blocker, not a residual): the previous shape made a fresh directory and then wrote
 * `<dir>/runtime-states.json` BY PATH. A concurrent process could rename that directory and put a
 * symlink in its place between the two steps, redirecting the write into a git worktree. Here there
 * is no directory component of ours to swap, `wx` refuses a name that already exists (including a
 * planted symlink), and every byte goes through the descriptor `open` returned — renaming or
 * replacing the path afterwards cannot move where the data goes. 0600: the unaudited file is the
 * user's alone.
 *
 * `afterOpen` exists for that test: it runs between the open and the write, exactly where the swap
 * used to land.
 */
export async function writeStagedFile(
  root: string,
  data: string,
  afterOpen?: (path: string) => Promise<void>,
): Promise<string> {
  const path = join(root, `agent-activity-staging-${randomUUID()}.json`)
  const handle = await open(path, 'wx', 0o600)
  try {
    await afterOpen?.(path)
    await handle.writeFile(data, 'utf8')
  } finally {
    await handle.close()
  }
  return path
}
