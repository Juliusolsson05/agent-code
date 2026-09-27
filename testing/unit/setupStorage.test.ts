import { expect, it } from 'vitest'

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

it('leaves a working storage in place', () => {
  const working = { clear: () => {} }
  const target = { localStorage: working, sessionStorage: working }
  expect(installWorkingStorage(target)).toEqual([])
  expect(target.localStorage).toBe(working)
})
