import { ipcRenderer } from 'electron'
import type { GitWorktreeStatus, WorktreeIdentity } from '@shared/types/git'
import type {
  WorktreeActivityIndexStatus,
  WorktreeActivitySummary,
} from '@preload/api/types'

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

  gitStatus: (cwd: string): Promise<
    | {
        ok: true
        branch: string
        files: Array<{ file: string; additions: number; deletions: number }>
        commits: Array<{
          hash: string
          subject: string
          author: string
          relativeDate: string
        }>
        // Submodules with either a bumped pointer, dirty content, or
        // both. Main filters submodule gitlink entries out of `files`
        // so the paths shown here never duplicate parent rows.
        submodules?: Array<{
          path: string
          state: 'dirty' | 'bumped' | 'both'
          files: Array<{ file: string; additions: number; deletions: number }>
          range?: { from: string; to: string }
        }>
      }
    | { ok: false }
  > => ipcRenderer.invoke('git:status', cwd),
}
