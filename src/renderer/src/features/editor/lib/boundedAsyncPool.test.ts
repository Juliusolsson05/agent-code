import { describe, expect, it } from 'vitest'

import { mapWithConcurrency } from './boundedAsyncPool'

describe('mapWithConcurrency', () => {
  it('limits in-flight work and preserves input result order', async () => {
    let active = 0
    let peak = 0
    const releases: Array<() => void> = []

    const resultPromise = mapWithConcurrency([1, 2, 3, 4], 2, async value => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise<void>(resolve => releases.push(resolve))
      active -= 1
      return value * 10
    })

    await Promise.resolve()
    expect(active).toBe(2)
    releases.shift()?.()
    await Promise.resolve()
    await Promise.resolve()
    expect(active).toBe(2)
    while (releases.length > 0) {
      releases.shift()?.()
      await Promise.resolve()
      await Promise.resolve()
    }

    await expect(resultPromise).resolves.toEqual([10, 20, 30, 40])
    expect(peak).toBe(2)
  })

  it('falls back to sequential work for an invalid limit', async () => {
    const order: number[] = []
    const result = await mapWithConcurrency([1, 2], 0, async value => {
      order.push(value)
      return value
    })

    expect(order).toEqual([1, 2])
    expect(result).toEqual([1, 2])
  })

  it('waits for sibling work to settle before propagating a rejection', async () => {
    let releaseSibling!: () => void
    let siblingFinished = false
    const result = mapWithConcurrency([1, 2], 2, async value => {
      if (value === 1) throw new Error('write failed')
      await new Promise<void>(resolve => {
        releaseSibling = resolve
      })
      siblingFinished = true
      return value
    })

    await Promise.resolve()
    let rejected = false
    void result.catch(() => {
      rejected = true
    })
    await Promise.resolve()
    expect(rejected).toBe(false)
    releaseSibling()

    await expect(result).rejects.toThrow('write failed')
    expect(siblingFinished).toBe(true)
  })
})
