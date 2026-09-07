import { beforeEach, describe, expect, it, vi } from 'vitest'

import { VaultService, type VaultServiceDeps } from '@main/keyVault/VaultService.js'
import type { VaultStore } from '@main/keyVault/vaultStore.js'
import type { KeyVaultSnapshot } from '@shared/types/keyVault'

// In-memory store: the file layer has its own tests (vaultStore.test.ts);
// these tests pin the SERVICE rules — gate semantics, ordering, and
// fail-closed behavior.
function makeStore(): VaultStore {
  const snapshot: KeyVaultSnapshot = { providers: [], keys: [] }
  const secrets = new Map<string, string>()
  return {
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

  it('deleting a provider removes its keys from the index', async () => {
    await service.putKey({ providerId, name: 'main', value: 'x', note: '' })
    await service.deleteProvider(providerId)
    const list = await service.list()
    expect(list.providers).toEqual([])
    expect(list.keys).toEqual([])
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
