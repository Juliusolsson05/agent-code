import { ipcRenderer } from 'electron'
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
  onGoalChanged: (listener: (update: TldrUpdate) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, update: TldrUpdate) => listener(update)
    ipcRenderer.on('goal:changed', handler)
    return () => { ipcRenderer.removeListener('goal:changed', handler) }
  },
  readTldrEnforcement: (identities: string[]): Promise<Record<string, TldrEnforcementStatus>> => ipcRenderer.invoke('tldr:enforcement', identities),
  onTldrChanged: (listener: (update: TldrUpdate) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, update: TldrUpdate) => listener(update)
    ipcRenderer.on('tldr:changed', handler)
    return () => { ipcRenderer.removeListener('tldr:changed', handler) }
  },
}
