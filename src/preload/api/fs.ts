import { ipcRenderer } from 'electron'

import type { SavedClaudeImage } from '@preload/api/types.js'

// Filesystem bridge — path expansion + directory listing + Claude
// image paste cache.

export const fsApi = {
  // Path expansion (used by the new-tab path modal).
  expandCwd: (
    raw: string,
  ): Promise<{ ok: true; path: string } | { ok: false; error: string }> =>
    ipcRenderer.invoke('fs:expandCwd', raw),

  // Directory listing (used by PathInput for completion). Returns up
  // to ~thousands of entries for a given directory. Renderer filters
  // client-side by the trailing "base" part of the user input.
  listDirectory: (
    rawPath: string,
    opts?: { directoriesOnly?: boolean; showHidden?: boolean },
  ): Promise<
    | {
        ok: true
        entries: Array<{ name: string; isDirectory: boolean; path: string }>
        expanded: string
      }
    | { ok: false; error: string }
  > => ipcRenderer.invoke('fs:listDirectory', rawPath, opts),

  saveClaudeImage: (params: {
    base64Data: string
    mediaType: string
    filename?: string
  }): Promise<SavedClaudeImage> =>
    ipcRenderer.invoke('fs:saveClaudeImage', params),
}
