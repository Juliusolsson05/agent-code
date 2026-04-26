import { ipcMain } from 'electron'

import { listWorktreesForCwd } from '@main/ipc/git.js'
import type { WorktreeActivityIndex } from '@main/worktreeActivity/WorktreeActivityIndex.js'

export function registerWorktreeActivityIpc(index: WorktreeActivityIndex): void {
  ipcMain.handle(
    'worktree-activity:summary',
    async (_evt, cwd: string, refresh?: boolean) => {
      try {
        const worktrees = await listWorktreesForCwd(cwd)
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
