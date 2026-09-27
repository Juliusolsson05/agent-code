import { describe, expect, it } from 'vitest'

import { LruMap } from './lruMap.js'

describe('LruMap', () => {
  it('evicts the least recently used entry, where get() counts as use and peek() does not', () => {
    const lru = new LruMap<string, number>(3)
    lru.set('a', 1)
    lru.set('b', 2)
    lru.set('c', 3)
    expect(lru.get('a')).toBe(1)
    expect(lru.peek('b')).toBe(2)
    lru.set('d', 4)
    expect(lru.size).toBe(3)
    expect(lru.peek('b')).toBeUndefined()
    expect([lru.peek('a'), lru.peek('c'), lru.peek('d')]).toEqual([1, 3, 4])
  })

  it('re-setting a key refreshes it instead of growing', () => {
    const lru = new LruMap<string, number>(2)
    lru.set('a', 1)
    lru.set('b', 2)
    lru.set('a', 10)
    lru.set('c', 3)
    expect(lru.size).toBe(2)
    expect(lru.peek('a')).toBe(10)
    expect(lru.peek('b')).toBeUndefined()
  })
})
