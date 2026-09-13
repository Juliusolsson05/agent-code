import { mkdtemp, mkdir, open, readFile, readdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const stateRoot = await mkdtemp(join(tmpdir(), 'agent-code-extension-storage-'))
vi.mock('@main/storage/paths.js', () => ({ EXTENSION_STATE_DIR: stateRoot }))
const fault = vi.hoisted(() => ({ rename: false }))
vi.mock('fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('fs/promises')>()
  return { ...fs, rename: async (...args: Parameters<typeof fs.rename>) => {
    if (fault.rename) { fault.rename = false; throw new Error('fixture publication failed') }
    return fs.rename(...args)
  } }
})
const { extensionStorageGet: get, extensionStorageSet: set, extensionStorageDelete: remove, extensionStorageKeys: keys } = await import('./storage.js')
const stateFile = () => join(stateRoot, 'counter', 'state.json')
beforeEach(async () => { fault.rename = false; await rm(stateRoot, { recursive: true, force: true }); await mkdir(join(stateRoot, 'counter'), { recursive: true }) })
afterAll(async () => { await rm(stateRoot, { recursive: true, force: true }) })

describe('durable extension storage', () => {
  it('orders concurrent changes and reads without losing another key or namespace', async () => {
    await Promise.all([set('counter', 'a', 1), set('counter', 'b', 2), set('other', 'a', 9)])
    const writing = set('counter', 'a', 3)
    const [observed] = await Promise.all([get('counter', 'a'), writing])
    expect(observed).toBe(3)
    await remove('counter', 'b')
    expect(await keys('counter')).toEqual(['a'])
    expect(await get('other', 'a')).toBe(9)
  })

  it('captures the caller value before a queued write can observe later mutation', async () => {
    const value = { nested: [1] }
    const writing = set('counter', 'value', value)
    value.nested.push(2)
    await writing
    expect(await get('counter', 'value')).toEqual({ nested: [1] })
  })

  it.each(['{broken', '[]', 'null', '{"value":1e999}'])('preserves malformed saved data instead of replacing it: %s', async raw => {
    await writeFile(stateFile(), raw)
    await expect(get('counter', 'value')).rejects.toThrow(/storage/i)
    await expect(set('counter', 'new', 1)).rejects.toThrow(/storage/i)
    await expect(remove('counter', 'old')).rejects.toThrow(/storage/i)
    expect(await readFile(stateFile(), 'utf8')).toBe(raw)
  })

  it('treats only an absent file as empty; inaccessible/non-file state is an error', async () => {
    expect(await get('counter', 'value')).toBeUndefined()
    await mkdir(stateFile())
    await expect(set('counter', 'value', 1)).rejects.toThrow()
    expect(await readdir(stateFile())).toEqual([])
  })

  it('preserves invalid UTF-8 instead of silently persisting replacement characters', async () => {
    const damaged = Buffer.concat([Buffer.from('{"value":"'), Buffer.from([0xff]), Buffer.from('"}')])
    await writeFile(stateFile(), damaged)
    await expect(set('counter', 'next', 1)).rejects.toThrow(/storage.*UTF-8/)
    expect(await readFile(stateFile())).toEqual(damaged)
  })

  it('rejects an oversized sparse state file without replacing it', async () => {
    const file = await open(stateFile(), 'w')
    try { await file.truncate(2 * 1024 * 1024) } finally { await file.close() }
    await expect(get('counter', 'value')).rejects.toThrow(/storage.*limit/i)
    await expect(set('counter', 'value', 1)).rejects.toThrow(/storage.*limit/i)
    const unchanged = await open(stateFile(), 'r')
    try { expect((await unchanged.stat()).size).toBe(2 * 1024 * 1024) } finally { await unchanged.close() }
  })

  it('refuses values outside bounded JSON and unsafe keys without changing saved bytes', async () => {
    await set('counter', 'saved', 1)
    const before = await readFile(stateFile(), 'utf8')
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic
    for (const value of [NaN, Infinity, undefined, () => {}, BigInt(1), new Date(), cyclic, 'x'.repeat(128 * 1024 + 1)]) {
      await expect(set('counter', 'value', value)).rejects.toThrow(/JSON/)
    }
    for (const key of ['', '__proto__', 'constructor', 'prototype', 'x'.repeat(257)]) {
      await expect(set('counter', key, 1)).rejects.toThrow(/key/)
      await expect(get('counter', key)).rejects.toThrow(/key/)
      await expect(remove('counter', key)).rejects.toThrow(/key/)
    }
    expect(await readFile(stateFile(), 'utf8')).toBe(before)
  })

  it('rejects total storage and key-count overflow while retaining the previous snapshot', async () => {
    // Construct realistic saved snapshots directly: writing hundreds of keys one
    // by one measures filesystem throughput rather than the admission boundary.
    const full = Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`key${i}`, i]))
    await writeFile(stateFile(), JSON.stringify(full))
    await expect(set('counter', 'overflow', 1)).rejects.toThrow(/storage.*limit/i)
    expect(await keys('counter')).toHaveLength(256)
    await set('counter', 'key0', 99)
    await remove('counter', 'key1')
    await set('counter', 'replacement', 1)
    const large = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`key${i}`, 'x'.repeat(128 * 1024)]))
    await writeFile(stateFile(), JSON.stringify(large))
    const before = await readFile(stateFile(), 'utf8')
    await expect(set('counter', 'overflow', 'x'.repeat(128 * 1024))).rejects.toThrow(/storage.*limit/i)
    expect(await readFile(stateFile(), 'utf8')).toBe(before)
  })

  it('cleans failed publication residue, retains old data, and accepts the next operation', async () => {
    await set('counter', 'saved', 1)
    fault.rename = true
    await expect(set('counter', 'saved', 2)).rejects.toThrow('fixture publication failed')
    expect(await readdir(join(stateRoot, 'counter'))).toEqual(['state.json'])
    expect(await get('counter', 'saved')).toBe(1)
    await set('counter', 'next', 3)
    expect(await get('counter', 'next')).toBe(3)
  })

  it('bounds queued work and accepts new calls after a burst drains', async () => {
    const calls = await Promise.allSettled(Array.from({ length: 40 }, (_, i) => set('counter', `key${i}`, i)))
    expect(calls.filter(result => result.status === 'fulfilled')).toHaveLength(32)
    expect(calls.filter(result => result.status === 'rejected')).toHaveLength(8)
    await set('counter', 'after', 99)
    expect(await get('counter', 'after')).toBe(99)
  })

  it('bounds cross-namespace admission and releases it after successful and failed reads', async () => {
    const calls = await Promise.allSettled(Array.from({ length: 288 }, (_, i) => get(`app-${Math.floor(i / 32)}`, 'value')))
    expect(calls.filter(result => result.status === 'fulfilled')).toHaveLength(256)
    expect(calls.filter(result => result.status === 'rejected')).toHaveLength(32)
    await writeFile(stateFile(), '{broken')
    await expect(get('counter', 'value')).rejects.toThrow(/storage/i)
    await rm(stateFile())
    await expect(get('counter', 'toString')).resolves.toBeUndefined()
    await set('counter', 'toString', 'own value')
    expect(await get('counter', 'toString')).toBe('own value')
  })
})
