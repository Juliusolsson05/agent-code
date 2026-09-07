import type {
  KeyVaultKey,
  KeyVaultKeyInput,
  KeyVaultProvider,
  KeyVaultSnapshot,
  KeyVaultStatus,
} from '@shared/types/keyVault'
import { newVaultId, type VaultStore } from '@main/keyVault/vaultStore.js'

// Vault orchestration (issue #831): CRUD over the store, the once-per-run
// unlock gate, and clipboard copies.
//
// WHY the gate lives here and not in the IPC layer: every secret-leaving
// path (reveal, copy, resolveReference) must pass through ONE gate. The
// gate is a plain boolean per app run — `promptAuth` is injected so unit
// tests never trigger a real OS dialog, and production wires it to
// systemPreferences.promptTouchID, which presents Touch ID with the
// login-password fallback (the "mac password" requirement). If the
// platform cannot prompt at all, we fail closed: no secret leaves main.
//
// WHY secrets never appear in the snapshot: the renderer list view is
// built entirely from non-secret metadata; plaintext crosses the bridge
// only as the return value of the gated reveal/copy calls and lives in
// ephemeral component state at most.

export type VaultServiceDeps = {
  store: VaultStore
  /** Presents the OS auth prompt. Rejects when the user cancels. */
  promptAuth: (reason: string) => Promise<void>
  /** Whether the OS can present the prompt at all. */
  canPromptAuth: () => boolean
  copyToClipboard: (text: string) => void
  /** Injectable clock for deterministic timestamps. */
  now?: () => number
}

export class VaultService {
  private unlocked = false

  constructor(private readonly deps: VaultServiceDeps) {}

  getStatus(): KeyVaultStatus {
    return {
      encryptionAvailable: this.deps.store.encryptionAvailable(),
      authPromptAvailable: this.deps.canPromptAuth(),
      unlocked: this.unlocked,
    }
  }

  lock(): void {
    this.unlocked = false
  }

  async unlock(): Promise<void> {
    await this.ensureUnlocked()
  }

  private async ensureUnlocked(): Promise<void> {
    if (this.unlocked) return
    if (!this.deps.store.encryptionAvailable()) {
      throw new Error('System keyring unavailable — the vault cannot read or store keys on this machine.')
    }
    if (!this.deps.canPromptAuth()) {
      throw new Error(
        'macOS authentication is unavailable — the vault stays locked. (Touch ID / login password prompt required.)',
      )
    }
    await this.deps.promptAuth('unlock the Agent Code API key vault')
    this.unlocked = true
  }

  async list(): Promise<KeyVaultSnapshot> {
    return this.deps.store.loadIndex()
  }

  async reveal(providerId: string, keyId: string): Promise<string> {
    await this.ensureUnlocked()
    const key = await this.findKey(providerId, keyId)
    const secret = await this.deps.store.readSecret(keyId)
    if (secret === null) {
      throw new Error(
        `Key "${key.name}" cannot be decrypted (Keychain reset or corrupted blob). Re-enter the value to fix it.`,
      )
    }
    return secret
  }

  async copyKey(providerId: string, keyId: string): Promise<void> {
    const value = await this.reveal(providerId, keyId)
    this.deps.copyToClipboard(value)
  }

  /** Resolve a `{{key:Provider/Key}}` template reference by NAME (#831).
   *  Names, not ids, so user-authored templates stay readable; renaming
   *  breaks references loudly rather than silently. */
  async resolveReference(providerName: string, keyName: string): Promise<string> {
    await this.ensureUnlocked()
    const snapshot = await this.deps.store.loadIndex()
    const provider = snapshot.providers.find(p => p.name === providerName)
    if (!provider) throw new Error(`Key vault provider "${providerName}" not found.`)
    const key = snapshot.keys.find(k => k.providerId === provider.id && k.name === keyName)
    if (!key) throw new Error(`Key "${keyName}" not found for provider "${providerName}".`)
    const secret = await this.deps.store.readSecret(key.id)
    if (secret === null) {
      throw new Error(
        `Key "${key.name}" cannot be decrypted (Keychain reset or corrupted blob). Re-enter the value to fix it.`,
      )
    }
    return secret
  }

  async createProvider(name: string): Promise<KeyVaultProvider> {
    const trimmed = name.trim()
    if (!trimmed) throw new Error('Provider name cannot be empty.')
    const snapshot = await this.deps.store.loadIndex()
    if (snapshot.providers.some(p => p.name.toLowerCase() === trimmed.toLowerCase())) {
      throw new Error(`Provider "${trimmed}" already exists.`)
    }
    const now = this.deps.now?.() ?? Date.now()
    const provider: KeyVaultProvider = { id: newVaultId(), name: trimmed, createdAt: now, updatedAt: now }
    snapshot.providers.push(provider)
    await this.deps.store.saveIndex(snapshot)
    return provider
  }

  async renameProvider(id: string, name: string): Promise<void> {
    const trimmed = name.trim()
    if (!trimmed) throw new Error('Provider name cannot be empty.')
    const snapshot = await this.deps.store.loadIndex()
    const provider = snapshot.providers.find(p => p.id === id)
    if (!provider) throw new Error('Provider not found.')
    if (snapshot.providers.some(p => p.id !== id && p.name.toLowerCase() === trimmed.toLowerCase())) {
      throw new Error(`Provider "${trimmed}" already exists.`)
    }
    provider.name = trimmed
    provider.updatedAt = this.deps.now?.() ?? Date.now()
    await this.deps.store.saveIndex(snapshot)
  }

  async deleteProvider(id: string): Promise<void> {
    const snapshot = await this.deps.store.loadIndex()
    if (!snapshot.providers.some(p => p.id === id)) throw new Error('Provider not found.')
    // Index-first ordering: a crash mid-delete leaves an orphan blob
    // (harmless, invisible) rather than an index entry whose secret is
    // already gone (reads as corrupt).
    await this.deps.store.saveIndex({
      providers: snapshot.providers.filter(p => p.id !== id),
      keys: snapshot.keys.filter(k => k.providerId !== id),
    })
    for (const key of snapshot.keys) {
      if (key.providerId === id) await this.deps.store.deleteSecret(key.id)
    }
  }

  async putKey(input: KeyVaultKeyInput): Promise<KeyVaultKey> {
    const name = input.name.trim()
    if (!name) throw new Error('Key name cannot be empty.')
    const snapshot = await this.deps.store.loadIndex()
    if (!snapshot.providers.some(p => p.id === input.providerId)) {
      throw new Error('Provider not found.')
    }
    const now = this.deps.now?.() ?? Date.now()
    const existing = input.id ? snapshot.keys.find(k => k.id === input.id) : undefined
    if (input.id && !existing) throw new Error('Key not found.')
    if (
      snapshot.keys.some(
        k => k.id !== existing?.id && k.providerId === input.providerId && k.name === name,
      )
    ) {
      throw new Error(`Key "${name}" already exists for this provider.`)
    }

    const value = input.value.trim()
    if (existing) {
      let hint = existing.hint
      if (value.length > 0) {
        // Secret-first ordering on update: write the new blob BEFORE the
        // index references it, so a crash never produces an index entry
        // with a missing/stale blob.
        await this.deps.store.writeSecret(existing.id, value)
        hint = value.slice(-4)
      } else if ((await this.deps.store.readSecret(existing.id)) === null) {
        // Editing metadata cannot resurrect an unreadable secret; the
        // user must re-enter the value. Surface that now, not at reveal.
        throw new Error(`Key "${existing.name}" has no readable stored value — re-enter the value.`)
      }
      existing.name = name
      existing.note = input.note.trim()
      existing.hint = hint
      existing.updatedAt = now
      await this.deps.store.saveIndex(snapshot)
      return existing
    }

    if (!value) throw new Error('Key value cannot be empty.')
    const key: KeyVaultKey = {
      id: newVaultId(),
      providerId: input.providerId,
      name,
      note: input.note.trim(),
      hint: value.slice(-4),
      createdAt: now,
      updatedAt: now,
    }
    await this.deps.store.writeSecret(key.id, value)
    snapshot.keys.push(key)
    await this.deps.store.saveIndex(snapshot)
    return key
  }

  async deleteKey(providerId: string, keyId: string): Promise<void> {
    const snapshot = await this.deps.store.loadIndex()
    const key = snapshot.keys.find(k => k.id === keyId && k.providerId === providerId)
    if (!key) throw new Error('Key not found.')
    await this.deps.store.saveIndex({
      providers: snapshot.providers,
      keys: snapshot.keys.filter(k => k.id !== keyId),
    })
    await this.deps.store.deleteSecret(keyId)
  }

  private async findKey(providerId: string, keyId: string): Promise<KeyVaultKey> {
    const snapshot = await this.deps.store.loadIndex()
    const key = snapshot.keys.find(k => k.id === keyId && k.providerId === providerId)
    if (!key) throw new Error('Key not found.')
    return key
  }
}
