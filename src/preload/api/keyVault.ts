import { ipcRenderer } from 'electron'
import { subscribe } from '@preload/api/ipc.js'

import type { KeyVaultKeyInput, KeyVaultSnapshot, KeyVaultStatus } from '@shared/types/keyVault'

// Flat key-vault surface merged into window.api. Rejected promises carry
// the service's Error message (cancel, fail-closed, not-found) so the UI
// can toast it verbatim.
export const keyVaultApi = {
  onKeyVaultLocked: (callback: () => void) => subscribe('key-vault:locked', callback),
  keyVaultStatus: (): Promise<KeyVaultStatus> => ipcRenderer.invoke('key-vault:status'),
  keyVaultList: (): Promise<KeyVaultSnapshot> => ipcRenderer.invoke('key-vault:list'),
  keyVaultUnlock: (): Promise<void> => ipcRenderer.invoke('key-vault:unlock'),
  keyVaultLock: (): Promise<void> => ipcRenderer.invoke('key-vault:lock'),
  keyVaultReveal: (providerId: string, keyId: string): Promise<string> =>
    ipcRenderer.invoke('key-vault:reveal', providerId, keyId),
  keyVaultCopyKey: (providerId: string, keyId: string): Promise<void> =>
    ipcRenderer.invoke('key-vault:copy-key', providerId, keyId),
  keyVaultResolveReference: (providerName: string, keyName: string): Promise<string> =>
    ipcRenderer.invoke('key-vault:resolve-ref', providerName, keyName),
  keyVaultCreateProvider: (name: string): Promise<void> =>
    ipcRenderer.invoke('key-vault:create-provider', name),
  keyVaultRenameProvider: (id: string, name: string): Promise<void> =>
    ipcRenderer.invoke('key-vault:rename-provider', id, name),
  keyVaultDeleteProvider: (id: string): Promise<void> =>
    ipcRenderer.invoke('key-vault:delete-provider', id),
  keyVaultPutKey: (input: KeyVaultKeyInput): Promise<void> =>
    ipcRenderer.invoke('key-vault:put-key', input),
  keyVaultDeleteKey: (providerId: string, keyId: string): Promise<void> =>
    ipcRenderer.invoke('key-vault:delete-key', providerId, keyId),
}
