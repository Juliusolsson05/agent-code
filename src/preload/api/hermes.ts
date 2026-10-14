import { ipcRenderer } from 'electron'

import { subscribe } from '@preload/api/ipc.js'
import type { Unsub } from '@preload/api/types.js'
import type {
  HermesConnectionDraft,
  HermesConnectionInfo,
  HermesTestResult,
} from '@shared/hermes/types.js'

// Preload bridge for Hermes connections (#1482). Nothing here carries a
// credential in either direction: sign-in happens in the system browser and
// main keeps the tokens; the renderer only learns connection states.
export const hermesApi = {
  hermesList: (): Promise<HermesConnectionInfo[]> => ipcRenderer.invoke('hermes:list'),
  hermesAdd: (draft: HermesConnectionDraft): Promise<HermesConnectionInfo> => ipcRenderer.invoke('hermes:add', draft),
  hermesUpdate: (id: string, draft: HermesConnectionDraft): Promise<HermesConnectionInfo> =>
    ipcRenderer.invoke('hermes:update', id, draft),
  hermesRemove: (id: string): Promise<void> => ipcRenderer.invoke('hermes:remove', id),
  hermesTest: (id: string): Promise<HermesTestResult> => ipcRenderer.invoke('hermes:test', id),
  hermesSignIn: (id: string): Promise<HermesConnectionInfo> => ipcRenderer.invoke('hermes:sign-in', id),
  hermesCancelSignIn: (id: string): Promise<void> => ipcRenderer.invoke('hermes:cancel-sign-in', id),
  hermesSignOut: (id: string): Promise<void> => ipcRenderer.invoke('hermes:sign-out', id),
  onHermesConnectionsChanged: (cb: (connections: HermesConnectionInfo[]) => void): Unsub =>
    subscribe('hermes:connections-changed', cb),
}
