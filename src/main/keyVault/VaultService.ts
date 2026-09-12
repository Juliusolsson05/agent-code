import { EventEmitter } from 'node:events'
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
// only as the return value of gated calls. Inserting it deliberately leaves
// vault protection: ordinary composer drafts and transcripts can persist it.

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

/** WHY a hint policy function: slice(-4) on a 1-4 character value stores
 *  the ENTIRE secret in the plaintext metadata index (review finding).
 *  Short values get no hint at all; the identity convenience of a hint is
 *  not worth leaking the whole key through the ungated list(). */
function hintFor(value: string): string {
  return value.length >= 5 ? value.slice(-4) : ''
}

function validateName(name: string): string {
  const trimmed = name.trim()
  // These delimiters belong to {{key:Provider/Key}}, not provider/key names.
  // Rejecting them on creation keeps every saved key referenceable.
  if (!trimmed || trimmed.length > 200 || /[\/{}\x00-\x1f\x7f]/.test(trimmed)) {
    throw new Error('Use a name of 1-200 characters without /, braces or control characters.')
  }
  return trimmed
}

export class VaultService extends EventEmitter {
  private unlocked = false
  // WHY single-flight + generation (review finding): without it, two
  // concurrent reveals on a locked vault opened TWO OS prompts, and a
  // prompt that was already in flight when lock() ran would complete
  // afterwards and silently re-unlock the vault. The pending promise
  // dedupes the prompts; the generation token makes a lock() that lands
  // mid-prompt win over the prompt's completion.
  private pendingUnlock: Promise<void> | null = null
  private lockGeneration = 0
  // WHY a mutation queue: every CRUD method is a load-modify-write of the
  // whole index. Two concurrent createProvider calls interleaved and one
  // entry silently vanished (reproduced in review). Serializing the
  // transactions through one promise chain is the smallest correct fix;
  // the vault is human-edit-frequency, so there is no throughput concern.
  private mutationQueue: Promise<unknown> = Promise.resolve()

  constructor(private readonly deps: VaultServiceDeps) { super() }

  getStatus(): KeyVaultStatus {
    return {
      encryptionAvailable: this.deps.store.encryptionAvailable(),
      authPromptAvailable: this.deps.canPromptAuth(),
      unlocked: this.unlocked,
    }
  }

  lock(): void {
    this.unlocked = false
    // Invalidate any prompt still on screen: its completion must not
    // resurrect the unlocked state the user just revoked.
    this.lockGeneration += 1
    this.emit('locked')
  }

  async unlock(): Promise<void> {
    await this.ensureUnlocked()
  }

  private ensureUnlocked(): Promise<void> {
    if (this.unlocked) return Promise.resolve()
    if (this.pendingUnlock) return this.pendingUnlock
    const generation = this.lockGeneration
    const pending = Promise.resolve().then(async () => {
      if (!this.deps.store.encryptionAvailable()) {
        throw new Error('System keyring unavailable — the vault cannot read or store keys on this machine.')
      }
      // WHY attempt instead of pre-gating on canPromptAuth (review
      // finding): Electron's canPromptTouchID() reports BIOMETRIC
      // capability only. Pre-gating locked out every password-only Mac
      // (mini/Studio/Pro, clamshell laptops) from the login-password
      // path the feature promises. promptTouchID itself presents the
      // password fallback; a platform that truly cannot prompt rejects
      // and we fail closed right here.
      await this.deps.promptAuth('unlock the Agent Code API key vault')
      if (generation !== this.lockGeneration) throw new Error('Vault was locked during authentication.')
      this.unlocked = true
    }).finally(() => {
      if (this.pendingUnlock === pending) this.pendingUnlock = null
    })
    this.pendingUnlock = pending
    return pending
  }

  private assertUnlocked(generation: number): void {
    // Lock must fence the result, not just the start of an async operation.
    // Otherwise a disk read or an OS prompt can return plaintext after revocation.
    if (!this.unlocked || generation !== this.lockGeneration) {
      throw new Error('Vault was locked. Unlock it and try again.')
    }
  }

  /** Serialize an index read-modify-write transaction (see mutationQueue). */
  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.mutationQueue.then(operation, operation)
    // Keep the chain alive even if a transaction rejects: one failed CRUD
    // call must not poison every later one.
    this.mutationQueue = next.catch(() => {})
    return next
  }

  async list(): Promise<KeyVaultSnapshot> {
    return this.deps.store.loadIndex()
  }

  async reveal(providerId: string, keyId: string): Promise<string> {
    const generation = this.lockGeneration
    await this.ensureUnlocked()
    const key = await this.findKey(providerId, keyId)
    const secret = await this.deps.store.readSecret(keyId)
    this.assertUnlocked(generation)
    if (secret === null) {
      throw new Error(
        `Key "${key.name}" cannot be decrypted (Keychain reset or corrupted blob). Re-enter the value to fix it.`,
      )
    }
    return secret
  }

  async copyKey(providerId: string, keyId: string): Promise<void> {
    const generation = this.lockGeneration
    const value = await this.reveal(providerId, keyId)
    this.assertUnlocked(generation)
    this.deps.copyToClipboard(value)
  }

  /** Resolve a `{{key:Provider/Key}}` template reference by NAME (#831).
   *  Names, not ids, so user-authored templates stay readable; renaming
   *  breaks references loudly rather than silently. */
  async resolveReference(providerName: string, keyName: string): Promise<string> {
    const generation = this.lockGeneration
    await this.ensureUnlocked()
    const snapshot = await this.deps.store.loadIndex()
    const provider = snapshot.providers.find(p => p.name === providerName)
    if (!provider) throw new Error(`Key vault provider "${providerName}" not found.`)
    const key = snapshot.keys.find(k => k.providerId === provider.id && k.name === keyName)
    if (!key) throw new Error(`Key "${keyName}" not found for provider "${providerName}".`)
    const secret = await this.deps.store.readSecret(key.id)
    this.assertUnlocked(generation)
    if (secret === null) {
      throw new Error(
        `Key "${key.name}" cannot be decrypted (Keychain reset or corrupted blob). Re-enter the value to fix it.`,
      )
    }
    return secret
  }

  async createProvider(name: string): Promise<KeyVaultProvider> {
    return this.enqueueMutation(() => this.createProviderTransaction(name))
  }

  private async createProviderTransaction(name: string): Promise<KeyVaultProvider> {
    const trimmed = validateName(name)
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
    return this.enqueueMutation(() => this.renameProviderTransaction(id, name))
  }

  private async renameProviderTransaction(id: string, name: string): Promise<void> {
    const trimmed = validateName(name)
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
    return this.enqueueMutation(() => this.deleteProviderTransaction(id))
  }

  private async deleteProviderTransaction(id: string): Promise<void> {
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
    return this.enqueueMutation(() => this.putKeyTransaction(input))
  }

  private async putKeyTransaction(input: KeyVaultKeyInput): Promise<KeyVaultKey> {
    const name = validateName(input.name)
    if (input.note.length > 4000 || input.value.length > 65536 || /[\x00-\x1f\x7f]/.test(input.value)) {
      throw new Error('Key values must be single-line text up to 64 KiB; notes may be up to 4000 characters.')
    }
    const snapshot = await this.deps.store.loadIndex()
    if (!snapshot.providers.some(p => p.id === input.providerId)) {
      throw new Error('Provider not found.')
    }
    const now = this.deps.now?.() ?? Date.now()
    const existing = input.id ? snapshot.keys.find(k => k.id === input.id && k.providerId === input.providerId) : undefined
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
        hint = hintFor(value)
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
      hint: hintFor(value),
      createdAt: now,
      updatedAt: now,
    }
    await this.deps.store.writeSecret(key.id, value)
    snapshot.keys.push(key)
    await this.deps.store.saveIndex(snapshot)
    return key
  }

  async deleteKey(providerId: string, keyId: string): Promise<void> {
    return this.enqueueMutation(() => this.deleteKeyTransaction(providerId, keyId))
  }

  private async deleteKeyTransaction(providerId: string, keyId: string): Promise<void> {
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
