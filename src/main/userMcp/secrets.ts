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
 * (`confirm`) or re-enter it. That user action is the proof that binds
 * it. Upgrading users pay a one-time confirmation per stored secret.
 */
const BOUND_PREFIX = 'agent-code/user-mcp-secret/v1:'

/**
 * What a record is bound to (B6 R3 at 4d5c79ab). `destination` alone was not
 * enough: the entry text can stay identical while the VALUE of another input
 * moves the request (`API_BASE_URL=${input:svc-API_BASE_URL}`, or the host in
 * `https://${input:host}/mcp?key=${input:tok}`), and an agent can set such a
 * value with mcp_servers_set_secret. So a record also carries `inputs`, a
 * digest of the values of the entry's STEERING inputs other than itself
 * (service.ts bindingFor). A record's own value is never in its digest, so a
 * rotated token stays bound.
 */
export type SecretBinding = { destination: string; inputs: string }

function bindValue(binding: SecretBinding, value: string): string {
  return BOUND_PREFIX + JSON.stringify({ d: binding.destination, x: binding.inputs, v: value })
}

type SecretRecord =
  | { kind: 'unbound'; value: string }
  // `inputs` is absent on records written before B6 R3 (never merged, so only
  // dev data); it then matches nothing and the record needs confirmation.
  | { kind: 'bound'; destination: string; inputs: string | undefined; value: string }

function parseRecord(plaintext: string): SecretRecord | null {
  if (plaintext === '') return null
  if (!plaintext.startsWith(BOUND_PREFIX)) return { kind: 'unbound', value: plaintext }
  try {
    const record = JSON.parse(plaintext.slice(BOUND_PREFIX.length)) as { d?: unknown; x?: unknown; v?: unknown }
    if (typeof record.d !== 'string' || typeof record.v !== 'string') return null
    return { kind: 'bound', destination: record.d, inputs: typeof record.x === 'string' ? record.x : undefined, value: record.v }
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

  private async record(serverId: string, inputId: string): Promise<SecretRecord | null> {
    const plaintext = await this.decrypted(serverId, inputId)
    return plaintext === null ? null : parseRecord(plaintext)
  }

  /** The secret, only if it was saved for exactly `binding` (see BOUND_PREFIX). */
  async get(serverId: string, inputId: string, binding: SecretBinding): Promise<string | null> {
    const record = await this.record(serverId, inputId)
    if (record?.kind !== 'bound' || record.value === '') return null
    return record.destination === binding.destination && record.inputs === binding.inputs ? record.value : null
  }

  /**
   * The stored value whatever it is bound to, ONLY for computing other
   * records' bindings (service.ts bindingFor): the digest has to see the value
   * the next launch would substitute. Never handed to a launch.
   */
  async storedValue(serverId: string, inputId: string): Promise<string | null> {
    const record = await this.record(serverId, inputId)
    return record ? record.value : null
  }

  /**
   * Bind a withheld record to `binding` because the USER confirmed it
   * (q114, B6 R3). Two cases only:
   *   - an unbound record from an earlier version: it carries no proof of its
   *     destination, and the user's confirmation is that proof;
   *   - a record for the SAME destination whose steering inputs changed (a new
   *     base URL): the user confirms the token may go there.
   * A record bound to a DIFFERENT destination is never confirmable: that is
   * the q113 crash window (a token next to a document it was not saved for),
   * and only re-entering it may bind it. Returns false when there is nothing
   * to confirm, leaving the bytes untouched.
   */
  async confirm(serverId: string, inputId: string, binding: SecretBinding): Promise<boolean> {
    const record = await this.record(serverId, inputId)
    if (!record || record.value === '') return false
    if (record.kind === 'bound' && (record.destination !== binding.destination || record.inputs === binding.inputs)) return false
    await this.write(serverId, inputId, bindValue(binding, record.value))
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

  /** Save `value` bound to `binding`, what it is for. */
  async set(serverId: string, inputId: string, value: string, binding: SecretBinding): Promise<void> {
    if (value === '') {
      await this.clear(serverId, inputId)
      return
    }
    await this.write(serverId, inputId, bindValue(binding, value))
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

  /**
   * Presence and a last-4 hint only; the renderer never receives a value.
   * `unconfirmed` marks a record that is kept but withheld and that the user
   * can confirm (see confirm): `legacy` from an earlier version, or
   * `inputs-changed` when a steering input's value moved since it was bound.
   * A record bound to another destination shows as plainly not set, because
   * only re-entering it may bind it.
   */
  async state(serverId: string, bindings: Readonly<Record<string, SecretBinding>>): Promise<Record<string, UserMcpSecretState>> {
    const entries = await Promise.all(Object.entries(bindings).map(async ([id, binding]) => {
      const record = await this.record(serverId, id)
      // No hint for short values: the last four characters of a six-character
      // PIN are most of the secret.
      const hint = record && record.value.length >= 12 ? { hint: record.value.slice(-4) } : {}
      let state: UserMcpSecretState
      if (!record || record.value === '') {
        state = { set: false }
      } else if (record.kind === 'unbound') {
        state = { set: false, unconfirmed: 'legacy', ...hint }
      } else if (record.destination !== binding.destination) {
        state = { set: false }
      } else if (record.inputs !== binding.inputs) {
        state = { set: false, unconfirmed: 'inputs-changed', ...hint }
      } else {
        state = { set: true, ...hint }
      }
      return [id, state] as const
    }))
    return Object.fromEntries(entries)
  }

  private path(serverId: string, inputId: string): string {
    return join(this.dir, serverId, `${inputId}.bin`)
  }
}
