import { ipcRenderer } from 'electron'

import { subscribe } from '@preload/api/ipc.js'
import type { Unsub } from '@preload/api/types.js'
import type {
  HermesConnectionDraft,
  HermesConnectionInfo,
  HermesLaneListing,
  HermesTestResult,
} from '@shared/hermes/types.js'
import type { HermesDetection, HermesSshDraft } from '@shared/hermes/ssh.js'

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
  /** The gateway routing key of the connection's Telegram DM thread, or null (#1496). */
  hermesDefaultLane: (id: string): Promise<string | null> => ipcRenderer.invoke('hermes:default-lane', id),
  /** Every messaging thread on the connection's server, for "Change Telegram Thread…" (#1501). */
  hermesListLanes: (id: string): Promise<HermesLaneListing> => ipcRenderer.invoke('hermes:list-lanes', id),
  hermesSignOut: (id: string): Promise<void> => ipcRenderer.invoke('hermes:sign-out', id),
  /** Save (null: forget) the connection's SSH access (#1528). */
  hermesSetSsh: (id: string, draft: HermesSshDraft | null): Promise<HermesConnectionInfo> => ipcRenderer.invoke('hermes:set-ssh', id, draft),
  /** Find where the `hermes` CLI runs on the server, over SSH; saved when unambiguous. */
  hermesDetect: (id: string): Promise<HermesDetection> => ipcRenderer.invoke('hermes:detect', id),
  /** The ssh line a new terminal pane types for the server (`vps`) or a shell with `hermes` (`hermes`). */
  hermesShellCommand: (id: string, target: 'vps' | 'hermes'): Promise<{ ok: true; command: string; name: string } | { ok: false; error: string }> =>
    ipcRenderer.invoke('hermes:shell-command', id, target),
  onHermesConnectionsChanged: (cb: (connections: HermesConnectionInfo[]) => void): Unsub =>
    subscribe('hermes:connections-changed', cb),
}
