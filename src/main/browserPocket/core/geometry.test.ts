import { expect, it } from 'vitest'
import { sizeFromBoxModel } from './geometry'
it('reports native picker dimensions and rejects missing geometry', () => {
  expect(sizeFromBoxModel({ width: 13, height: 13 })).toEqual({ width: 13, height: 13 })
  expect(sizeFromBoxModel(undefined)).toBeNull()
})
