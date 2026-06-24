import { ipcRenderer } from 'electron'
import type { GitWorktreeStatus, WorktreeIdentity } from '@shared/types/git'
import type {
  WorktreeActivityIndexStatus,
  WorktreeActivitySummary,
} from '@preload/api/types'
// Single source of truth for the GitBar `git:status` payload. The main handler
// (`src/main/ipc/git.ts`) annotates its return with the same type, so a field
// change there is a compile error here and in the renderer rather than a silent
// shape drift across the IPC boundary.
import type { GitBarStatusResult } from '@shared/types/gitStatus.js'

// Git status bridge — used by GitBar.
//
// Parent-repo branch + numstat + recent log, plus a per-submodule
// section with bumped / dirty / both states. See main/ipc/git.ts for
// the command argv rules. Returns { ok: false } for non-git
// directories so the bar can cleanly degrade.

export const gitApi = {
  gitWorktrees: (cwd: string): Promise<
    | { ok: true; worktrees: WorktreeIdentity[] }
    | { ok: false }
  > => ipcRenderer.invoke('git:worktrees', cwd),

  gitWorktreeStatus: (cwd: string): Promise<
    | { ok: true; worktrees: GitWorktreeStatus[] }
    | { ok: false }
  > => ipcRenderer.invoke('git:worktree-status', cwd),

  worktreeActivitySummary: (
    cwd: string,
    refresh = false,
  ): Promise<
    | {
        ok: true
        summaries: WorktreeActivitySummary[]
        status: WorktreeActivityIndexStatus
      }
    | { ok: false }
  > => ipcRenderer.invoke('worktree-activity:summary', cwd, refresh),

  gitStatus: (cwd: string): Promise<GitBarStatusResult> =>
    ipcRenderer.invoke('git:status', cwd),
}
