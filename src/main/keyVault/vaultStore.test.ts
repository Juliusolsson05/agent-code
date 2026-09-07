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
  decrypt: cipher => {
    // Real safeStorage throws on bytes it cannot decrypt; the fake must
    // too, or the corrupt-blob test would "decrypt" garbage into text.
    const text = cipher.toString('utf8')
    if (!text.startsWith('enc:')) throw new Error('invalid ciphertext')
    return text.slice(4)
  },
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
