import { ipcRenderer } from 'electron'

import type { SavedClaudeImage } from '@preload/api/types.js'

// Filesystem bridge — path expansion + directory listing + Claude
// image paste cache.

export const fsApi = {
  // Path expansion (used by the new-tab path modal). The error variant
  // carries an optional `resolvedPath` so callers that want to show the
  // would-be path (e.g. "Will create: <abs>") don't have to replicate
  // the `~` expansion logic on the renderer side.
  expandCwd: (
    raw: string,
  ): Promise<
    | { ok: true; path: string }
    | { ok: false; error: string; resolvedPath?: string }
  > => ipcRenderer.invoke('fs:expandCwd', raw),

  // Create a directory the user typed in the path picker. Mirrors
  // expandCwd's expansion + result shape so the caller can branch on
  // the same union. Kept distinct from expandCwd because expandCwd is
  // a read-only validation gate the rest of the new-tab flow depends
  // on; folding `mkdir` into it would silently make every call a
  // potential write. See src/main/ipc/fs.ts for the full WHY.
  createDirectory: (
    raw: string,
  ): Promise<{ ok: true; path: string } | { ok: false; error: string }> =>
    ipcRenderer.invoke('fs:createDirectory', raw),

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
