import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { STATE_DIR } from '@main/storage/paths.js'

// Per-install HMAC secret for the remote mobile companion.
//
// Every paired device's token is HMAC-signed with this secret (see
// DevicePairing.ts). The secret never leaves this machine: phones hold only
// their signed tokens, so verifying a token requires nothing but this file
// and the device registry — no accounts, no cloud.
//
// WHY a file under STATE_DIR and not Electron safeStorage/keychain: the
// secret must be readable by the main process at startup without user
// interaction (a keychain prompt on every boot would train users to
// click-through), and STATE_DIR is already the app's canonical local-state
// root with a documented purge story. 0o600 + 0o700 parent dir gives the
// same protection the workspace state itself gets; an attacker who can read
// this file can already read every transcript on disk.

export const REMOTE_SECRET_BYTES = 32

/** Default directory for remote-companion state (secret, devices.json). */
export const REMOTE_STATE_DIR = join(STATE_DIR, 'remote')

/**
 * Load the per-install secret, creating it on first use.
 *
 * A corrupt/short file is REGENERATED rather than treated as fatal: the
 * failure mode of regeneration is "every paired phone must re-pair" (tokens
 * signed by the old secret stop verifying), which is annoying but safe —
 * strictly better than refusing to start the remote subsystem, and far
 * better than trusting a truncated secret with less entropy than we minted.
 */
export async function loadOrCreateRemoteSecret(
  dir: string = REMOTE_STATE_DIR,
): Promise<Buffer> {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const file = join(dir, 'secret')

  try {
    const raw = (await readFile(file, 'utf8')).trim()
    const parsed = Buffer.from(raw, 'hex')
    // Buffer.from(_, 'hex') silently stops at the first non-hex character,
    // so a garbage file yields a short buffer — the length check catches
    // both truncation and non-hex corruption in one condition.
    if (parsed.length === REMOTE_SECRET_BYTES) return parsed
  } catch {
    // ENOENT on first run, or unreadable file — fall through to mint.
  }

  const secret = randomBytes(REMOTE_SECRET_BYTES)
  await writeFile(file, secret.toString('hex') + '\n', { mode: 0o600 })
  // writeFile's mode only applies on CREATE; if we're overwriting a corrupt
  // file that somehow had wider permissions, tighten it explicitly.
  await chmod(file, 0o600)
  return secret
}
