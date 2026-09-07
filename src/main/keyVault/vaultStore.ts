import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

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

  async function atomicWrite(
    path: string,
    data: string | Buffer,
    mode: 0o600 | undefined,
  ): Promise<void> {
    await mkdir(dirname(path), { recursive: true })
    const tmp = `${path}.tmp`
    await writeFile(tmp, data, mode !== undefined ? { mode } : undefined)
    if (mode !== undefined) await chmod(tmp, mode).catch(() => {})
    await rename(tmp, path)
    if (mode !== undefined) await chmod(path, mode).catch(() => {})
  }

  return {
    encryptionAvailable: () => codec.isEncryptionAvailable(),

    async loadIndex() {
      let raw: string
      try {
        raw = await readFile(indexFile, 'utf8')
      } catch {
        // Absent index = fresh vault. A CORRUPT index is treated the
        // same way below: the vault degrades to empty rather than
        // bricking startup. Secret blobs on disk become orphans, which
        // is the safe direction — the metadata loss already happened
        // when the index corrupted, and a hard failure here would make
        // the whole app unusable over data the user cannot recover
        // through this path anyway.
        return { providers: [], keys: [] }
      }
      try {
        const parsed = JSON.parse(raw) as IndexFile
        return { providers: parsed.providers ?? [], keys: parsed.keys ?? [] }
      } catch {
        return { providers: [], keys: [] }
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
      if (!codec.isEncryptionAvailable()) return null
      let cipher: Buffer
      try {
        cipher = await readFile(join(keysDir, `${keyId}.bin`))
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
      await atomicWrite(join(keysDir, `${keyId}.bin`), codec.encrypt(value), 0o600)
    },

    async deleteSecret(keyId) {
      await rm(join(keysDir, `${keyId}.bin`), { force: true })
    },
  }
}
