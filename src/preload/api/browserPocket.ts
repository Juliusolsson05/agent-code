import { ipcRenderer } from 'electron'

import { subscribe } from '@preload/api/ipc.js'
import type { Unsub } from '@preload/api/types.js'
import type {
  ForwardedKey,
  LanePort,
  PocketDrivingEvent,
  PocketFlags,
  PocketLocalAction,
  PocketPickResult,
  PortWatchSession,
} from '@shared/browserPocket/types.js'

// Renderer ↔ main bridge for the lane browser pocket. The <webview> guests
// themselves get NO preload (main strips it at attach); this bridge belongs to
// the privileged app renderer only.
export const browserPocketApi = {
  pocketPartition: (p: { pocketId: string; profile: 'lane' | 'project'; projectId?: string }): Promise<string> =>
    ipcRenderer.invoke('browser-pocket:partition', p),
  registerPocketGuest: (p: { pocketId: string; sessionId: string; webContentsId: number }): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('browser-pocket:register-guest', p),
  unregisterPocketGuest: (p: { pocketId: string }): Promise<void> =>
    ipcRenderer.invoke('browser-pocket:unregister-guest', p),
  setPocketFlags: (flags: PocketFlags): Promise<void> =>
    ipcRenderer.invoke('browser-pocket:set-flags', flags),
  takeOverPocket: (p: { pocketId: string }): Promise<void> => ipcRenderer.invoke('browser-pocket:take-over', p),
  resumePocketAgent: (p: { pocketId: string }): Promise<void> => ipcRenderer.invoke('browser-pocket:resume', p),
  pocketThumbnail: (p: { pocketId: string }): Promise<string | null> => ipcRenderer.invoke('browser-pocket:thumbnail', p),
  pickInPocket: (p: { pocketId: string }): Promise<PocketPickResult | null> => ipcRenderer.invoke('browser-pocket:pick', p),
  cancelPocketPick: (p: { pocketId: string }): Promise<void> => ipcRenderer.invoke('browser-pocket:cancel-pick', p),
  applyPocketEmulation: (p: { pocketId: string; emulation: { viewport?: { width: number; height: number; mobile: boolean } | null; colorScheme?: 'light' | 'dark' | null; zoom?: number } }): Promise<void> =>
    ipcRenderer.invoke('browser-pocket:emulation', p),
  setPocketPortWatch: (p: { sessions: PortWatchSession[] }): Promise<void> => ipcRenderer.invoke('browser-pocket:set-watch', p),
  clearPocketStorage: (p: { pocketId: string; profile: 'lane' | 'project'; projectId?: string }): Promise<void> =>
    ipcRenderer.invoke('browser-pocket:clear-storage', p),

  onPocketChord: (cb: (key: ForwardedKey) => void): Unsub => subscribe('browser-pocket:chord', cb),
  onPocketLocalAction: (cb: (p: { pocketId: string; action: PocketLocalAction }) => void): Unsub => subscribe('browser-pocket:local-action', cb),
  onPocketBlockedPopup: (cb: (p: { pocketId: string; url: string }) => void): Unsub => subscribe('browser-pocket:blocked-popup', cb),
  onPocketOpenRequest: (cb: (p: { sessionId: string; url?: string }) => void): Unsub => subscribe('browser-pocket:open-request', cb),
  onPocketPorts: (cb: (p: { bySession: Record<string, LanePort[]> }) => void): Unsub => subscribe('browser-pocket:ports', cb),
  onPocketDriving: (cb: (p: PocketDrivingEvent) => void): Unsub => subscribe('browser-pocket:driving', cb),
  onPocketViewportRequest: (cb: (p: { sessionId: string; viewport: { mode: 'fill' } | { mode: 'preset'; preset: string } | { mode: 'free'; width: number; height: number } }) => void): Unsub =>
    subscribe('browser-pocket:set-viewport', cb),
}
