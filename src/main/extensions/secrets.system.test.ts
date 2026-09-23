import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { SecretCodec } from '@main/keyVault/vaultStore.js'
import { createExtensionSecretStore, MAX_SECRET_KEYS_PER_EXTENSION, removeExtensionSecrets } from './secrets.js'

// Real files in a temp root; only the OS keychain is faked. The codec below
// reverses bytes so a test can prove the file on disk is NOT the plaintext —
// the property safeStorage provides in production.
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function store(overrides: Partial<SecretCodec> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'agent-code-extension-secrets-'))
  roots.push(root)
  const codec: SecretCodec = {
    isEncryptionAvailable: () => true,
    encrypt: plain => Buffer.from(plain, 'utf8').reverse(),
    decrypt: cipher => Buffer.from(cipher).reverse().toString('utf8'),
    ...overrides,
  }
  return { root, secrets: createExtensionSecretStore(codec, root) }
}

const KEY = 'sk_live_extension_secret_value'

describe('per-extension secret store', () => {
  it('round-trips through encrypted per-key files that only the owning extension id addresses', async () => {
    const { root, secrets } = await store()
    await secrets.set('poker', 'elevenlabs.apiKey', KEY)
    await expect(secrets.get('poker', 'elevenlabs.apiKey')).resolves.toBe(KEY)
    await expect(secrets.get('timer', 'elevenlabs.apiKey')).resolves.toBeNull()
    const files = await readdir(join(root, 'poker'))
    expect(files).toHaveLength(1)
    const raw = await readFile(join(root, 'poker', files[0]))
    expect(raw.toString('utf8')).not.toContain(KEY)
    expect((await stat(join(root, 'poker', files[0]))).mode & 0o777).toBe(0o600)
    await secrets.delete('poker', 'elevenlabs.apiKey')
    await expect(secrets.get('poker', 'elevenlabs.apiKey')).resolves.toBeNull()
  })

  it('refuses to store anything when the OS cannot encrypt — never a plaintext fallback', async () => {
    const { root, secrets } = await store({ isEncryptionAvailable: () => false })
    const error = await secrets.set('poker', 'elevenlabs.apiKey', KEY).then(() => null, (reason: Error) => reason)
    expect(error?.message).toMatch(/Secure storage is unavailable/)
    expect(error?.message).not.toContain(KEY)
    await expect(readdir(root)).resolves.toEqual([])
  })

  it('reads an undecryptable blob (keychain reset) as absent instead of throwing', async () => {
    const { root, secrets } = await store()
    await secrets.set('poker', 'token', KEY)
    const afterReset = createExtensionSecretStore({
      isEncryptionAvailable: () => true,
      encrypt: plain => Buffer.from(plain),
      decrypt: () => { throw new Error('keychain item changed') },
    }, root)
    await expect(afterReset.get('poker', 'token')).resolves.toBeNull()
  })

  it('enforces key grammar, value bounds and the per-extension key limit without echoing values', async () => {
    const { secrets } = await store()
    for (const key of ['', 'has space', 'x'.repeat(65), 'slash/key']) {
      await expect(secrets.set('poker', key, 'v')).rejects.toThrow(/Secret keys/)
    }
    const oversized = `${KEY}${'x'.repeat(4096)}`
    const error = await secrets.set('poker', 'big', oversized).then(() => null, (reason: Error) => reason)
    expect(error?.message).toMatch(/1-4096/)
    expect(error?.message).not.toContain(KEY)
    await Promise.all(Array.from({ length: MAX_SECRET_KEYS_PER_EXTENSION }, (_, i) => secrets.set('poker', `k${i}`, 'v')))
    await expect(secrets.set('poker', 'one-more', 'v')).rejects.toThrow(/at most/)
    // Replacing an existing key is not a new key.
    await expect(secrets.set('poker', 'k0', 'v2')).resolves.toBeUndefined()
  })

  it('keeps "." and ".." keys and case variants inside distinct files (hex names)', async () => {
    const { root, secrets } = await store()
    await secrets.set('poker', '..', 'dots')
    await secrets.set('poker', 'Token', 'upper')
    await secrets.set('poker', 'token', 'lower')
    await expect(secrets.get('poker', '..')).resolves.toBe('dots')
    await expect(secrets.get('poker', 'Token')).resolves.toBe('upper')
    await expect(secrets.get('poker', 'token')).resolves.toBe('lower')
    await expect(readdir(root)).resolves.toEqual(['poker'])
  })

  it('deletes an extension\'s secrets on uninstall and refuses a traversal id', async () => {
    const { root, secrets } = await store()
    await secrets.set('poker', 'token', KEY)
    await secrets.set('timer', 'token', 'other')
    await removeExtensionSecrets('poker', root)
    await expect(secrets.get('poker', 'token')).resolves.toBeNull()
    await expect(secrets.get('timer', 'token')).resolves.toBe('other')
    await expect(removeExtensionSecrets('../escape', root)).rejects.toThrow(/Invalid extension id/)
  })
})
