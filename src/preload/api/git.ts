import { ipcRenderer } from 'electron'

// Git status bridge — used by GitBar.
//
// Parent-repo branch + numstat + recent log, plus a per-submodule
// section with bumped / dirty / both states. See main/ipc/git.ts for
// the command argv rules. Returns { ok: false } for non-git
// directories so the bar can cleanly degrade.

export const gitApi = {
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
