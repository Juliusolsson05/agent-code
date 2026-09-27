import { expect, it } from 'vitest'

import { Storage } from 'happy-dom'

import { installWorkingStorage } from '../setup/storage'

// #1212: Node 25's default Web Storage is a placeholder without `clear` that
// returns undefined on read. CI runs Node 24, where the real global is fine,
// so this pins the repair against a stand-in with Node 25's shape.
it('replaces a storage without clear by a working DOM Storage', () => {
  const target = { localStorage: { getItem: () => undefined }, sessionStorage: {} }
  expect(installWorkingStorage(target)).toEqual(['localStorage', 'sessionStorage'])
  const storage = (target as unknown as { localStorage: Storage }).localStorage
  storage.setItem('k', 'v')
  expect(storage.getItem('k')).toBe('v')
  storage.clear()
  expect(storage.length).toBe(0)
})

it('leaves happy-dom storage in place', () => {
  const working = new Storage()
  const target = { localStorage: working, sessionStorage: working }
  expect(installWorkingStorage(target)).toEqual([])
  expect(target.localStorage).toBe(working)
})

// Review c: with --localstorage-file, Node 25's storage is COMPLETE (it has
// clear) but file-backed, so a test would read another process's values.
it('replaces a complete but non-DOM storage, such as Node 25 file-backed storage', () => {
  const stale = new Map([['probe', 'stale']])
  const fileBacked = { getItem: (key: string) => stale.get(key) ?? null, setItem: () => {}, clear: () => {}, key: () => null, length: 1, removeItem: () => {} }
  const target = { localStorage: fileBacked, sessionStorage: fileBacked }
  expect(installWorkingStorage(target)).toEqual(['localStorage', 'sessionStorage'])
  expect((target as unknown as { localStorage: Storage }).localStorage.getItem('probe')).toBeNull()
})
