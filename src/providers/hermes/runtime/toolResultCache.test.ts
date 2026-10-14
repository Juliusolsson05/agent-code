import { describe, expect, it } from 'vitest'

import { BoundedToolResultCache } from './toolResultCache'

// Bounds are the point of this cache (it lives for the app's lifetime).
describe('BoundedToolResultCache', () => {
  it('evicts the oldest outputs past the total budget, never the newest', () => {
    const cache = new BoundedToolResultCache(10, 10)
    cache.set('a', { content: '12345', isError: false })
    cache.set('b', { content: '12345', isError: true })
    cache.set('c', { content: '123', isError: false })
    expect(cache.get('a')).toBeUndefined()
    expect(cache.get('b')).toEqual({ content: '12345', isError: true })
    expect(cache.get('c')?.content).toBe('123')
  })

  it('truncates one oversized output instead of letting it flush everything else', () => {
    const cache = new BoundedToolResultCache(100, 8)
    cache.set('small', { content: 'ok', isError: false })
    cache.set('huge', { content: 'x'.repeat(50), isError: false })
    expect(cache.get('small')?.content).toBe('ok')
    expect(cache.get('huge')?.content.startsWith('xxxxxxxx\n… (output truncated')).toBe(true)
  })
})
