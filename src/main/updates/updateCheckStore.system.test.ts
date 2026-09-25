import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

// The real store over a real temporary state directory: the property under
// test is what is on DISK after interleaved writes, which a mocked fs could
// not show.
const stateDir = mkdtempSync(join(tmpdir(), 'update-store-'))
vi.mock('@main/storage/paths.js', () => ({ STATE_DIR: stateDir }))
afterAll(() => rmSync(stateDir, { recursive: true, force: true }))

const { UpdateCheckStore } = await import('./updateCheckStore.js')
const file = () => JSON.parse(readFileSync(join(stateDir, 'updates.json'), 'utf8'))

describe('UpdateCheckStore', () => {
  it('keeps the LAST channel the user chose when writes overlap (review round 1 of #1168)', async () => {
    const store = new UpdateCheckStore()
    await Promise.all([
      store.writeChannel('preview'),
      store.write(1_000),
      store.writeChannel('stable'),
    ])
    expect(file()).toEqual({ lastCheckAt: 1_000, channel: 'stable' })
    const reopened = new UpdateCheckStore()
    await reopened.ready()
    expect(reopened.readChannel()).toBe('stable')
    expect(reopened.read()).toBe(1_000)
  })

  it('reads an unknown channel as "not chosen", keeping the check clock', async () => {
    writeFileSync(join(stateDir, 'updates.json'), JSON.stringify({ lastCheckAt: 5, channel: 'nightly' }))
    const store = new UpdateCheckStore()
    await store.ready()
    expect(store.readChannel()).toBeUndefined()
    expect(store.read()).toBe(5)
  })

  it('a choice made before the file finished loading is not replaced by the older one on disk', async () => {
    writeFileSync(join(stateDir, 'updates.json'), JSON.stringify({ lastCheckAt: 5, channel: 'preview' }))
    const store = new UpdateCheckStore()
    const write = store.writeChannel('stable') // before ready()
    await write
    expect(store.readChannel()).toBe('stable')
    expect(file().channel).toBe('stable')
  })
})
