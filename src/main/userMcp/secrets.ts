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
/**
 * Every record is BOUND to the destination it was saved for (#1304, q113).
 *
 * The plaintext that gets encrypted is `BOUND_PREFIX + JSON({ d, v })`: `d` is
 * the server's destination identity (`userMcpDestination` of its entry) at the
 * moment the secret was saved, `v` the secret. A read supplies the server's
 * CURRENT destination and gets the value only if `d` matches; anything else
 * reads as "not set", so launch refuses to attach the server.
 *
 * WHY at read time and not by write order: a destination change is several
 * writes (the document, then each blob), and a crash or a failed rollback or
 * restore can stop between any two. Two reviews found such a window in each
 * direction: the NEW address with the OLD token, then the OLD address with
 * the NEW token. Any ordering leaves one open. A binding check at every read
 * holds whatever state is left on disk: a token only ever reaches the
 * destination it was entered for.
 *
 * Records written before binding existed (plain value, no prefix) are NEVER
 * bound automatically (q114). An old version could have crashed between
 * publishing a new destination and clearing the old token, leaving document B
 * next to a token entered for A; binding legacy records to "the destination
 * the document names" would stamp that token as B's and launch it. So an
 * unbound record is kept on disk (never deleted) but reads as not set, and
 * Settings asks the user to confirm it for the current destination
 * (`confirmUnbound`) or re-enter it. That user action is the proof that binds
 * it. Upgrading users pay a one-time confirmation per stored secret.
 */
const BOUND_PREFIX = 'agent-code/user-mcp-secret/v1:'

function bindValue(destination: string, value: string): string {
  return BOUND_PREFIX + JSON.stringify({ d: destination, v: value })
}

function unbindValue(plaintext: string): { destination: string; value: string } | null {
  if (!plaintext.startsWith(BOUND_PREFIX)) return null
  try {
    const record = JSON.parse(plaintext.slice(BOUND_PREFIX.length)) as { d?: unknown; v?: unknown }
    return typeof record.d === 'string' && typeof record.v === 'string' ? { destination: record.d, value: record.v } : null
  } catch {
    return null
  }
}

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

  /** The secret, only if it was saved for `destination` (see BOUND_PREFIX). */
  async get(serverId: string, inputId: string, destination: string): Promise<string | null> {
    const plaintext = await this.decrypted(serverId, inputId)
    if (plaintext === null) return null
    const record = unbindValue(plaintext)
    if (!record || record.destination !== destination || record.value === '') return null
    return record.value
  }

  /** True when a record exists but was written before destination binding
   *  (q114): it cannot prove its destination, so it is withheld. */
  async isUnbound(serverId: string, inputId: string): Promise<boolean> {
    const plaintext = await this.decrypted(serverId, inputId)
    return plaintext !== null && plaintext !== '' && unbindValue(plaintext) === null
  }

  /** Last four characters of an unbound record, so the user can recognise
   *  what they are confirming (the same hint rule as a set secret). */
  async unboundHint(serverId: string, inputId: string): Promise<string | undefined> {
    const plaintext = await this.decrypted(serverId, inputId)
    if (plaintext === null || unbindValue(plaintext) !== null || plaintext.length < 12) return undefined
    return plaintext.slice(-4)
  }

  /**
   * Bind an unbound (pre-binding) record to `destination` because the USER
   * confirmed it is for that destination (q114). Nothing else may bind a
   * legacy record: an old record carries no proof of its destination, and
   * the document it sits next to may be exactly the inconsistent state this
   * binding exists to refuse. Returns false when there is no unbound record.
   */
  async confirmUnbound(serverId: string, inputId: string, destination: string): Promise<boolean> {
    const plaintext = await this.decrypted(serverId, inputId)
    if (plaintext === null || plaintext === '' || unbindValue(plaintext) !== null) return false
    await this.write(serverId, inputId, bindValue(destination, plaintext))
    return true
  }

  private async decrypted(serverId: string, inputId: string): Promise<string | null> {
    if (!this.available()) return null
    let ciphertext: Buffer
    try {
      ciphertext = await readFile(this.path(serverId, inputId))
    } catch {
      return null
    }
    try {
      return this.codec.decrypt(ciphertext)
    } catch {
      // Left in place on purpose: if the keyring comes back, so does the value.
      return null
    }
  }

  /** Save `value` bound to `destination`, the destination it is for. */
  async set(serverId: string, inputId: string, value: string, destination: string): Promise<void> {
    if (value === '') {
      await this.clear(serverId, inputId)
      return
    }
    await this.write(serverId, inputId, bindValue(destination, value))
  }

  private async write(serverId: string, inputId: string, plaintext: string): Promise<void> {
    if (!this.available()) {
      throw new Error('Secure storage is not available on this system, so the secret cannot be saved.')
    }
    const directory = join(this.dir, serverId)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const target = this.path(serverId, inputId)
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temporary, this.codec.encrypt(plaintext), { mode: 0o600 })
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

  /**
   * The server's encrypted blobs as raw bytes, for a mutation to put back if
   * its secret step fails midway (#1304, q108). Ciphertext only: nothing is
   * decrypted, so this works even when secure storage is unavailable.
   */
  async snapshotServer(serverId: string): Promise<Map<string, Buffer>> {
    const snapshot = new Map<string, Buffer>()
    let files: string[]
    try {
      files = await readdir(join(this.dir, serverId))
    } catch (error) {
      // Only a missing directory means "no secrets" (q110, review a): an
      // EACCES/EIO/EMFILE here returned an empty snapshot, so a failed step
      // then "restored" nothing and the server lost its token for good.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return snapshot
      throw error
    }
    for (const file of files) {
      if (!file.endsWith('.bin')) continue
      snapshot.set(file, await readFile(join(this.dir, serverId, file)))
    }
    return snapshot
  }

  /** Make the server's blobs exactly `snapshot` again (see snapshotServer). */
  async restoreServer(serverId: string, snapshot: ReadonlyMap<string, Buffer>): Promise<void> {
    const directory = join(this.dir, serverId)
    await rm(directory, { recursive: true, force: true })
    if (snapshot.size === 0) return
    await mkdir(directory, { recursive: true, mode: 0o700 })
    for (const [file, ciphertext] of snapshot) {
      await writeFile(join(directory, file), ciphertext, { mode: 0o600 })
    }
  }

  /** Presence and a last-4 hint only. The renderer never receives a value. */
  async state(serverId: string, inputIds: readonly string[], destination: string): Promise<Record<string, UserMcpSecretState>> {
    const entries = await Promise.all(inputIds.map(async id => {
      const value = await this.get(serverId, id, destination)
      // No hint for short values: the last four characters of a six-character
      // PIN are most of the secret.
      let state: UserMcpSecretState
      if (value !== null) {
        state = { set: true, ...(value.length >= 12 ? { hint: value.slice(-4) } : {}) }
      } else if (await this.isUnbound(serverId, id)) {
        // Saved by an earlier version: kept, withheld, and shown so the user
        // can confirm or re-enter it (q114).
        const hint = await this.unboundHint(serverId, id)
        state = { set: false, unconfirmed: true, ...(hint ? { hint } : {}) }
      } else {
        state = { set: false }
      }
      return [id, state] as const
    }))
    return Object.fromEntries(entries)
  }

  private path(serverId: string, inputId: string): string {
    return join(this.dir, serverId, `${inputId}.bin`)
  }
}
