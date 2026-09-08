import { ipcMain } from 'electron'

import type { VaultService } from '@main/keyVault/VaultService.js'
import type { KeyVaultKeyInput } from '@shared/types/keyVault'
import { broadcastToWindows } from '@main/window/windowRegistry.js'
import { z } from 'zod'

// IPC validates wire shapes and gates metadata operations; the service owns
// secret-read authorization and file transactions. Clipboard copy stays in
// main, while reveal and template resolution return a gated secret to the UI.
export function registerKeyVaultIpc({ vaultService }: { vaultService: VaultService }): void {
  vaultService.on('locked', () => broadcastToWindows('key-vault:locked', {}))
  // Metadata mutations are protected too. TypeScript types cannot validate
  // IPC input, and schema errors must not echo submitted secrets to diagnostics.
  const text = z.string().max(65536)
  const key = z.object({ providerId: text, id: text.optional(), name: text, value: text, note: text }).strict()
  function parse<T>(schema: z.ZodType<T>, value: unknown): T {
    const result = schema.safeParse(value)
    if (!result.success) throw new Error('Invalid vault request.')
    return result.data
  }
  async function unlocked<T>(operation: () => Promise<T>): Promise<T> {
    await vaultService.unlock()
    if (!vaultService.getStatus().unlocked) throw new Error('Vault was locked.')
    return operation()
  }
  ipcMain.handle('key-vault:status', () => vaultService.getStatus())
  ipcMain.handle('key-vault:list', () => unlocked(() => vaultService.list()))
  ipcMain.handle('key-vault:unlock', () => vaultService.unlock())
  ipcMain.handle('key-vault:lock', () => vaultService.lock())
  ipcMain.handle('key-vault:reveal', (_event, providerId: string, keyId: string) =>
    vaultService.reveal(providerId, keyId))
  ipcMain.handle('key-vault:copy-key', (_event, providerId: string, keyId: string) =>
    vaultService.copyKey(providerId, keyId))
  ipcMain.handle('key-vault:resolve-ref', (_event, providerName: string, keyName: string) =>
    vaultService.resolveReference(providerName, keyName))
  ipcMain.handle('key-vault:create-provider', (_event, name: string) => unlocked(() => vaultService.createProvider(parse(text, name))))
  ipcMain.handle('key-vault:rename-provider', (_event, id: string, name: string) =>
    unlocked(() => vaultService.renameProvider(parse(text, id), parse(text, name))))
  ipcMain.handle('key-vault:delete-provider', (_event, id: string) => unlocked(() => vaultService.deleteProvider(parse(text, id))))
  ipcMain.handle('key-vault:put-key', (_event, input: KeyVaultKeyInput) => unlocked(() => vaultService.putKey(parse(key, input))))
  ipcMain.handle('key-vault:delete-key', (_event, providerId: string, keyId: string) =>
    unlocked(() => vaultService.deleteKey(parse(text, providerId), parse(text, keyId))))
}
