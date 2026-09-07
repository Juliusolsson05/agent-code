# API Key Vault + Session Text Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an encrypted API Key Vault (Touch ID / Mac-password unlock, once per app launch) whose keys insert into any focused pane — composer, agent terminal view, or raw terminal — via a shared session-text delivery helper that also makes prompt templates work over terminals, including `{{key:Provider/Key}}` template references.

**Architecture:** Two features, one branch. (1) A renderer-owned `deliverTextToSession` helper dispatches by session kind and effective surface: composer draft append for rendered agent panes; bracketed-paste-without-Enter over `window.api.sendInput` for any focused PTY (plain terminals and agent panes in terminal view both use that channel). (2) A main-process `VaultService` persists providers in a plaintext index and one safeStorage-encrypted blob per key under `STATE_DIR/key-vault/`, gated by `systemPreferences.promptTouchID` once per app run and failing closed. Prompt templates resolve `{{key:Provider/Key}}` refs against the vault before insertion.

**Tech Stack:** Electron 43 (`safeStorage`, `systemPreferences.promptTouchID`, `clipboard`), zustand uiShell, existing command palette + surface registry, vitest (unit + renderer projects).

**Issues:** #830 (session-text delivery), #831 (key vault). Worktree: `.worktrees/feat-api-key-vault`, branch `feat/api-key-vault` (already created from `main`).

**Verification commands** (run in the worktree root):

```bash
npm run typecheck
npm run test:unit -- src/main/keyVault
npm run test:unit -- src/renderer/src/features/prompt-templates
npm run test:renderer -- src/renderer/src/features/session-text-delivery
npm run check:keybindings
npm run test:contract
```

---

### Task 0: Bootstrap the worktree

**Files:** none (environment only).

- [ ] **Step 1: Initialize submodules and install dependencies**

The fresh worktree has no submodule checkouts or `node_modules`, and every script below needs both (dev aliases compile packages from `src/`).

Run (workdir `.worktrees/feat-api-key-vault`):

```bash
git submodule update --init --recursive && npm install
```

Expected: submodule checkouts populate `packages/*/src` and `npm install` succeeds (`postinstall` rebuilds node-pty).

- [ ] **Step 2: Baseline the type check**

Run: `npm run typecheck`
Expected: exits 0 before any edits.

---

### Task 1: Vault store (shared types + encrypted per-key persistence)

**Files:**
- Create: `src/shared/types/keyVault.ts`
- Create: `src/main/keyVault/vaultStore.ts`
- Test: `src/main/keyVault/vaultStore.test.ts`

- [ ] **Step 1: Write the shared wire types**

Create `src/shared/types/keyVault.ts`:

```ts
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
```

- [ ] **Step 2: Write the failing store tests**

Create `src/main/keyVault/vaultStore.test.ts`:

```ts
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'

import { createFileVaultStore, type SecretCodec } from '@main/keyVault/vaultStore.js'

// Deterministic fake codec: real safeStorage cannot run under vitest
// (the electron module is the packaged app), and the store's job here is
// file discipline, not cryptography — safeStorage itself is exercised by
// the packaged app and by Electron upstream.
const fakeCodec: SecretCodec = {
  isEncryptionAvailable: () => true,
  encrypt: plain => Buffer.from(`enc:${plain}`, 'utf8'),
  decrypt: cipher => cipher.toString('utf8').slice(4),
}

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agent-code-vault-'))
})

describe('vaultStore', () => {
  it('round-trips index edits and secrets', async () => {
    const store = createFileVaultStore(root, fakeCodec)
    const snapshot = await store.loadIndex()
    const provider = { id: 'p1', name: 'Brave', createdAt: 1, updatedAt: 1 }
    snapshot.providers.push(provider)
    snapshot.keys.push({
      id: 'k1', providerId: 'p1', name: 'main', note: '', hint: '_key',
      createdAt: 1, updatedAt: 1,
    })
    await store.saveIndex(snapshot)
    await store.writeSecret('k1', 'BSA-secret-value')

    const reloaded = createFileVaultStore(root, fakeCodec)
    expect((await reloaded.loadIndex()).providers).toEqual([provider])
    expect(await reloaded.readSecret('k1')).toBe('BSA-secret-value')
  })

  it('starts with an empty snapshot on a fresh directory', async () => {
    const store = createFileVaultStore(root, fakeCodec)
    const snapshot = await store.loadIndex()
    expect(snapshot.providers).toEqual([])
    expect(snapshot.keys).toEqual([])
  })

  it('isolates a corrupt blob to a single key', async () => {
    const store = createFileVaultStore(root, fakeCodec)
    const snapshot = await store.loadIndex()
    snapshot.providers.push({ id: 'p1', name: 'Brave', createdAt: 1, updatedAt: 1 })
    snapshot.keys.push(
      { id: 'good', providerId: 'p1', name: 'a', note: '', hint: 'aaaa', createdAt: 1, updatedAt: 1 },
      { id: 'bad', providerId: 'p1', name: 'b', note: '', hint: 'bbbb', createdAt: 1, updatedAt: 1 },
    )
    await store.saveIndex(snapshot)
    await store.writeSecret('good', 'one')
    await store.writeSecret('bad', 'two')
    // Corrupt exactly one blob on disk — the Keychain-reset scenario from
    // apiKeyStore.ts: a decrypt failure must cost one key, not the vault.
    await writeFile(join(root, 'keys', 'bad.bin'), Buffer.from('garbage'))

    expect(await store.readSecret('good')).toBe('one')
    expect(await store.readSecret('bad')).toBeNull()
  })

  it('reports encryption availability through the codec', async () => {
    const unavailable = createFileVaultStore(root, { ...fakeCodec, isEncryptionAvailable: () => false })
    expect(unavailable.encryptionAvailable()).toBe(false)
  })

  it('deletes secret blobs without touching the index', async () => {
    const store = createFileVaultStore(root, fakeCodec)
    await store.writeSecret('k1', 'v')
    await store.deleteSecret('k1')
    expect(await store.readSecret('k1')).toBeNull()
    // Index file still parses after secret deletion.
    await expect(store.loadIndex()).resolves.toBeTruthy()
  })

  it('writes secret blobs with 0600 permissions', async () => {
    const store = createFileVaultStore(root, fakeCodec)
    await store.writeSecret('k1', 'v')
    const stat = await readFile(join(root, 'keys', 'k1.bin'))
    expect(stat.length).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm run test:unit -- src/main/keyVault`
Expected: FAIL — cannot resolve `@main/keyVault/vaultStore.js`.

- [ ] **Step 4: Implement the store**

Create `src/main/keyVault/vaultStore.ts`:

```ts
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

  async function atomicWrite(path: string, data: string | Buffer, mode: 0o600 | undefined): Promise<void> {
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
        // Absent index = fresh vault. A CORRUPT index is handled by the
        // service (it decides between fail-closed and reset); the store
        // only reports what it can parse.
        return { providers: [], keys: [] }
      }
      try {
        const parsed = JSON.parse(raw) as IndexFile
        return { providers: parsed.providers ?? [], keys: parsed.keys ?? [] }
      } catch {
        // Unparseable index is treated as absent: the vault degrades to
        // empty rather than bricking startup. Secret blobs on disk become
        // orphans, which is the safe direction (no silent secret loss —
        // the loss already happened when the index corrupted).
        return { providers: [], keys: [] }
      }
    },

    async saveIndex(snapshot) {
      const file: IndexFile = { version: 1, providers: snapshot.providers, keys: snapshot.keys }
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run test:unit -- src/main/keyVault`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add src/shared/types/keyVault.ts src/main/keyVault/vaultStore.ts src/main/keyVault/vaultStore.test.ts
git commit -m "feat(vault): add encrypted per-key vault store

Per-key safeStorage blobs under STATE_DIR/key-vault with a non-secret
metadata index, mirroring the dictation apiKeyStore failure discipline:
a corrupt cipher blob costs one key, never the vault. Codec injection
keeps the file discipline unit-testable outside the packaged app.

Refs #831"
```

---

### Task 2: Vault service (Touch ID gate, CRUD, clipboard)

**Files:**
- Create: `src/main/keyVault/VaultService.ts`
- Test: `src/main/keyVault/VaultService.test.ts`

- [ ] **Step 1: Write the failing service tests**

Create `src/main/keyVault/VaultService.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { VaultService, type VaultServiceDeps } from '@main/keyVault/VaultService.js'
import type { VaultStore } from '@main/keyVault/vaultStore.js'
import type { KeyVaultSnapshot } from '@shared/types/keyVault'

// In-memory store: the file layer has its own tests (vaultStore.test.ts);
// these tests pin the SERVICE rules — gate semantics, ordering, and
// fail-closed behavior.
function makeStore(): VaultStore & { snapshot: KeyVaultSnapshot } {
  const snapshot: KeyVaultSnapshot = { providers: [], keys: [] }
  const secrets = new Map<string, string>()
  return {
    snapshot,
    encryptionAvailable: () => true,
    loadIndex: async () => ({ providers: [...snapshot.providers], keys: [...snapshot.keys] }),
    saveIndex: async next => {
      snapshot.providers = [...next.providers]
      snapshot.keys = [...next.keys]
    },
    readSecret: async id => secrets.get(id) ?? null,
    writeSecret: async (id, value) => void secrets.set(id, value),
    deleteSecret: async id => void secrets.delete(id),
  }
}

function makeDeps(overrides: Partial<VaultServiceDeps> = {}): VaultServiceDeps {
  return {
    store: makeStore(),
    promptAuth: vi.fn(async () => {}),
    canPromptAuth: () => true,
    copyToClipboard: vi.fn(),
    now: () => 1_000,
    ...overrides,
  }
}

describe('VaultService unlock gate', () => {
  it('prompts exactly once per run for repeated reveals', async () => {
    const deps = makeDeps()
    const service = new VaultService(deps)
    const provider = await service.createProvider('Brave')
    const key = await service.putKey({ providerId: provider.id, name: 'main', value: 'BSA-xyz', note: '' })

    await service.reveal(provider.id, key.id)
    await service.copyKey(provider.id, key.id)
    await service.reveal(provider.id, key.id)

    expect(deps.promptAuth).toHaveBeenCalledTimes(1)
    expect(service.getStatus().unlocked).toBe(true)
  })

  it('fails closed when the user cancels the OS prompt', async () => {
    const deps = makeDeps({ promptAuth: vi.fn(async () => { throw new Error('user canceled') }) })
    const service = new VaultService(deps)
    const provider = await service.createProvider('Brave')
    const key = await service.putKey({ providerId: provider.id, name: 'main', value: 'BSA-xyz', note: '' })

    await expect(service.reveal(provider.id, key.id)).rejects.toThrow('user canceled')
    expect(service.getStatus().unlocked).toBe(false)
  })

  it('fails closed when no auth prompt mechanism exists', async () => {
    const service = new VaultService(makeDeps({ canPromptAuth: () => false }))
    await expect(service.unlock()).rejects.toThrow(/authentication is unavailable/i)
  })

  it('fails closed when the OS keyring is unavailable', async () => {
    const store = makeStore()
    const service = new VaultService(makeDeps({
      store: Object.assign(store, { encryptionAvailable: () => false }),
    }))
    await expect(service.unlock()).rejects.toThrow(/keyring unavailable/i)
  })

  it('lock() re-arms the gate within the same run', async () => {
    const deps = makeDeps()
    const service = new VaultService(deps)
    await service.unlock()
    service.lock()
    await service.unlock()
    expect(deps.promptAuth).toHaveBeenCalledTimes(2)
  })
})

describe('VaultService CRUD', () => {
  let service: VaultService
  let providerId: string

  beforeEach(async () => {
    service = new VaultService(makeDeps())
    const provider = await service.createProvider('Brave')
    providerId = provider.id
  })

  it('round-trips providers and keys with hints', async () => {
    const key = await service.putKey({ providerId, name: 'main', value: 'BSA-abcdef1234', note: 'prod' })
    expect(key.hint).toBe('1234')
    const list = await service.list()
    expect(list.providers.map(p => p.name)).toEqual(['Brave'])
    expect(list.keys.map(k => k.name)).toEqual(['main'])
    expect(await service.reveal(providerId, key.id)).toBe('BSA-abcdef1234')
  })

  it('updating with an empty value keeps the existing secret', async () => {
    const key = await service.putKey({ providerId, name: 'main', value: 'BSA-one', note: '' })
    await service.putKey({ providerId, id: key.id, name: 'renamed', value: '', note: 'n' })
    const list = await service.list()
    expect(list.keys[0].name).toBe('renamed')
    // Hint unchanged: the stored secret is unchanged.
    expect(list.keys[0].hint).toBe('-one')
    expect(await service.reveal(providerId, key.id)).toBe('BSA-one')
  })

  it('rejects duplicate provider names case-insensitively', async () => {
    await expect(service.createProvider('brave')).rejects.toThrow(/already exists/i)
  })

  it('rejects duplicate key names within a provider', async () => {
    await service.putKey({ providerId, name: 'main', value: 'a', note: '' })
    await expect(service.putKey({ providerId, name: 'main', value: 'b', note: '' })).rejects.toThrow(/already exists/i)
  })

  it('deleting a provider removes its key secrets too', async () => {
    const key = await service.putKey({ providerId, name: 'main', value: 'x', note: '' })
    await service.deleteProvider(providerId)
    const list = await service.list()
    expect(list.providers).toEqual([])
    expect(list.keys).toEqual([])
    expect(await new VaultService(makeDeps()).list()).resolves.toBeTruthy()
  })

  it('resolveReference matches by provider/key name after gating', async () => {
    await service.putKey({ providerId, name: 'main', value: 'BSA-ref', note: '' })
    await expect(service.resolveReference('Brave', 'main')).resolves.toBe('BSA-ref')
    await expect(service.resolveReference('Brave', 'missing')).rejects.toThrow(/not found/i)
  })

  it('corrupt secret blob surfaces as a readable-key error', async () => {
    // Simulate the Keychain-reset corruption: metadata present, secret
    // unreadable. Contract: reveal names the key instead of returning
    // null or throwing something opaque.
    const nullStore = Object.assign(makeStore(), { readSecret: async () => null })
    const service2 = new VaultService(makeDeps({ store: nullStore }))
    const provider = await service2.createProvider('Brave')
    const key = await service2.putKey({ providerId: provider.id, name: 'main', value: 'y', note: '' })
    // Break the in-memory secret AFTER creation so putKey's availability
    // probe still saw a value.
    ;(nullStore as unknown as { readSecret: () => Promise<string | null> }).readSecret = async () => null
    await expect(service2.reveal(provider.id, key.id)).rejects.toThrow(/cannot be decrypted/i)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:unit -- src/main/keyVault`
Expected: FAIL — cannot resolve `VaultService.js`.

- [ ] **Step 3: Implement the service**

Create `src/main/keyVault/VaultService.ts`:

```ts
import type { KeyVaultKey, KeyVaultKeyInput, KeyVaultProvider, KeyVaultSnapshot, KeyVaultStatus } from '@shared/types/keyVault'
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
      throw new Error('macOS authentication is unavailable — the vault stays locked. (Touch ID / login password prompt required.)')
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
      throw new Error(`Key "${key.name}" cannot be decrypted (Keychain reset or corrupted blob). Re-enter the value to fix it.`)
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
      throw new Error(`Key "${key.name}" cannot be decrypted (Keychain reset or corrupted blob). Re-enter the value to fix it.`)
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
    const remainingKeys = snapshot.keys.filter(k => k.providerId !== id)
    // Index-first ordering: a crash mid-delete leaves an orphan blob
    // (harmless, invisible) rather than an index entry whose secret is
    // already gone (reads as corrupt).
    await this.deps.store.saveIndex({ providers: snapshot.providers.filter(p => p.id !== id), keys: remainingKeys })
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
    if (snapshot.keys.some(k => k.id !== existing?.id && k.providerId === input.providerId && k.name === name)) {
      throw new Error(`Key "${name}" already exists for this provider.`)
    }

    // Secret-first ordering on update: write the new blob BEFORE the
    // index references it, so a crash never produces an index entry with
    // a missing/stale blob.
    const value = input.value.trim()
    let hint = existing?.hint ?? ''
    if (existing) {
      if (value.length > 0) {
        await this.deps.store.writeSecret(existing.id, value)
        hint = value.slice(-4)
      } else if (await this.deps.store.readSecret(existing.id) === null) {
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:unit -- src/main/keyVault`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/keyVault/VaultService.ts src/main/keyVault/VaultService.test.ts
git commit -m "feat(vault): add touch-id gated vault service

Every secret-leaving path funnels through one once-per-run gate backed by
an injected promptAuth (systemPreferences.promptTouchID in production),
failing closed when the platform cannot prompt. Snapshot metadata never
carries secrets; template references resolve by provider/key name.

Refs #831"
```

---

### Task 3: IPC handlers + preload API + main wiring

**Files:**
- Create: `src/main/ipc/keyVault.ts`
- Modify: `src/main/ipc/index.ts` (import + deps entry + register call)
- Create: `src/preload/api/keyVault.ts`
- Modify: `src/preload/api/index.ts` (import + spread)
- Modify: `src/main/index.ts` (construct service, pass to registerAllIpc)

- [ ] **Step 1: Create the IPC module**

Create `src/main/ipc/keyVault.ts` (mirrors `src/main/ipc/caffeinate.ts` — thin handlers, service owns behavior):

```ts
import { ipcMain } from 'electron'

import type { VaultService } from '@main/keyVault/VaultService.js'
import type { KeyVaultKeyInput } from '@shared/types/keyVault'

// Thin IPC surface for the key vault (#831). Handlers validate nothing —
// the service owns all rules — so behavior stays testable without
// spinning up ipcMain. Secrets cross only on the reveal/copy/resolve-ref
// return paths, all of which sit behind the service's unlock gate.
export function registerKeyVaultIpc({ vaultService }: { vaultService: VaultService }): void {
  ipcMain.handle('key-vault:status', () => vaultService.getStatus())
  ipcMain.handle('key-vault:list', () => vaultService.list())
  ipcMain.handle('key-vault:unlock', () => vaultService.unlock())
  ipcMain.handle('key-vault:lock', () => vaultService.lock())
  ipcMain.handle('key-vault:reveal', (_event, providerId: string, keyId: string) =>
    vaultService.reveal(providerId, keyId))
  ipcMain.handle('key-vault:copy-key', (_event, providerId: string, keyId: string) =>
    vaultService.copyKey(providerId, keyId))
  ipcMain.handle('key-vault:resolve-ref', (_event, providerName: string, keyName: string) =>
    vaultService.resolveReference(providerName, keyName))
  ipcMain.handle('key-vault:create-provider', (_event, name: string) => vaultService.createProvider(name))
  ipcMain.handle('key-vault:rename-provider', (_event, id: string, name: string) =>
    vaultService.renameProvider(id, name))
  ipcMain.handle('key-vault:delete-provider', (_event, id: string) => vaultService.deleteProvider(id))
  ipcMain.handle('key-vault:put-key', (_event, input: KeyVaultKeyInput) => vaultService.putKey(input))
  ipcMain.handle('key-vault:delete-key', (_event, providerId: string, keyId: string) =>
    vaultService.deleteKey(providerId, keyId))
}
```

- [ ] **Step 2: Register it in the IPC aggregator**

In `src/main/ipc/index.ts`:

1. Add imports next to the caffeinate import block:

```ts
import { registerKeyVaultIpc } from '@main/ipc/keyVault.js'
import type { VaultService } from '@main/keyVault/VaultService.js'
```

2. Add `vaultService: VaultService` to the `registerAllIpc(deps)` parameter type (mirror how `caffeinateController: CaffeinateController` appears).

3. Add the call inside `registerAllIpc` next to `registerCaffeinateIpc(deps)`:

```ts
registerKeyVaultIpc(deps)
```

- [ ] **Step 3: Create the preload API module**

Create `src/preload/api/keyVault.ts`:

```ts
import { ipcRenderer } from 'electron'

import type { KeyVaultKeyInput, KeyVaultSnapshot, KeyVaultStatus } from '@shared/types/keyVault'

// Flat key-vault surface merged into window.api. Rejected promises carry
// the service's Error message (cancel, fail-closed, not-found) so the UI
// can toast it verbatim.
export const keyVaultApi = {
  keyVaultStatus: (): Promise<KeyVaultStatus> => ipcRenderer.invoke('key-vault:status'),
  keyVaultList: (): Promise<KeyVaultSnapshot> => ipcRenderer.invoke('key-vault:list'),
  keyVaultUnlock: (): Promise<void> => ipcRenderer.invoke('key-vault:unlock'),
  keyVaultLock: (): Promise<void> => ipcRenderer.invoke('key-vault:lock'),
  keyVaultReveal: (providerId: string, keyId: string): Promise<string> =>
    ipcRenderer.invoke('key-vault:reveal', providerId, keyId),
  keyVaultCopyKey: (providerId: string, keyId: string): Promise<void> =>
    ipcRenderer.invoke('key-vault:copy-key', providerId, keyId),
  keyVaultResolveReference: (providerName: string, keyName: string): Promise<string> =>
    ipcRenderer.invoke('key-vault:resolve-ref', providerName, keyName),
  keyVaultCreateProvider: (name: string): Promise<void> =>
    ipcRenderer.invoke('key-vault:create-provider', name),
  keyVaultRenameProvider: (id: string, name: string): Promise<void> =>
    ipcRenderer.invoke('key-vault:rename-provider', id, name),
  keyVaultDeleteProvider: (id: string): Promise<void> =>
    ipcRenderer.invoke('key-vault:delete-provider', id),
  keyVaultPutKey: (input: KeyVaultKeyInput): Promise<void> =>
    ipcRenderer.invoke('key-vault:put-key', input),
  keyVaultDeleteKey: (providerId: string, keyId: string): Promise<void> =>
    ipcRenderer.invoke('key-vault:delete-key', providerId, keyId),
}
```

- [ ] **Step 4: Merge into the preload api object**

In `src/preload/api/index.ts`, add the import with the other api module imports:

```ts
import { keyVaultApi } from './keyVault.js'
```

and add to the composed flat object (spread-merge; a name collision is a compile error by design):

```ts
  ...keyVaultApi,
```

- [ ] **Step 5: Wire the service in main**

In `src/main/index.ts`, add imports near the other service imports:

```ts
import { clipboard, systemPreferences } from 'electron'
import { createFileVaultStore } from '@main/keyVault/vaultStore.js'
import { VaultService } from '@main/keyVault/VaultService.js'
```

(If `electron` is already imported there, extend that import instead of adding a second one.)

Construct the service near the `CaffeinateController` construction, before `registerAllIpc`:

```ts
// API Key Vault (#831). promptTouchID presents Touch ID with the user's
// login password as fallback, which is the "mac password" gate. Unsigned
// dev builds may skip the biometric option but the password path still
// works; if neither is available the service fails closed on unlock.
const vaultService = new VaultService({
  store: createFileVaultStore(),
  promptAuth: reason => systemPreferences.promptTouchID(reason),
  canPromptAuth: () => systemPreferences.canPromptTouchID(),
  copyToClipboard: text => clipboard.writeText(text),
})
```

Then add `vaultService,` to the `registerAllIpc({ ... })` call's deps argument.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: exits 0. (The `electron` import in `main/index.ts` must not duplicate an existing import — merge if flagged.)

- [ ] **Step 7: Commit**

```bash
git add src/main/ipc/keyVault.ts src/main/ipc/index.ts src/preload/api/keyVault.ts src/preload/api/index.ts src/main/index.ts
git commit -m "feat(vault): expose vault over ipc and preload

Thin ipcMain handlers delegating to VaultService, a flat preload surface,
and production wiring of promptTouchID/clipboard in the composition
root. Secrets only cross on gated reveal/copy/resolve-ref returns.

Refs #831"
```

---

### Task 4: Session text delivery helper

**Files:**
- Create: `src/renderer/src/features/session-text-delivery/deliverTextToSession.ts`
- Test: `src/renderer/src/features/session-text-delivery/deliverTextToSession.renderer.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/renderer/src/features/session-text-delivery/deliverTextToSession.renderer.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { deliverTextToSession } from '@renderer/features/session-text-delivery/deliverTextToSession'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import type { SessionRuntime } from '@renderer/session-runtime/state'
import type { SessionId } from '@renderer/workspace/types'

// The dispatch matrix (#830): composer draft for rendered agent panes,
// bracketed paste without Enter for every focused PTY (plain terminals
// and agent panes in terminal view share window.api.sendInput).
// window.api is stubbed because the real bridge only exists in the
// packaged app.

const sendInput = vi.fn(async () => {})
const ensureSessionLive = vi.fn(async () => {})

function makeRuntime(overrides: Partial<SessionRuntime> = {}): SessionRuntime {
  return { draftInput: '', processStatus: 'started', ...overrides } as unknown as SessionRuntime
}

function makeWorkspace(sessions: Record<string, { kind: string; override?: string }>, runtimes: Record<string, SessionRuntime>): Workspace {
  return {
    state: {
      sessions: Object.fromEntries(
        Object.entries(sessions).map(([id, s]) => [id, { id, kind: s.kind, agentViewModeOverride: s.override }]),
      ),
    },
    getRuntime: (id: SessionId) => runtimes[id],
    setDraftInput: vi.fn(),
    ensureSessionLive,
  } as unknown as Workspace
}

beforeEach(() => {
  sendInput.mockClear()
  ensureSessionLive.mockClear()
  ;(globalThis as { window?: unknown }).window = { api: { sendInput } }
})

describe('deliverTextToSession', () => {
  it('appends to the composer draft for a rendered agent pane', async () => {
    const workspace = makeWorkspace(
      { a: { kind: 'claude', override: 'agent' } },
      { a: makeRuntime({ draftInput: 'existing' }) },
    )
    const result = await deliverTextToSession(workspace, 'a', 'new text', { insertMode: 'append' })
    expect(result).toEqual({ delivered: true, surface: 'composer' })
    expect(workspace.setDraftInput).toHaveBeenCalledWith('a', 'existing\n\nnew text')
    expect(sendInput).not.toHaveBeenCalled()
  })

  it('bracket-pastes without Enter into a plain terminal pane', async () => {
    const workspace = makeWorkspace({ t: { kind: 'terminal' } }, { t: makeRuntime() })
    const result = await deliverTextToSession(workspace, 't', 'line1\nline2')
    expect(result).toEqual({ delivered: true, surface: 'pty' })
    expect(sendInput).toHaveBeenCalledWith('t', '\x1b[200~line1\nline2\x1b[201~')
  })

  it('bracket-pastes into an agent pane in terminal view', async () => {
    const workspace = makeWorkspace(
      { a: { kind: 'claude', override: 'terminal' } },
      { a: makeRuntime() },
    )
    const result = await deliverTextToSession(workspace, 'a', 'key')
    expect(result).toEqual({ delivered: true, surface: 'pty' })
    expect(sendInput).toHaveBeenCalledWith('a', '\x1b[200~key\x1b[201~')
  })

  it('wakes a sleeping backend before writing to a PTY', async () => {
    const workspace = makeWorkspace({ t: { kind: 'terminal' } }, { t: makeRuntime({ processStatus: 'stopped' }) })
    await deliverTextToSession(workspace, 't', 'x')
    expect(ensureSessionLive).toHaveBeenCalledWith('t', 'session-text-delivery', { awaitInputReady: false })
    expect(sendInput).toHaveBeenCalled()
  })

  it('does not wake an already-started backend', async () => {
    const workspace = makeWorkspace({ t: { kind: 'terminal' } }, { t: makeRuntime() })
    await deliverTextToSession(workspace, 't', 'x')
    expect(ensureSessionLive).not.toHaveBeenCalled()
  })

  it('reports no-session for an unknown target', async () => {
    const workspace = makeWorkspace({}, {})
    const result = await deliverTextToSession(workspace, 'gone' as SessionId, 'x')
    expect(result).toEqual({ delivered: false, reason: 'no-session' })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:renderer -- src/renderer/src/features/session-text-delivery`
Expected: FAIL — cannot resolve the module.

- [ ] **Step 3: Implement the helper**

Create `src/renderer/src/features/session-text-delivery/deliverTextToSession.ts`:

```ts
import { useAppStore } from '@renderer/app-state/hooks'
import { applyPromptTemplateInsertMode } from '@renderer/features/prompt-templates/interpolate'
import { getEffectiveAgentSurfaceForSession } from '@renderer/workspace/agentDisplayMode'
import { isSessionExited } from '@renderer/workspace/providerSessionIdentity'
import type { SessionId } from '@renderer/workspace/types'
import type { Workspace } from '@renderer/workspace/workspaceStore'

// Session text delivery (#830): the ONE routing point for programmatic
// text insertion into a pane. Prompt Templates and the API Key Vault
// both call this instead of hand-rolling per-feature paths.
//
// Dispatch rule — mirror what the user sees:
//   * rendered agent surface → composer draft edit (never submits; the
//     draft stays visible and editable, matching template insertion's
//     "prefill, don't replay" contract)
//   * anything with a visible PTY (plain terminal pane, or agent pane
//     in terminal view) → bracketed paste via window.api.sendInput,
//     which is the SAME channel both surfaces use for keystrokes
//
// WHY no Enter on the PTY path: the user must review what landed before
// it executes. Bracketed paste markers additionally keep shells like
// zsh from executing multi-line payloads line-by-line. Trade-off: a
// program that never enabled bracketed paste mode will print the marker
// bytes — acceptable versus the alternative of raw newlines, which a
// shell would run immediately.

export type DeliverTextResult =
  | { delivered: true; surface: 'composer' | 'pty' }
  | { delivered: false; reason: 'no-session' }

export async function deliverTextToSession(
  workspace: Workspace,
  sessionId: SessionId,
  text: string,
  opts?: { insertMode?: 'replace' | 'append' },
): Promise<DeliverTextResult> {
  const session = workspace.state.sessions[sessionId]
  if (!session) return { delivered: false, reason: 'no-session' }

  if (session.kind !== 'terminal') {
    const surface = getEffectiveAgentSurfaceForSession({
      kind: session.kind,
      providerRuntime: session.providerRuntime,
      globalMode: useAppStore.getState().settings.agentViewMode,
      override: session.agentViewModeOverride,
      runtime: workspace.getRuntime(sessionId),
    })
    if (surface === 'rendered') {
      const currentDraft = workspace.getRuntime(sessionId).draftInput
      workspace.setDraftInput(
        sessionId,
        applyPromptTemplateInsertMode(currentDraft, text, opts?.insertMode ?? 'append'),
      )
      return { delivered: true, surface: 'composer' }
    }
  }
  return deliverPtyText(workspace, sessionId, text)
}

async function deliverPtyText(
  workspace: Workspace,
  sessionId: SessionId,
  text: string,
): Promise<DeliverTextResult> {
  const runtime = workspace.getRuntime(sessionId)
  // WHY wake first: lazily-woken restored sessions may have no main-side
  // backend yet, and sendInput into a missing backend is silently
  // dropped. Same predicate and no input-ready wait as AgentTerminalLeaf
  // (#772): readiness is a composer concept, not a PTY one.
  if (runtime.processStatus !== 'started' || isSessionExited(runtime)) {
    await workspace.ensureSessionLive(sessionId, 'session-text-delivery', { awaitInputReady: false })
  }
  await window.api.sendInput(sessionId, `\x1b[200~${text}\x1b[201~`)
  return { delivered: true, surface: 'pty' }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:renderer -- src/renderer/src/features/session-text-delivery`
Expected: PASS (6 tests). If the `agentViewModeOverride` or `providerRuntime` field names mismatch `SessionMeta`, fix the fake workspace in the test to the real field names — the helper's source is the contract.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/features/session-text-delivery
git commit -m "feat(session-text): deliver text to any focused pane

One routing point for programmatic text insertion: composer draft edits
for rendered agent panes, bracketed paste without Enter over sendInput
for plain terminals and agent terminal views, with lazy-wake before PTY
writes. Consumers: prompt templates and the api key vault.

Refs #830"
```

---

### Task 5: Prompt templates over terminals

**Files:**
- Modify: `src/renderer/src/features/prompt-templates/targetSession.ts`
- Modify: `src/renderer/src/features/prompt-templates/commands/promptTemplateCommands.ts`
- Modify: `src/renderer/src/features/command-palette/ui/CommandPalette.tsx` (both insertion sites)
- Test: `src/renderer/src/features/prompt-templates/targetSession.test.ts` (update expectations)

- [ ] **Step 1: Update targetSession**

Replace the body of `promptTemplateTargetSessionIdForState` in `src/renderer/src/features/prompt-templates/targetSession.ts` and its doc comment:

```ts
/**
 * Resolves the pane that may receive a prompt template.
 *
 * WHY this is the shared command target and not narrower (#830):
 * terminal panes became valid template targets when insertion learned to
 * bracket-paste into any focused PTY via deliverTextToSession. The old
 * agent-only predicate hid the command from exactly the panes where
 * users run unsupported agent harnesses in a raw terminal.
 */
export function promptTemplateTargetSessionId(workspace: Workspace): string | null {
  return promptTemplateTargetSessionIdForState(workspace.state)
}

export function promptTemplateTargetSessionIdForState(state: WorkspaceState): string | null {
  return commandTargetSessionIdForState(state)
}
```

- [ ] **Step 2: Update the commands**

In `src/renderer/src/features/prompt-templates/commands/promptTemplateCommands.ts`:

1. On the `prompt-template` command, remove the `renderedViewPolicy: { kind: 'requires-rendered-feed' }` line (a terminal-surface pane has no rendered feed; the policy would hide the command where #830 just made it work) and update its description:

```ts
    description: '**What it does:** Inserts a saved **prompt template** into the focused pane.\n\n**Use when:** You want reusable prompt text without retyping it.\n\n**Notes:** Rendered panes insert into the composer; terminal panes receive a bracketed paste without submitting.',
```

2. The `save-composer-as-prompt-template` command must stay composer-only — replace its `when` guard:

```ts
    when: ({ workspace }) => {
      const sessionId = promptTemplateTargetSessionId(workspace)
      if (!sessionId) return false
      // Saving reads the composer draft; terminal panes have none.
      if ((workspace.state.sessions[sessionId]?.kind ?? 'claude') === 'terminal') return false
      return workspace.getRuntime(sessionId).draftInput.trim().length > 0
    },
```

- [ ] **Step 3: Route palette insertion through the helper**

In `src/renderer/src/features/command-palette/ui/CommandPalette.tsx`:

1. Add the import:

```ts
import { deliverTextToSession } from '@renderer/features/session-text-delivery/deliverTextToSession'
```

2. In `executePromptTemplate`, replace the direct-draft insertion block:

```ts
        const currentDraft = workspace.getRuntime(sessionId).draftInput
        workspace.setDraftInput(sessionId, applyPromptTemplateInsertMode(currentDraft, body, template.insertMode))
        workspace.showPaneToast(sessionId, `Inserted template: ${template.title}`)
        onClose()
```

with:

```ts
        const result = await deliverTextToSession(workspace, sessionId, body, { insertMode: template.insertMode })
        if (result.delivered) {
          workspace.showPaneToast(sessionId, `Inserted template: ${template.title}`)
          onClose()
        } else {
          workspace.showPaneToast(sessionId, 'Template target pane is gone')
        }
```

3. In `insertFilledPromptTemplate`, replace:

```ts
      const currentDraft = workspace.getRuntime(sessionId).draftInput
      workspace.setDraftInput(
        sessionId,
        applyPromptTemplateInsertMode(currentDraft, resolved, fill.insertMode),
      )
      workspace.showPaneToast(sessionId, `Inserted template: ${fill.template.title}`)
      onClose()
```

with (and make the callback body async — change `const insertFilledPromptTemplate = useCallback(() => {` to `useCallback(async () => {`):

```ts
      const result = await deliverTextToSession(workspace, sessionId, resolved, { insertMode: fill.insertMode })
      if (result.delivered) {
        workspace.showPaneToast(sessionId, `Inserted template: ${fill.template.title}`)
        onClose()
      } else {
        workspace.showPaneToast(sessionId, 'Template target pane is gone')
      }
```

If callers invoke `insertFilledPromptTemplate` synchronously, wrap their call sites with `void insertFilledPromptTemplate()` — do not leave a floating promise.

4. Check whether `applyPromptTemplateInsertMode` is still used in this file after both replacements; if not, remove it from the import (the delivery helper owns that logic now). Keep `fillPromptTemplateBody` — it still resolves variables.

- [ ] **Step 4: Update targetSession tests**

In `src/renderer/src/features/prompt-templates/targetSession.test.ts`, update/extend the cases: terminal-kind sessions are now VALID targets; keep any non-session rejection cases. Example additions:

```ts
  it('accepts terminal panes as targets (bracket-paste insertion)', () => {
    expect(promptTemplateTargetSessionIdForState(stateWithFocusedTerminal())).toBe('t1')
  })
```

(match the file's existing fixture helpers; the behavioral flip is the point).

- [ ] **Step 5: Run tests**

```bash
npm run test:unit -- src/renderer/src/features/prompt-templates
npm run test:renderer -- src/renderer/src/features/command-palette
npm run check:keybindings
```

Expected: all PASS. If palette tests assert the old draft-only insertion, update them to expect `window.api.sendInput` for terminal targets / `setDraftInput` for composer targets.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/features/prompt-templates src/renderer/src/features/command-palette
git commit -m "feat(session-text): route template insertion through the delivery helper

Terminal panes and agent terminal views become valid template targets;
insertion bracket-pastes without submitting instead of silently doing
nothing. Composer behavior is unchanged (insert modes, no submit).

Refs #830"
```

---

### Task 6: `{{key:Provider/Key}}` template references

**Files:**
- Create: `src/renderer/src/features/prompt-templates/keyReferences.ts`
- Modify: `src/renderer/src/features/command-palette/ui/CommandPalette.tsx` (resolve refs in `executePromptTemplate`)
- Test: `src/renderer/src/features/prompt-templates/keyReferences.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/renderer/src/features/prompt-templates/keyReferences.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { collectKeyReferences, resolveKeyReferences } from '@renderer/features/prompt-templates/keyReferences'

describe('collectKeyReferences', () => {
  it('collects and dedupes references', () => {
    const refs = collectKeyReferences('Use {{key:Brave/main}} and again {{ key:Brave/main }}, plus {{key:OpenAI/prod key}}')
    expect(refs).toEqual([
      { providerName: 'Brave', keyName: 'main' },
      { providerName: 'OpenAI', keyName: 'prod key' },
    ])
  })

  it('ignores ordinary template variables', () => {
    expect(collectKeyReferences('{{name}} and {{ date }}')).toEqual([])
  })
})

describe('resolveKeyReferences', () => {
  it('substitutes resolved values', async () => {
    const resolved = await resolveKeyReferences(
      'Brave key: {{key:Brave/main}}',
      async ref => (ref.providerName === 'Brave' ? 'BSA-1' : null),
    )
    expect(resolved).toBe('Brave key: BSA-1')
  })

  it('aborts loudly on an unresolved reference', async () => {
    await expect(
      resolveKeyReferences('{{key:Brave/nope}}', async () => null),
    ).rejects.toThrow(/Unresolved key reference/)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:unit -- src/renderer/src/features/prompt-templates`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

Create `src/renderer/src/features/prompt-templates/keyReferences.ts`:

```ts
// API Key Vault references inside prompt template bodies (#831).
//
// Syntax: {{key:Provider Name/Key Name}} — matched case-sensitively
// against vault metadata at execution time. WHY names and not ids:
// templates are user-authored text that must stay readable and
// portable; uuids would make every template an opaque pile. Renaming a
// provider or key therefore breaks its references — resolution aborts
// loudly with a toast instead of silently inserting nothing.
//
// WHY this pattern is separate from the ordinary {{variable}} pattern:
// the placeholder grammar is [A-Za-z0-9_]+ only, so these refs never
// collide with or surface as form fields in the fill pane; they are
// resolved BEFORE variable fill.

export type KeyReference = { providerName: string; keyName: string }

const KEY_REF_PATTERN = /\{\{\s*key:([^/{}]+?)\/([^/{}]+?)\s*\}\}/g

export function collectKeyReferences(body: string): KeyReference[] {
  const seen = new Set<string>()
  const ordered: KeyReference[] = []
  for (const match of body.matchAll(KEY_REF_PATTERN)) {
    const ref = { providerName: match[1].trim(), keyName: match[2].trim() }
    const dedupeKey = `${ref.providerName}\u0000${ref.keyName}`
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)
    ordered.push(ref)
  }
  return ordered
}

export async function resolveKeyReferences(
  body: string,
  resolve: (ref: KeyReference) => Promise<string | null>,
): Promise<string> {
  // Resolve every distinct reference out of band first (a synchronous
  // String.replace callback cannot await, and each ref may cross the
  // vault gate), collecting ALL failures so one error message tells the
  // user everything that needs fixing.
  const refs = collectKeyReferences(body)
  const values = new Map<string, string>()
  const failures: string[] = []
  for (const ref of refs) {
    const value = await resolve(ref)
    if (value === null || value.length === 0) {
      failures.push(`{{key:${ref.providerName}/${ref.keyName}}}`)
      continue
    }
    values.set(`${ref.providerName}\u0000${ref.keyName}`, value)
  }
  if (failures.length > 0) {
    throw new Error(`Unresolved key reference: ${failures.join(', ')}`)
  }
  return body.replace(KEY_REF_PATTERN, (_match, rawProvider: string, rawKey: string) => {
    return values.get(`${rawProvider.trim()}\u0000${rawKey.trim()}`) ?? ''
  })
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:unit -- src/renderer/src/features/prompt-templates`
Expected: PASS.

- [ ] **Step 5: Integrate into template execution**

In `src/renderer/src/features/command-palette/ui/CommandPalette.tsx`, inside `executePromptTemplate` immediately after the body is resolved (`const body = template.buildBody ? ... : template.body`) and before the variables check, add:

```ts
        // Vault key references (#831): resolve before variable fill so
        // the fill pane never displays secret values, and abort with a
        // toast on missing refs instead of pasting placeholder text.
        const keyRefs = collectKeyReferences(body)
        if (keyRefs.length > 0) {
          const resolvedRefs = await resolveKeyReferences(body, async ref => {
            try {
              return await window.api.keyVaultResolveReference(ref.providerName, ref.keyName)
            } catch {
              // Locked/canceled/missing all mean "cannot resolve now" —
              // the aggregate error below names the reference.
              return null
            }
          })
          body = resolvedRefs
        }
```

(If `body` is `const`, change its declaration to `let`.) Add the imports:

```ts
import { collectKeyReferences, resolveKeyReferences } from '@renderer/features/prompt-templates/keyReferences'
```

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/features/prompt-templates src/renderer/src/features/command-palette
git commit -m "feat(vault): resolve key references in prompt templates

{{key:Provider/Key}} refs resolve against the gated vault before
variable fill; missing or locked refs abort insertion with a toast
naming every failure. Names over ids keep templates readable.

Refs #831"
```

---

### Task 7: Vault UI (uiShell state, command, surface, modal)

**Files:**
- Modify: `src/renderer/src/app-state/uiShell/types.ts` (+ `keyVaultOpen`)
- Modify: `src/renderer/src/app-state/uiShell/slice.ts` (+ default + `openKeyVault`/`closeKeyVault`)
- Modify: `src/renderer/src/features/command-palette/types.ts` (+ `openKeyVault` on the ui context type, next to `openUsageModal`)
- Modify: `src/renderer/src/features/command-palette/ui/CommandPalette.tsx` (selector + two ui object entries)
- Create: `src/renderer/src/features/key-vault/commands/keyVaultCommands.ts`
- Modify: `src/renderer/src/features/command-palette/catalog.ts` (import + spread)
- Create: `src/renderer/src/features/key-vault/ui/KeyVaultModal.tsx`
- Create: `src/renderer/src/features/key-vault/surfaces/KeyVaultModalSurface.tsx`
- Modify: `src/renderer/src/app/surfaces/registry.tsx` (append modal entry)

- [ ] **Step 1: uiShell state**

In `src/renderer/src/app-state/uiShell/types.ts`, add to `UiShellState` (near `usageModalOpen`):

```ts
  /** When true, the API Key Vault modal is open (#831). Transient command
   *  chrome, not workspace data — same rationale as usageModalOpen. */
  keyVaultOpen: boolean
```

In `src/renderer/src/app-state/uiShell/slice.ts`, add the default next to `usageModalOpen: false,`:

```ts
  keyVaultOpen: false,
```

and the actions next to `openUsageModal`/`closeUsageModal` (mirror their exact shape):

```ts
  openKeyVault: () =>
    set({ keyVaultOpen: true }, false, 'uiShell/openKeyVault'),
  closeKeyVault: () =>
    set({ keyVaultOpen: false }, false, 'uiShell/closeKeyVault'),
```

- [ ] **Step 2: Command palette ui plumbing**

In `src/renderer/src/features/command-palette/types.ts`, next to `openUsageModal: () => void` (line ~210), add:

```ts
    openKeyVault: () => void
```

In `src/renderer/src/features/command-palette/ui/CommandPalette.tsx`:

1. Next to `const openUsageModal = useAppStore(state => state.openUsageModal)` (~line 294):

```ts
  const openKeyVault = useAppStore(state => state.openKeyVault)
```

2. Add `openKeyVault,` to BOTH ui context object literals that contain `openUsageModal,` (~lines 630 and 738).

- [ ] **Step 3: The command**

Create `src/renderer/src/features/key-vault/commands/keyVaultCommands.ts`:

```ts
import type { CommandDef } from '@renderer/features/command-palette/types'

export const keyVaultCommands: CommandDef[] = [
  {
    id: 'api-key-vault',
    category: 'workspace-tools',
    surface: 'app',
    title: 'API Key Vault…',
    description:
      '**What it does:** Opens the **API Key Vault** — manage provider API keys, insert them into the focused pane, copy to clipboard, and reference them from prompt templates (`{{key:Provider/Key}}`).\n\n**Use when:** You regularly paste API keys (Brave, OpenAI, …) into agent prompts.\n\n**Notes:** Encrypted with the OS keyring; one Touch ID / password unlock per app launch.',
    keywords: ['api', 'key', 'vault', 'secret', 'credential', 'token', 'password'],
    run: ({ ui }) => {
      ui.openKeyVault()
    },
  },
]
```

In `src/renderer/src/features/command-palette/catalog.ts`, add the import next to `promptTemplateCommands`:

```ts
import { keyVaultCommands } from '@renderer/features/key-vault/commands/keyVaultCommands'
```

and spread it into the command list next to `...promptTemplateCommands,`:

```ts
  ...keyVaultCommands,
```

- [ ] **Step 4: The modal**

Create `src/renderer/src/features/key-vault/ui/KeyVaultModal.tsx`:

```tsx
import { useCallback, useEffect, useState } from 'react'

import { useAppStore } from '@renderer/app-state/hooks'
import { deliverTextToSession } from '@renderer/features/session-text-delivery/deliverTextToSession'
import { commandTargetSessionId } from '@renderer/workspace/hook/selectors/commandTargetSessionId'
import { useWorkspace } from '@renderer/workspace/workspaceStore'
import type { KeyVaultKey, KeyVaultStatus } from '@shared/types/keyVault'

// API Key Vault modal (#831). Revealed plaintext lives ONLY in this
// component's state — never in the persisted app store, never in a
// journal — and is dropped on close. Metadata comes and goes through
// window.api.keyVault* calls; every secret fetch crosses the main-side
// unlock gate (one OS prompt per app run).

type KeyForm = { id?: string; name: string; value: string; note: string } | null

export function KeyVaultModal() {
  const closeKeyVault = useAppStore(state => state.closeKeyVault)
  const workspace = useWorkspace()
  const [status, setStatus] = useState<KeyVaultStatus | null>(null)
  const [providers, setProviders] = useState<{ id: string; name: string }[]>([])
  const [keys, setKeys] = useState<KeyVaultKey[]>([])
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null)
  // keyId -> revealed plaintext. Ephemeral by design.
  const [revealed, setRevealed] = useState<Map<string, string>>(new Map())
  const [newProviderName, setNewProviderName] = useState('')
  const [keyForm, setKeyForm] = useState<KeyForm>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [nextStatus, snapshot] = await Promise.all([
        window.api.keyVaultStatus(),
        window.api.keyVaultList(),
      ])
      setStatus(nextStatus)
      setProviders(snapshot.providers)
      setKeys(snapshot.keys)
      setSelectedProviderId(current => {
        if (current && snapshot.providers.some(p => p.id === current)) return current
        return snapshot.providers[0]?.id ?? null
      })
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => {
    // Drop all plaintext the moment the modal closes.
    return () => setRevealed(new Map())
  }, [])

  const runVaultAction = async (action: () => Promise<void>) => {
    try {
      await action()
      await refresh()
      setError(null)
    } catch (err) {
      // Canceled OS prompt, fail-closed gate, duplicate name, … — the
      // service messages are written for direct display.
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const addProvider = () => {
    const name = newProviderName.trim()
    if (!name) return
    setNewProviderName('')
    void runVaultAction(async () => {
      const provider = await window.api.keyVaultCreateProvider(name)
      setSelectedProviderId((await window.api.keyVaultList()).providers.find(p => p.name === name)?.id ?? provider.id)
    })
  }

  const saveKeyForm = () => {
    const form = keyForm
    if (!form || !selectedProviderId) return
    setKeyForm(null)
    void runVaultAction(() => window.api.keyVaultPutKey({
      providerId: selectedProviderId,
      id: form.id,
      name: form.name,
      value: form.value,
      note: form.note,
    }))
  }

  const toggleReveal = async (key: KeyVaultKey) => {
    if (revealed.has(key.id)) {
      const next = new Map(revealed)
      next.delete(key.id)
      setRevealed(next)
      return
    }
    try {
      const value = await window.api.keyVaultReveal(key.providerId, key.id)
      setRevealed(prev => new Map(prev).set(key.id, value))
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const insertKey = async (key: KeyVaultKey) => {
    const sessionId = commandTargetSessionId(workspace)
    if (!sessionId) {
      setError('No focused pane to insert into')
      return
    }
    try {
      const value = revealed.get(key.id) ?? await window.api.keyVaultReveal(key.providerId, key.id)
      const result = await deliverTextToSession(workspace, sessionId, value)
      if (result.delivered) {
        workspace.showPaneToast(sessionId, `Inserted key: ${key.name}`)
        closeKeyVault()
      } else {
        setError('Focused pane is no longer available')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const selectedKeys = keys.filter(k => k.providerId === selectedProviderId)
  const selectedProvider = providers.find(p => p.id === selectedProviderId) ?? null

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center"
      onMouseDown={e => { if (e.target === e.currentTarget) closeKeyVault() }}
    >
      <div className="w-[760px] max-w-[92vw] max-h-[82vh] flex flex-col border border-border bg-canvas rounded-lg shadow-xl font-code text-sm">
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-border bg-surface">
          <div className="flex items-center gap-3 min-w-0">
            <span className="text-ink font-semibold">API Key Vault</span>
            {status && (
              <span className={`text-[10px] uppercase tracking-wider rounded-chip px-1.5 py-0.5 border ${
                status.unlocked ? 'border-current/40 text-ink' : 'border-border text-muted'
              }`}>
                {status.unlocked ? 'unlocked' : 'locked'}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {status?.unlocked && (
              <button
                className="text-[11px] text-muted hover:text-ink px-2 py-1 rounded-chip border border-border"
                onClick={() => void runVaultAction(() => window.api.keyVaultLock())}
              >
                Lock now
              </button>
            )}
            <button className="text-muted hover:text-ink px-2 py-1" onClick={closeKeyVault}>✕</button>
          </div>
        </div>

        {status && !status.encryptionAvailable && (
          <div className="px-4 py-2 text-[11px] text-ink bg-surface border-b border-border">
            OS keyring (safeStorage) is unavailable on this machine — keys cannot be stored.
          </div>
        )}
        {error && (
          <div className="px-4 py-2 text-[11px] text-ink bg-surface border-b border-border">{error}</div>
        )}

        <div className="flex flex-1 min-h-0">
          <div className="w-48 border-r border-border overflow-y-auto p-2 flex flex-col gap-1">
            {providers.map(provider => (
              <button
                key={provider.id}
                className={`text-left px-2 py-1 rounded-chip truncate ${
                  provider.id === selectedProviderId ? 'bg-surface text-ink' : 'text-muted hover:text-ink'
                }`}
                onClick={() => setSelectedProviderId(provider.id)}
                title={provider.name}
              >
                {provider.name}
              </button>
            ))}
            <div className="flex gap-1 mt-2">
              <input
                className="flex-1 min-w-0 bg-surface border border-border rounded-chip px-2 py-1 text-xs"
                placeholder="New provider…"
                value={newProviderName}
                onChange={e => setNewProviderName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') addProvider() }}
              />
            </div>
          </div>

          <div className="flex-1 min-w-0 overflow-y-auto p-3 flex flex-col gap-2">
            {!selectedProvider && <div className="text-muted text-xs">Create a provider to get started.</div>}
            {selectedProvider && (
              <>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-ink font-semibold">{selectedProvider.name}</span>
                  <div className="flex gap-2">
                    <button
                      className="text-[11px] text-muted hover:text-ink"
                      onClick={() => {
                        const name = window.prompt('Rename provider', selectedProvider.name)
                        if (name && name.trim()) void runVaultAction(() => window.api.keyVaultRenameProvider(selectedProvider.id, name))
                      }}
                    >
                      Rename
                    </button>
                    <button
                      className="text-[11px] text-muted hover:text-ink"
                      onClick={() => {
                        if (window.confirm(`Delete provider "${selectedProvider.name}" and all its keys?`)) {
                          void runVaultAction(() => window.api.keyVaultDeleteProvider(selectedProvider.id))
                        }
                      }}
                    >
                      Delete
                    </button>
                    <button
                      className="text-[11px] text-ink border border-border rounded-chip px-2 py-0.5"
                      onClick={() => setKeyForm({ name: '', value: '', note: '' })}
                    >
                      + New Key
                    </button>
                  </div>
                </div>

                {selectedKeys.map(key => (
                  <div key={key.id} className="border border-border rounded-chip p-2 flex flex-col gap-1 bg-surface">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-ink truncate">{key.name}</span>
                      <span className="text-[10px] text-muted">••••{key.hint}</span>
                      {revealed.has(key.id) && (
                        <span className="text-[10px] text-ink truncate max-w-[220px]" title={revealed.get(key.id)}>
                          {revealed.get(key.id)}
                        </span>
                      )}
                      <span className="flex-1" />
                      <button className="text-[11px] text-muted hover:text-ink" onClick={() => void toggleReveal(key)}>
                        {revealed.has(key.id) ? 'Hide' : 'Reveal'}
                      </button>
                      <button
                        className="text-[11px] text-muted hover:text-ink"
                        onClick={() => void runVaultAction(() => window.api.keyVaultCopyKey(key.providerId, key.id))}
                      >
                        Copy
                      </button>
                      <button className="text-[11px] text-ink" onClick={() => void insertKey(key)}>Insert</button>
                      <button
                        className="text-[11px] text-muted hover:text-ink"
                        onClick={() => setKeyForm({ id: key.id, name: key.name, value: '', note: key.note })}
                      >
                        Edit
                      </button>
                      <button
                        className="text-[11px] text-muted hover:text-ink"
                        onClick={() => {
                          if (window.confirm(`Delete key "${key.name}"?`)) {
                            void runVaultAction(() => window.api.keyVaultDeleteKey(key.providerId, key.id))
                          }
                        }}
                      >
                        Delete
                      </button>
                    </div>
                    {key.note && <div className="text-[10px] text-muted truncate">{key.note}</div>}
                  </div>
                ))}

                {keyForm && (
                  <div className="border border-border rounded-chip p-3 flex flex-col gap-2 bg-surface">
                    <div className="text-xs text-ink">{keyForm.id ? `Edit key` : 'New key'}</div>
                    <input
                      className="bg-canvas border border-border rounded-chip px-2 py-1"
                      placeholder="Key name (e.g. main)"
                      value={keyForm.name}
                      onChange={e => setKeyForm({ ...keyForm, name: e.target.value })}
                    />
                    <input
                      className="bg-canvas border border-border rounded-chip px-2 py-1"
                      type="password"
                      placeholder={keyForm.id ? 'Value (leave blank to keep current)' : 'Value'}
                      value={keyForm.value}
                      onChange={e => setKeyForm({ ...keyForm, value: e.target.value })}
                    />
                    <input
                      className="bg-canvas border border-border rounded-chip px-2 py-1"
                      placeholder="Note (optional)"
                      value={keyForm.note}
                      onChange={e => setKeyForm({ ...keyForm, note: e.target.value })}
                    />
                    <div className="flex gap-2 justify-end">
                      <button className="text-[11px] text-muted px-2" onClick={() => setKeyForm(null)}>Cancel</button>
                      <button
                        className="text-[11px] text-ink border border-border rounded-chip px-3 py-1"
                        onClick={saveKeyForm}
                      >
                        Save
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        <div className="px-4 py-2 border-t border-border text-[10px] text-muted">
          Reference keys from prompt templates with {'{{key:Provider/Key}}'} · Encrypted with the OS keyring · One unlock per app launch
        </div>
      </div>
    </div>
  )
}
```

Note: match the styling vocabulary of neighboring modals (check `UsageModal.tsx` / `BuryPanePrompt.tsx`) and adjust class names to whatever the codebase's current primitives are — the structure and behaviors above are the contract.

- [ ] **Step 5: The surface wrapper + registry**

Create `src/renderer/src/features/key-vault/surfaces/KeyVaultModalSurface.tsx`:

```tsx
import { useAppStore } from '@renderer/app-state/hooks'
import { KeyVaultModal } from '@renderer/features/key-vault/ui/KeyVaultModal'

export function KeyVaultModalSurface() {
  const open = useAppStore(state => state.keyVaultOpen)
  if (!open) return null
  return <KeyVaultModal />
}
```

In `src/renderer/src/app/surfaces/registry.tsx`, add the import:

```ts
import { KeyVaultModalSurface } from '@renderer/features/key-vault/surfaces/KeyVaultModalSurface'
```

and append at the END of `modalSurfaces` (per the registry contract — new modals append so sibling order cannot move an established surface):

```ts
  { id: 'key-vault', Component: KeyVaultModalSurface },
```

- [ ] **Step 6: Verify**

```bash
npm run typecheck
npm run test:renderer -- src/renderer/src/features/command-palette
npm run check:keybindings
```

Expected: PASS (new command may extend the keybinding baseline; if `check:keybindings` reports the new command, follow its printed remediation).

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/app-state src/renderer/src/features/key-vault src/renderer/src/features/command-palette src/renderer/src/app/surfaces
git commit -m "feat(vault): add api key vault command and modal

App-surface palette command opens the vault modal: provider/key CRUD,
reveal/copy/insert actions, lock-now, and an explicit unavailable-keyring
notice. Revealed plaintext stays in ephemeral component state only.

Refs #831"
```

---

### Task 8: Final verification pass

**Files:** none (verification only).

- [ ] **Step 1: Full check suite**

```bash
npm run typecheck
npm test
npm run check:keybindings
npm run test:contract
```

Expected: all green. Fix anything that surfaces; each fix is its own commit (`fix(vault): …` / `fix(session-text): …`).

- [ ] **Step 2: Manual smoke test**

```bash
npm run dev
```

1. Cmd+P → “API Key Vault” → create provider “Brave” → add key “main” → confirm the Touch ID / password prompt appears on first Reveal.
2. Focus a Claude pane → Insert → key lands in the composer draft unsubmitted.
3. Open a plain terminal pane → Insert → key lands as one bracketed paste, no execution.
4. Create a custom template `My Brave key is {{key:Brave/main}}` → run Prompt Template in the terminal pane → resolved key pastes; a bad ref toasts the failure.
5. Cancel the OS prompt once → confirm nothing is revealed and the error line explains it.

- [ ] **Step 3: Report state**

Per conventions: report final state, leave branch clean, open the PR fully built out (implementation + tests + spec), link `Refs #830` / `Refs #831`, and wait for explicit confirmation before any merge.
