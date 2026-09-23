import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { clickPointFromQuads, sizeFromBoxModel } from './geometry'

const FIX = join(__dirname, '..', '__fixtures__')
const recorded = readdirSync(FIX).filter(f => f.startsWith('dom-geometry.')).flatMap(f =>
  (JSON.parse(readFileSync(join(FIX, f), 'utf8')).geometry as Array<{ quads: { quads: number[][] }; box: { model: { content: number[]; width: number; height: number } } }>)
    .map(g => ({ file: f, ...g })))

describe('recorded Chrome geometry', () => {
  it('has recordings to test against', () => expect(recorded.length).toBeGreaterThan(5))

  it.each(recorded.map(g => [g.file, g] as const))('%s: the click point lies inside the element\'s content box', (_f, g) => {
    const p = clickPointFromQuads(g.quads.quads)!
    const c = g.box.model.content
    const xs = [c[0]!, c[2]!, c[4]!, c[6]!]
    const ys = [c[1]!, c[3]!, c[5]!, c[7]!]
    expect(p.x).toBeGreaterThan(Math.min(...xs)); expect(p.x).toBeLessThan(Math.max(...xs))
    expect(p.y).toBeGreaterThan(Math.min(...ys)); expect(p.y).toBeLessThan(Math.max(...ys))
  })

  it('reads element size from the box model', () => {
    const checkbox = recorded.find(g => g.box.model.width === 13)!
    expect(sizeFromBoxModel(checkbox.box.model)).toEqual({ width: 13, height: 13 })
  })
})

it('an element with no layout box yields no click point instead of clicking 0,0', () => {
  // A hidden element returns no quads. Clicking the viewport origin would hit
  // whatever sits in the top-left corner.
  expect(clickPointFromQuads([])).toBeNull()
  expect(clickPointFromQuads(undefined)).toBeNull()
  expect(clickPointFromQuads([[10, 10, 10, 10, 10, 10, 10, 10]])).toBeNull()
})
