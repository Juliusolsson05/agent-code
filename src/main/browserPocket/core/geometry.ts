// CDP geometry → click points and element sizes (decomposition Stage 2).
//
// WHY the centre of the FIRST content quad: DOM.getContentQuads returns one
// quad per line box, so a link that wraps has several; the first is the one a
// human would click, and the centre stays inside it even when the quad is not
// axis-aligned (transforms). Recorded quads (__fixtures__/dom-geometry.*.json)
// are all single, axis-aligned boxes; multi-quad input is handled but has not
// been observed yet.

export type Quad = number[] // [x1,y1, x2,y2, x3,y3, x4,y4]

export function clickPointFromQuads(quads: Quad[] | undefined): { x: number; y: number } | null {
  const q = quads?.find(quad => quad.length === 8 && area(quad) > 0.5)
  if (!q) return null
  return { x: (q[0]! + q[2]! + q[4]! + q[6]!) / 4, y: (q[1]! + q[3]! + q[5]! + q[7]!) / 4 }
}

export function sizeFromBoxModel(model: { width?: number; height?: number } | undefined): { width: number; height: number } | null {
  if (!model || typeof model.width !== 'number' || typeof model.height !== 'number') return null
  return { width: model.width, height: model.height }
}

/** Shoelace area — a zero-area quad (collapsed element) is not clickable. */
function area(q: Quad): number {
  let sum = 0
  for (let i = 0; i < 4; i++) {
    const [x1, y1] = [q[i * 2]!, q[i * 2 + 1]!]
    const [x2, y2] = [q[((i + 1) % 4) * 2]!, q[((i + 1) % 4) * 2 + 1]!]
    sum += x1 * y2 - x2 * y1
  }
  return Math.abs(sum) / 2
}
