import { ipcRenderer } from 'electron'

import { subscribe } from '@preload/api/ipc.js'
import type { Unsub } from '@preload/api/types.js'

// Preload bridge for the remote mobile companion's desktop control surface.
// Mirrors main/ipc/remote.ts one-to-one. These types are duplicated from
// RemoteController rather than imported because preload must not pull main-
// process modules into its bundle; the IPC boundary is where the types are
// re-declared, same as every other domain module here.

export type RemotePairedDevice = {
  deviceId: string
  name: string
  createdAt: number
  lastSeenAt: number | null
  revoked: boolean
}

export type RemoteTransportMode = 'lan' | 'tunnel'

export type RemoteStatus = {
  enabled: boolean
  url: string | null
  transport: RemoteTransportMode | null
  tunnelAvailable: boolean
  devices: RemotePairedDevice[]
  connectedDeviceIds: string[]
}

export type RemotePairingIssue = {
  code: string
  expiresAt: number
  pairUrl: string
}

export const remoteApi = {
  remoteGetStatus: (): Promise<RemoteStatus> => ipcRenderer.invoke('remote:get-status'),
  remoteEnable: (mode: RemoteTransportMode = 'lan'): Promise<RemoteStatus> =>
    ipcRenderer.invoke('remote:enable', mode),
  remoteDisable: (): Promise<RemoteStatus> => ipcRenderer.invoke('remote:disable'),
  remoteIssuePairingCode: (): Promise<RemotePairingIssue> =>
    ipcRenderer.invoke('remote:issue-pairing-code'),
  remoteRevokeDevice: (deviceId: string): Promise<boolean> =>
    ipcRenderer.invoke('remote:revoke-device', deviceId),
  remoteSetThemeSettings: (settings: unknown): Promise<void> =>
    ipcRenderer.invoke('remote:set-theme-settings', settings),
  onRemoteStatusChanged: (cb: (status: RemoteStatus) => void): Unsub =>
    subscribe('remote:status-changed', cb),
}
