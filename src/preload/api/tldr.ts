import { ipcRenderer } from 'electron'
import { subscribeShared } from '@preload/api/ipc.js'
import type { TldrEnforcementStatus, TldrHistoryEntry, TldrRecord, TldrUpdate } from '@shared/types/tldr.js'

export const tldrApi = {
  startTldrHold: (code: string, token: string): void => { ipcRenderer.send('tldr:hold-start', { code, token }) },
  stopTldrHold: (token: string): void => { ipcRenderer.send('tldr:hold-stop', token) },
  onTldrHoldReleased: (listener: (token: string) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, token: string) => listener(token)
    ipcRenderer.on('tldr:hold-released', handler)
    return () => { ipcRenderer.removeListener('tldr:hold-released', handler) }
  },
  readTldrs: (identities: string[]): Promise<Record<string, TldrRecord>> => ipcRenderer.invoke('tldr:read', identities),
  readTldrHistory: (identity: string): Promise<TldrHistoryEntry[]> => ipcRenderer.invoke('tldr:history', identity),
  readGoals: (identities: string[]): Promise<Record<string, TldrRecord>> => ipcRenderer.invoke('goal:read', identities),
  readGoalHistory: (identity: string): Promise<TldrHistoryEntry[]> => ipcRenderer.invoke('goal:history', identity),
  // Shared (#1039 review): every visible pane's peek subscribes while a
  // TLDR/Goal peek is up.
  onGoalChanged: (listener: (update: TldrUpdate) => void): (() => void) =>
    subscribeShared('goal:changed', listener),
  readTldrEnforcement: (identities: string[]): Promise<Record<string, TldrEnforcementStatus>> => ipcRenderer.invoke('tldr:enforcement', identities),
  onTldrChanged: (listener: (update: TldrUpdate) => void): (() => void) =>
    subscribeShared('tldr:changed', listener),
}
