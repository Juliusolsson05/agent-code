import { safeStorage } from 'electron'
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { STATE_DIR } from '@main/storage/paths.js'

// Encrypted-at-rest Deepgram API key for voice dictation.
//
// WHY safeStorage instead of the plain STATE_DIR JSON we use elsewhere:
//
//   Every other setting Agent Code stores is either non-sensitive (theme,
//   layout, feature toggles) or is already local-only ephemeral state
//   (tmux ids, session runtime). A Deepgram API key is different: it is
//   a rotating third-party credential whose leakage costs the user real
//   money. Electron's safeStorage encrypts payloads with a key derived
//   from the OS Keychain (macOS) / DPAPI (Windows) / GNOME Keyring +
//   kwallet (Linux) without ever prompting the user, so we get "not
//   plaintext on disk if the machine is off / a debug bundle gets shared"
//   for free. The wrapping IS device-scoped: an encrypted blob copied
//   from one machine to another cannot be decrypted, and losing macOS
//   Keychain access (recovery-mode wipe, keychain reset) invalidates the
//   blob — both are acceptable trade-offs; the failure mode of asking
//   the user to paste the key again is much cheaper than any of the
//   alternatives (system Keychain popups on every read, storing in
//   plaintext, requiring env vars).
//
// WHY a separate file rather than folding the ciphertext into setup.json
// or workspace.json:
//
//   Both of those JSON files are read + rewritten by many code paths, and
//   a malformed cipher blob (safeStorage refusing to decrypt after a
//   Keychain reset) must not brick the entire settings pipeline. Keeping
//   the encrypted blob in its own file lets a decrypt failure clear that
//   file and continue with an empty key, without touching any other
//   persisted state.
//
// WHY .env stays as an override (see readDeepgramApiKeyForRuntime):
//
//   Developers rely on `.env` for iteration. We honour it first so an
//   engineer switching between real and fixture keys never has to click
//   through the settings UI, but the packaged-user path is settings-only.
//
// Failure discipline mirrors src/main/remote/auth/secret.ts: mkdir
// recursively, atomic rename via a temp file, 0o600 mode on write.

const DICTATION_STATE_DIR = join(STATE_DIR, 'dictation')
const API_KEY_FILE = join(DICTATION_STATE_DIR, 'deepgram-api-key.bin')

/** Backing store state. `available` reports whether the OS reported the
 *  key as encryptable; `configured` reports whether we have a persisted
 *  key at all; `source` distinguishes 'settings' (safeStorage-backed)
 *  from 'env' (dev override). */
export type DeepgramApiKeyStatus = {
  available: boolean
  configured: boolean
  source: 'settings' | 'env' | null
  /** Present when `configured === true`. The last four characters of the
   *  stored key (or 'unknown' if we can't decrypt). Never the full key —
   *  the renderer settings row only needs enough to confirm identity. */
  hint: string | null
}

/** Whether Electron's safeStorage reports the OS keyring as usable. Used
 *  by the settings UI to explain why the input might be disabled. */
export function isSafeStorageAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

/** Read the persisted API key, or null if none exists / decrypt fails.
 *  Never throws — a corrupted blob returns null and is left in place so
 *  future safeStorage recovery could succeed. */
async function readPersistedKey(): Promise<string | null> {
  if (!isSafeStorageAvailable()) return null
  let ciphertext: Buffer
  try {
    ciphertext = await readFile(API_KEY_FILE)
  } catch {
    return null
  }
  try {
    const plaintext = safeStorage.decryptString(ciphertext)
    return plaintext.trim() || null
  } catch {
    return null
  }
}

/** Read the effective Deepgram API key for outbound Deepgram calls,
 *  honouring the dev override before persisted storage. */
export async function readDeepgramApiKeyForRuntime(): Promise<string | null> {
  const envValue = process.env.DEEPGRAM_API_KEY?.trim()
  if (envValue) return envValue
  return readPersistedKey()
}

/** UI-facing status snapshot. Never returns the raw key. */
export async function getDeepgramApiKeyStatus(): Promise<DeepgramApiKeyStatus> {
  const available = isSafeStorageAvailable()
  const envValue = process.env.DEEPGRAM_API_KEY?.trim()
  if (envValue) {
    return {
      available,
      configured: true,
      source: 'env',
      hint: envValue.slice(-4) || null,
    }
  }
  const persisted = await readPersistedKey()
  if (!persisted) {
    return { available, configured: false, source: null, hint: null }
  }
  return {
    available,
    configured: true,
    source: 'settings',
    hint: persisted.slice(-4) || null,
  }
}

/** Persist the given key with safeStorage. Empty string clears the file
 *  (matches the settings row "Remove" action). Returns the fresh status
 *  so the renderer can update its view in one round-trip. */
export async function setDeepgramApiKey(rawKey: string): Promise<DeepgramApiKeyStatus> {
  const trimmed = rawKey.trim()
  if (!trimmed) {
    await unlink(API_KEY_FILE).catch(() => {})
    return getDeepgramApiKeyStatus()
  }
  if (!isSafeStorageAvailable()) {
    throw new Error(
      'System keyring is unavailable — cannot store a Deepgram API key securely on this machine.',
    )
  }
  await mkdir(dirname(API_KEY_FILE), { recursive: true })
  const ciphertext = safeStorage.encryptString(trimmed)
  const tmp = `${API_KEY_FILE}.tmp`
  await writeFile(tmp, ciphertext, { mode: 0o600 })
  await chmod(tmp, 0o600).catch(() => {})
  await rename(tmp, API_KEY_FILE)
  await chmod(API_KEY_FILE, 0o600).catch(() => {})
  return getDeepgramApiKeyStatus()
}
