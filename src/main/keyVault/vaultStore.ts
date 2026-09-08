import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'

import { STATE_DIR } from '@main/storage/paths.js'
import type { KeyVaultSnapshot } from '@shared/types/keyVault'

// Vault persistence: one plaintext index + one encrypted blob per key
// secret (issue #831).
//
// WHY per-key blobs instead of one encrypted vault document: the same
// reasoning as src/main/dictation/apiKeyStore.ts — a malformed cipher
// blob (safeStorage refusing to decrypt after a macOS Keychain reset)
// must cost exactly one key, never the whole vault. The index carries
// only non-secret metadata (names, notes, timestamps, last-4 hints), so
// the provider list renders without touching decryption at all.
//
// WHY the codec is injected: unit tests run outside the packaged app
// where the `electron` module (and therefore safeStorage) does not
// exist. The store's own responsibilities are file discipline; the real
// codec is wired in src/main/index.ts.
//
// Write discipline mirrors apiKeyStore / remote/auth/secret.ts: mkdir
// recursive, temp file + atomic rename, 0o600 on secret blobs, and a
// decrypt failure reads back as null instead of throwing so callers can
// degrade per key.

export type SecretCodec = {
  isEncryptionAvailable(): boolean
  encrypt(plain: string): Buffer
  decrypt(cipher: Buffer): string
}

export function newVaultId(): string {
  return randomUUID()
}

type IndexFile = KeyVaultSnapshot & { version: 1 }

const identifier = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/)
const providerSchema = z.object({
  id: identifier, name: z.string().min(1).max(200),
  createdAt: z.number().finite(), updatedAt: z.number().finite(),
}).strict()
const indexSchema = z.object({
  version: z.literal(1),
  providers: z.array(providerSchema).max(1000),
  keys: z.array(providerSchema.extend({
    providerId: identifier, note: z.string().max(4000), hint: z.string().max(4),
  }).strict()).max(10000),
}).strict()

export type VaultStore = {
  encryptionAvailable(): boolean
  loadIndex(): Promise<KeyVaultSnapshot>
  saveIndex(snapshot: KeyVaultSnapshot): Promise<void>
  readSecret(keyId: string): Promise<string | null>
  writeSecret(keyId: string, value: string): Promise<void>
  deleteSecret(keyId: string): Promise<void>
}

export function createFileVaultStore(
  rootDir: string = join(STATE_DIR, 'key-vault'),
  codec: SecretCodec,
): VaultStore {
  const indexFile = join(rootDir, 'index.json')
  const keysDir = join(rootDir, 'keys')

  function secretPath(keyId: string): string {
    if (!identifier.safeParse(keyId).success) throw new Error('Invalid vault key id.')
    return join(keysDir, `${keyId}.bin`)
  }

  async function atomicWrite(
    path: string,
    data: string | Buffer,
    mode: 0o600 | undefined,
  ): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    // Unique across store instances too; exclusive creation avoids following
    // an existing temporary symlink. Never publish a permissions failure.
    const tmp = `${path}.${randomUUID()}.tmp`
    try {
      await writeFile(tmp, data, { mode: mode ?? 0o600, flag: 'wx' })
      await chmod(tmp, mode ?? 0o600)
      await rename(tmp, path)
    } finally {
      await rm(tmp, { force: true })
    }
  }

  return {
    encryptionAvailable: () => codec.isEncryptionAvailable(),

    async loadIndex() {
      let raw: string
      try {
        raw = await readFile(indexFile, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { providers: [], keys: [] }
        throw new Error('Vault index cannot be read; the existing vault has not been changed.')
      }
      try {
        const parsed = indexSchema.parse(JSON.parse(raw))
        const providers = new Set(parsed.providers.map(p => p.id))
        if (providers.size !== parsed.providers.length ||
            new Set(parsed.keys.map(k => k.id)).size !== parsed.keys.length ||
            parsed.keys.some(k => !providers.has(k.providerId))) throw new Error('Invalid references')
        return { providers: parsed.providers, keys: parsed.keys }
      } catch {
        // Returning an empty index here would let the next CRUD operation
        // overwrite recoverable data. Only the vault UI fails, not app boot.
        throw new Error('Vault index is damaged or unsupported; it has not been changed.')
      }
    },

    async saveIndex(snapshot) {
      const file: IndexFile = {
        version: 1,
        providers: snapshot.providers,
        keys: snapshot.keys,
      }
      // Index is non-secret metadata; 0o600 is harmless belt-and-braces.
      await atomicWrite(indexFile, `${JSON.stringify(file, null, 2)}\n`, 0o600)
    },

    async readSecret(keyId) {
      const path = secretPath(keyId)
      if (!codec.isEncryptionAvailable()) return null
      let cipher: Buffer
      try {
        cipher = await readFile(path)
      } catch {
        return null
      }
      try {
        const plain = codec.decrypt(cipher)
        return plain.length > 0 ? plain : null
      } catch {
        // Decrypt failure after a Keychain reset: report unreadable,
        // leave the blob in place (matches apiKeyStore's reasoning that
        // future safeStorage recovery should stay possible).
        return null
      }
    },

    async writeSecret(keyId, value) {
      const path = secretPath(keyId)
      if (!codec.isEncryptionAvailable()) throw new Error('System keyring unavailable; cannot store a key.')
      await atomicWrite(path, codec.encrypt(value), 0o600)
    },

    async deleteSecret(keyId) {
      await rm(secretPath(keyId), { force: true })
    },
  }
}
