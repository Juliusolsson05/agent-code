import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DeviceRegistry } from './deviceRegistry.js'

let dir: string
let file: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'remote-devices-'))
  file = join(dir, 'devices.json')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('DeviceRegistry', () => {
  it('creates devices with unique ids and lists them', async () => {
    const registry = new DeviceRegistry(file)
    await registry.load()
    const a = await registry.create('Julius iPhone')
    const b = await registry.create('iPad')
    expect(a.deviceId).not.toBe(b.deviceId)
    expect(registry.list().map(d => d.name)).toEqual(['Julius iPhone', 'iPad'])
  })

  it('persists across a reload (fresh instance, same file)', async () => {
    const first = new DeviceRegistry(file)
    await first.load()
    const created = await first.create('Julius iPhone')

    const second = new DeviceRegistry(file)
    await second.load()
    expect(second.get(created.deviceId)?.name).toBe('Julius iPhone')
  })

  it('revokes a device durably', async () => {
    const registry = new DeviceRegistry(file)
    await registry.load()
    const device = await registry.create('lost phone')
    expect(await registry.revoke(device.deviceId)).toBe(true)
    expect(registry.get(device.deviceId)?.revoked).toBe(true)

    const reloaded = new DeviceRegistry(file)
    await reloaded.load()
    expect(reloaded.get(device.deviceId)?.revoked).toBe(true)
    // Revoking an unknown id reports false rather than throwing — the
    // desktop UI treats it as already-gone.
    expect(await registry.revoke('nope')).toBe(false)
  })

  it('tolerates a missing file and a corrupt file (starts empty)', async () => {
    const registry = new DeviceRegistry(file)
    await registry.load()
    expect(registry.list()).toEqual([])

    const corrupt = new DeviceRegistry(file)
    await registry.create('x')
    const raw = await readFile(file, 'utf8')
    expect(raw).toContain('"devices"')
    // Corrupt the file, then load a fresh instance: it must not throw and
    // must not resurrect ghosts.
    await rm(file)
    await corrupt.load()
    expect(corrupt.list()).toEqual([])
  })
})
