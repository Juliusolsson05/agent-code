import { safeStorage } from 'electron'

import type { SecretCodec } from '@main/keyVault/vaultStore.js'

// Production codec: thin adapter over Electron safeStorage, which derives
// its key from the OS Keychain (macOS) without prompting. Kept in its own
// module — separate from vaultStore.ts — purely so the store's unit tests
// never need the `electron` module, which only exists inside the packaged
// app. isEncryptionAvailable is consulted before every read so a Keychain
// that disappears mid-run reads as "unreadable key" instead of a crash.
export function createSafeStorageCodec(): SecretCodec {
  return {
    isEncryptionAvailable: () => {
      try {
        return safeStorage.isEncryptionAvailable()
      } catch {
        return false
      }
    },
    encrypt: plain => safeStorage.encryptString(plain),
    decrypt: cipher => safeStorage.decryptString(cipher),
  }
}
