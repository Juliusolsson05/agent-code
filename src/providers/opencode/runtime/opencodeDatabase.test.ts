import { afterEach, expect, it, vi } from 'vitest'
import type { OpencodeStore } from 'opencode-terminal-headless'
import { createOpencodeDatabase, type OpencodeDatabase } from './opencodeDatabase.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
const databases: OpencodeDatabase[] = []
afterEach(() => { for (const database of databases.splice(0)) database.release() })

it.each(['resolve', 'reject'] as const)('discards an old open that completes by %s without clobbering a newer one', async outcome => {
  const old = deferred<string>()
  const next = deferred<string>()
  const latest = { release: vi.fn() } as unknown as OpencodeStore
  const openStore = vi.fn(() => latest)
  const resolveDbPath = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise)
  const database = createOpencodeDatabase({ resolveDbPath, openStore })
  databases.push(database)
  const stale = database.store()
  const rejected = expect(stale).rejects.toThrow()
  database.release()
  const current = database.store()
  if (outcome === 'resolve') old.resolve('/old.db')
  else old.reject(new Error('old resolution failed'))
  await rejected
  const concurrent = database.store()
  expect(resolveDbPath).toHaveBeenCalledTimes(2)
  next.resolve('/current.db')
  await expect(current).resolves.toBe(latest)
  await expect(concurrent).resolves.toBe(latest)
  expect(openStore).toHaveBeenCalledExactlyOnceWith('/current.db')
  database.release()
  database.release()
  expect(latest.release).toHaveBeenCalledOnce()
})

it('does not acquire a store when release precedes path resolution', async () => {
  const path = deferred<string>()
  const openStore = vi.fn()
  const database = createOpencodeDatabase({ resolveDbPath: () => path.promise, openStore })
  databases.push(database)
  const pending = database.store()
  const rejected = expect(pending).rejects.toMatchObject({ code: 'open_failed' })
  database.release()
  path.resolve('/released.db')
  await rejected
  expect(openStore).not.toHaveBeenCalled()
})

it('releases a store if opening itself re-enters release', async () => {
  const store = { release: vi.fn() } as unknown as OpencodeStore
  const database = createOpencodeDatabase({ resolveDbPath: async () => '/reentrant.db', openStore: () => {
    database.release()
    return store
  } })
  databases.push(database)
  await expect(database.store()).rejects.toMatchObject({ code: 'open_failed' })
  expect(store.release).toHaveBeenCalledOnce()
})

it('keeps the newer opened store when an older path resolves last', async () => {
  const old = deferred<string>()
  const current = { release: vi.fn() } as unknown as OpencodeStore
  const resolveDbPath = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce('/current.db')
  const openStore = vi.fn(() => current)
  const database = createOpencodeDatabase({ resolveDbPath, openStore })
  databases.push(database)
  const pending = database.store()
  const rejected = expect(pending).rejects.toMatchObject({ code: 'open_failed' })
  database.release()
  await expect(database.store()).resolves.toBe(current)
  old.resolve('/stale.db')
  await rejected
  await expect(database.store()).resolves.toBe(current)
  expect(openStore).toHaveBeenCalledExactlyOnceWith('/current.db')
})
