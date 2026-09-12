import { describe, expect, it } from 'vitest'
import { BoundedQueue } from './boundedQueue'

describe('monitoring backpressure', () => {
  it('keeps the recent tail within both limits and preserves loss across drains', () => {
    const queue = new BoundedQueue<string>(3, 10)
    for (const value of ['a', 'b', 'c', 'd']) queue.push(value, 4)
    expect(queue.stats).toEqual({ records: 2, bytes: 8, dropped: 2, droppedBytes: 8 })
    expect(queue.drain(3, 5)).toEqual(['c'])
    expect(queue.drain()).toEqual(['d'])
    expect(queue.stats).toEqual({ records: 0, bytes: 0, dropped: 2, droppedBytes: 8 })
  })

  it('wraps under prolonged overload and releases drained values', () => {
    const queue = new BoundedQueue<number>(7, 100)
    for (let i = 0; i < 100_000; i++) queue.push(i, 1)
    expect(queue.drain()).toEqual([99993, 99994, 99995, 99996, 99997, 99998, 99999])
    expect(queue.stats.dropped).toBe(99993)
    queue.push(1, 1)
    queue.clear()
    expect(queue.drain()).toEqual([])
    expect(queue.stats.bytes).toBe(0)
  })

  it('rejects an oversized item without discarding useful queued evidence', () => {
    const queue = new BoundedQueue<string>(2, 10)
    queue.push('keep', 4)
    expect(queue.push('too large', 11)).toBe(false)
    expect(queue.push('invalid', NaN)).toBe(false)
    expect(queue.drain()).toEqual(['keep'])
    expect(queue.stats.dropped).toBe(2)
  })

  it('enforces record limits even when byte capacity remains', () => {
    const queue = new BoundedQueue<number>(2, 100)
    queue.push(1, 1)
    queue.push(2, 1)
    queue.push(3, 1)
    expect(queue.drain()).toEqual([2, 3])
    expect(() => new BoundedQueue(0, 1)).toThrow()
    expect(() => queue.drain(-1)).toThrow()
  })
})

