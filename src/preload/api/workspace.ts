import { ipcRenderer } from 'electron'

// Workspace state persistence bridge.
//
// Main just does the disk I/O. The renderer decides the JSON shape
// (see workspaceStore.ts flushSave). Keeping these on the bridge
// instead of inlining fetch() calls from the renderer means one
// serialization path and one place to adjust when the format
// evolves.

export const workspaceApi = {
  loadWorkspace: (): Promise<string | null> =>
    ipcRenderer.invoke('workspace:load'),

  saveWorkspace: (json: string): Promise<void> =>
    ipcRenderer.invoke('workspace:save', json),

  defaultCwd: (): Promise<string> =>
    ipcRenderer.invoke('workspace:defaultCwd'),
}
