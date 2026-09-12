// Wire contract for the API Key Vault (issue #831).
//
// WHY a shared module: vault data crosses the preload bridge in both
// directions (renderer edits metadata, main returns snapshots), so the
// renderer must type its UI against something importable from both
// processes without dragging main-process storage code into the bundle.
// Mirrors the other @shared/types contracts.

/** A user-created provider bucket (e.g. "Brave", "OpenAI"). The vault
 *  starts empty by design (#831): no seed list of providers to go stale
 *  as services appear and disappear. */
export type KeyVaultProvider = {
  id: string
  name: string
  createdAt: number
  updatedAt: number
}

/** Non-secret metadata for one stored key. The secret value NEVER crosses
 *  this type: it lives in an encrypted per-key blob on disk and is only
 *  returned by the gated reveal/copy calls. `hint` is the last four
 *  characters of the value, captured at write time, so the vault UI can
 *  confirm identity without decrypting anything. */
export type KeyVaultKey = {
  id: string
  providerId: string
  name: string
  note: string
  hint: string
  createdAt: number
  updatedAt: number
}

export type KeyVaultSnapshot = {
  providers: KeyVaultProvider[]
  keys: KeyVaultKey[]
}

export type KeyVaultStatus = {
  /** Electron safeStorage reports the OS keyring usable. */
  encryptionAvailable: boolean
  /** macOS can present the Touch ID / login-password prompt. */
  authPromptAvailable: boolean
  /** The once-per-app-run unlock gate has been passed. */
  unlocked: boolean
}

export type KeyVaultKeyInput = {
  providerId: string
  /** Omit to create a new key; include to update an existing one. An
   *  empty `value` on update means "keep the existing secret" so users
   *  can rename/re-note without re-pasting the key. */
  id?: string
  name: string
  value: string
  note: string
}
