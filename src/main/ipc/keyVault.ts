import { ipcMain } from 'electron'

import type { VaultService } from '@main/keyVault/VaultService.js'
import type { KeyVaultKeyInput } from '@shared/types/keyVault'

// Thin IPC surface for the key vault (#831). Handlers validate nothing —
// the service owns all rules — so behavior stays testable without
// spinning up ipcMain. Secrets cross only on the reveal/copy/resolve-ref
// return paths, all of which sit behind the service's unlock gate.
export function registerKeyVaultIpc({ vaultService }: { vaultService: VaultService }): void {
  ipcMain.handle('key-vault:status', () => vaultService.getStatus())
  ipcMain.handle('key-vault:list', () => vaultService.list())
  ipcMain.handle('key-vault:unlock', () => vaultService.unlock())
  ipcMain.handle('key-vault:lock', () => vaultService.lock())
  ipcMain.handle('key-vault:reveal', (_event, providerId: string, keyId: string) =>
    vaultService.reveal(providerId, keyId))
  ipcMain.handle('key-vault:copy-key', (_event, providerId: string, keyId: string) =>
    vaultService.copyKey(providerId, keyId))
  ipcMain.handle('key-vault:resolve-ref', (_event, providerName: string, keyName: string) =>
    vaultService.resolveReference(providerName, keyName))
  ipcMain.handle('key-vault:create-provider', (_event, name: string) => vaultService.createProvider(name))
  ipcMain.handle('key-vault:rename-provider', (_event, id: string, name: string) =>
    vaultService.renameProvider(id, name))
  ipcMain.handle('key-vault:delete-provider', (_event, id: string) => vaultService.deleteProvider(id))
  ipcMain.handle('key-vault:put-key', (_event, input: KeyVaultKeyInput) => vaultService.putKey(input))
  ipcMain.handle('key-vault:delete-key', (_event, providerId: string, keyId: string) =>
    vaultService.deleteKey(providerId, keyId))
}
