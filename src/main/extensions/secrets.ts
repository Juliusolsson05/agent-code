import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { EXTENSION_SECRETS_DIR } from '@main/storage/paths.js'
import type { SecretCodec } from '@main/keyVault/vaultStore.js'
import { isValidExtensionId } from '@shared/types/extensionId.js'
import { MAX_SECRET_VALUE_LENGTH, SECRET_KEY_PATTERN } from '@shared/types/extensionServices.js'

// api.secrets (#1150): per-extension credentials encrypted with Electron
// safeStorage (OS keychain on macOS, DPAPI on Windows, libsecret/kwallet on
// Linux) — the same SecretCodec the Key Vault uses, injected so tests never
// need the `electron` module.
//
// ── WHY TIER 0 (no permission) ──
// The namespace is the extension id that the authenticated transport fixed
// (frame origin / runtime WebContents), never a request field. An extension can
// therefore read only what it stored itself — which it already had in hand.
// A consent prompt would protect nothing and teach users to click through the
// one dialog that must not become routine. VS Code's SecretStorage made the
// same call.
//
// ── WHY NOT api.storage ──
// storage is plaintext JSON in ~/.config, retained on uninstall, and readable
// by any backup or sync tool. A credential needs encryption at rest and must
// NOT survive uninstall: a later install with the same id from another source
// would otherwise inherit someone's API key.
//
// ── INVARIANTS ──
// - Never plaintext: when the OS cannot encrypt, set() refuses.
// - Values never appear in errors or logs. Every message here is fixed copy.
// - One blob per key, so one undecryptable blob (keychain reset) costs one key.
// - File names are the HEX of the key. The key grammar allows "." and "..",
//   which would be path traversal as file names, and macOS volumes are case-
//   insensitive, so "Token" and "token" would silently share one file.

export const MAX_SECRET_KEYS_PER_EXTENSION = 32
// The key grammar and value cap are the transport schema's own exports, and
// the id check is the shared isValidExtensionId: this store re-enforces them
// at the filesystem edge but must never disagree with what the schema admits.

export type ExtensionSecretStore = {
  get(extensionId: string, key: string): Promise<string | null>
  set(extensionId: string, key: string, value: string): Promise<void>
  delete(extensionId: string, key: string): Promise<void>
}

function directoryFor(root: string, extensionId: string): string {
  // Same rule as storage.ts/manifest.ts: the id becomes a directory name, so it
  // is validated, never sanitized. The transport already fixed it; this is the
  // second line before a recursive filesystem operation.
  if (!isValidExtensionId(extensionId)) throw new Error('Invalid extension id.')
  return join(root, extensionId)
}

function fileFor(root: string, extensionId: string, key: string): string {
  if (typeof key !== 'string' || !SECRET_KEY_PATTERN.test(key)) throw new Error('Secret keys are 1-64 characters of [a-zA-Z0-9._-].')
  return join(directoryFor(root, extensionId), `${Buffer.from(key, 'utf8').toString('hex')}.bin`)
}

export function createExtensionSecretStore(codec: SecretCodec, root: string = EXTENSION_SECRETS_DIR): ExtensionSecretStore {
  // Mutations serialize per extension so the key-count limit cannot be raced
  // past by 32 concurrent set() calls that each counted 31 existing files.
  const queues = new Map<string, Promise<unknown>>()
  const serialize = <T>(extensionId: string, work: () => Promise<T>): Promise<T> => {
    const next = (queues.get(extensionId) ?? Promise.resolve()).catch(() => {}).then(work)
    queues.set(extensionId, next)
    const forget = () => { if (queues.get(extensionId) === next) queues.delete(extensionId) }
    void next.then(forget, forget)
    return next
  }

  return {
    async get(extensionId, key) {
      const path = fileFor(root, extensionId, key)
      if (!codec.isEncryptionAvailable()) return null
      let cipher: Buffer
      try { cipher = await readFile(path) } catch { return null }
      try {
        const plain = codec.decrypt(cipher)
        return plain.length > 0 ? plain : null
      } catch {
        // Keychain reset / different machine: unreadable reads as absent. The
        // blob stays for a possible keychain recovery; set() overwrites it.
        return null
      }
    },

    async set(extensionId, key, value) {
      const path = fileFor(root, extensionId, key)
      if (typeof value !== 'string' || value.length < 1 || value.length > MAX_SECRET_VALUE_LENGTH) {
        throw new Error(`Secret values must be 1-${MAX_SECRET_VALUE_LENGTH} characters.`)
      }
      if (!codec.isEncryptionAvailable()) {
        throw new Error('Secure storage is unavailable on this system; the secret was not stored.')
      }
      await serialize(extensionId, async () => {
        const directory = directoryFor(root, extensionId)
        await mkdir(directory, { recursive: true, mode: 0o700 })
        const existing = (await readdir(directory)).filter(name => name.endsWith('.bin'))
        const name = path.slice(directory.length + 1)
        if (!existing.includes(name) && existing.length >= MAX_SECRET_KEYS_PER_EXTENSION) {
          throw new Error(`An extension can store at most ${MAX_SECRET_KEYS_PER_EXTENSION} secrets.`)
        }
        let cipher: Buffer
        try { cipher = codec.encrypt(value) } catch {
          // safeStorage error text is platform copy; replace it with ours so no
          // path through here can ever surface something derived from `value`.
          throw new Error('Secure storage could not encrypt the secret; it was not stored.')
        }
        // Exclusive temp + rename, 0o600 — same discipline as the Key Vault.
        const temporary = `${path}.${randomUUID()}.tmp`
        try {
          await writeFile(temporary, cipher, { mode: 0o600, flag: 'wx' })
          await chmod(temporary, 0o600)
          await rename(temporary, path)
        } finally {
          await rm(temporary, { force: true })
        }
      })
    },

    async delete(extensionId, key) {
      const path = fileFor(root, extensionId, key)
      await serialize(extensionId, () => rm(path, { force: true }))
    },
  }
}

/** Uninstall cleanup. A standalone function (no codec needed to delete) so the
 *  IPC remove handler can call it without owning the store instance. */
export async function removeExtensionSecrets(extensionId: string, root: string = EXTENSION_SECRETS_DIR): Promise<void> {
  await rm(directoryFor(root, extensionId), { recursive: true, force: true })
}
