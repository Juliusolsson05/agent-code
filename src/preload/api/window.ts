import { ipcRenderer } from 'electron'

import { subscribe } from '@preload/api/ipc.js'
import type { Unsub } from '@preload/api/types.js'

// Window-chrome bridge.
//
// It stays its own domain module rather than joining `workspaceApi` because the
// two answer different questions: workspace persistence is about what is IN a
// window, this is about windows themselves.

/** A closed window handing its workspace to this one. `workspace` is the same
 *  `{ workspace: … }` JSON that `loadWorkspace` returns. */
export type WorkspaceAdoptRequest = {
  windowId: string
  workspace: string
}

export const windowApi = {
  newWindow: (): Promise<void> => ipcRenderer.invoke('window:new'),

  onWorkspaceAdopt: (cb: (request: WorkspaceAdoptRequest) => void): Unsub =>
    subscribe('workspace:adopt', cb),

  /**
   * Acknowledge that this window has taken over a closed window's workspace.
   *
   * WHY adoption is confirmed rather than assumed: main deletes the closed
   * window's persisted slice on this call, and until the adopting renderer's
   * next autosave lands, that slice is the ONLY durable record of those
   * sessions. A renderer that refused the merge, failed to parse it, or died
   * mid-handoff simply never calls this, and the workspace comes back as its
   * own window on the next launch instead of being deleted.
   */
  confirmWorkspaceAdoption: (windowId: string): Promise<void> =>
    ipcRenderer.invoke('window:adoption-complete', windowId),
}
