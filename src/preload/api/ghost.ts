import { ipcRenderer } from 'electron'

// Ghost journal bridge.
//
// One file per session under <userData>/ghost-logs. Writes are
// fire-and-forget at the renderer level; the main-side queue drains
// every 100 ms. Reads replay the full log so atp's `reduceGhostLog`
// can fold it into current state on mount. The ghost value crosses
// IPC as plain JSON — no atp runtime in main.

export const ghostApi = {
  ghostAppend: (sessionId: string, ghost: unknown): void => {
    void ipcRenderer.invoke('ghost:append', sessionId, ghost)
  },
  ghostRead: (sessionId: string): Promise<unknown[]> =>
    ipcRenderer.invoke('ghost:read', sessionId),
}
