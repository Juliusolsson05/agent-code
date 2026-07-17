import { describe, expect, it } from 'vitest'

import { boundedJsonPreview } from './boundedJson'

describe('boundedJsonPreview', () => {
  it('does not read properties beyond the admitted preview prefix', () => {
    const value: Record<string, unknown> = {}
    for (let index = 0; index < 40; index += 1) value[`safe-${index}`] = index
    Object.defineProperty(value, 'must-not-be-read', {
      enumerable: true,
      get: () => {
        throw new Error('unbounded traversal')
      },
    })

    const preview = boundedJsonPreview(value)
    expect(preview).toContain('[more properties omitted]')
    expect(preview).not.toContain('must-not-be-read')
  })

  it('bounds nested strings before serialization', () => {
    const preview = boundedJsonPreview({ payload: 'x'.repeat(50_000) })
    expect(preview?.length).toBeLessThan(1_000)
    expect(preview).toContain('…')
  })
})
