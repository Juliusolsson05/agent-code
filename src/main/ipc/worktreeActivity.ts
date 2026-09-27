import { ipcMain } from 'electron'

import { listWorktreesForCwdDetailed } from '@main/ipc/git.js'
import type { WorktreeActivityIndex } from '@main/worktreeActivity/WorktreeActivityIndex.js'

export function registerWorktreeActivityIpc(index: WorktreeActivityIndex): void {
  ipcMain.handle(
    'worktree-activity:summary',
    async (_evt, cwd: string, refresh?: boolean) => {
      try {
        const { worktrees, timedOut } = await listWorktreesForCwdDetailed(cwd)
        // #1430: an empty list from a TIMED-OUT git is "unknown", not "not a
        // repository". Said as its own answer so the panel and agents reading
        // it (worktrees.read) do not report the activity index as missing.
        if (timedOut) return { ok: false as const, timedOut: true as const }
        if (worktrees.length === 0) throw new Error('not a git worktree')
        const result = await index.getSummary({
          worktrees,
          refresh: refresh === true,
        })
        return { ok: true as const, ...result }
      } catch {
        return { ok: false as const }
      }
    },
  )
}
