import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { SecretCodec } from '@main/keyVault/vaultStore.js'
import type { UserMcpSecretState } from '@shared/userMcp/types.js'

/*
 * Encryption uses the API Key Vault's safeStorage codec (the same OS-derived
 * key, injectable so tests do not need Electron), but NOT the vault itself.
 *
 * WHY not store MCP secrets in the vault: the vault gates every read behind
 * Touch ID / the login password once per app run. MCP secrets are read at
 * agent LAUNCH, which includes automatic restore of a whole workspace at
 * startup — an OS prompt before any window is usable, or a restore that
 * silently drops every server until the user unlocks something, are both
 * worse than the dictation-key precedent (src/main/dictation/apiKeyStore.ts):
 * encrypted at rest with an OS-derived key, readable without a prompt.
 */

/**
 * One encrypted blob per secret at `<dir>/<serverId>/<inputId>.bin`.
 *
 * WHY one file per secret instead of one encrypted document: a blob that stops
 * decrypting (Keychain reset, copied profile) then costs exactly one secret —
 * shown as "not set" — instead of every server's credentials at once. Server
 * ids and input ids are both validated to `[A-Za-z0-9_-]`, so they are safe
 * path segments by construction.
 */
export class UserMcpSecretStore {
  constructor(
    private readonly dir: string,
    private readonly codec: SecretCodec,
  ) {}

  available(): boolean {
    try {
      return this.codec.isEncryptionAvailable()
    } catch {
      return false
    }
  }

  async get(serverId: string, inputId: string): Promise<string | null> {
    if (!this.available()) return null
    let ciphertext: Buffer
    try {
      ciphertext = await readFile(this.path(serverId, inputId))
    } catch {
      return null
    }
    try {
      const value = this.codec.decrypt(ciphertext)
      return value === '' ? null : value
    } catch {
      // Left in place on purpose: if the keyring comes back, so does the value.
      return null
    }
  }

  async set(serverId: string, inputId: string, value: string): Promise<void> {
    if (value === '') {
      await this.clear(serverId, inputId)
      return
    }
    if (!this.available()) {
      throw new Error('Secure storage is not available on this system, so the secret cannot be saved.')
    }
    const directory = join(this.dir, serverId)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const target = this.path(serverId, inputId)
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temporary, this.codec.encrypt(value), { mode: 0o600 })
    await rename(temporary, target)
  }

  async clear(serverId: string, inputId: string): Promise<void> {
    await rm(this.path(serverId, inputId), { force: true })
  }

  async clearServer(serverId: string): Promise<void> {
    await rm(join(this.dir, serverId), { recursive: true, force: true })
  }

  /** Drop blobs for inputs the server no longer defines, so a renamed or
   * removed secret does not linger as an orphaned credential on disk. */
  async prune(serverId: string, keepInputIds: readonly string[]): Promise<void> {
    let files: string[]
    try {
      files = await readdir(join(this.dir, serverId))
    } catch {
      return
    }
    const keep = new Set(keepInputIds.map(id => `${id}.bin`))
    await Promise.all(files.filter(file => !keep.has(file)).map(file =>
      rm(join(this.dir, serverId, file), { force: true })))
  }

  /** Presence and a last-4 hint only. The renderer never receives a value. */
  async state(serverId: string, inputIds: readonly string[]): Promise<Record<string, UserMcpSecretState>> {
    const entries = await Promise.all(inputIds.map(async id => {
      const value = await this.get(serverId, id)
      // No hint for short values: the last four characters of a six-character
      // PIN are most of the secret.
      const state: UserMcpSecretState = value === null
        ? { set: false }
        : { set: true, ...(value.length >= 12 ? { hint: value.slice(-4) } : {}) }
      return [id, state] as const
    }))
    return Object.fromEntries(entries)
  }

  private path(serverId: string, inputId: string): string {
    return join(this.dir, serverId, `${inputId}.bin`)
  }
}
