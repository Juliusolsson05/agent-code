import type { SessionId, SplitDirection, TileNode } from './types'

export type Rect = {
  x: number
  y: number
  width: number
  height: number
}

type LeafGeometry = {
  sessionId: SessionId
  rect: Rect
}

type Center = {
  x: number
  y: number
}

export function sliceRect(
  rect: Rect,
  direction: SplitDirection,
  side: 'a' | 'b',
): Rect {
  if (direction === 'vertical') {
    const width = rect.width / 2
    return {
      x: side === 'a' ? rect.x : rect.x + width,
      y: rect.y,
      width,
      height: rect.height,
    }
  }

  const height = rect.height / 2
  return {
    x: rect.x,
    y: side === 'a' ? rect.y : rect.y + height,
    width: rect.width,
    height,
  }
}

export function buildLeafGeometries(
  node: TileNode,
  bounds: Rect,
): LeafGeometry[] {
  if (node.type === 'leaf') {
    return [{ sessionId: node.sessionId, rect: bounds }]
  }

  if (node.direction === 'vertical') {
    const leftWidth = bounds.width * node.ratio
    return [
      ...buildLeafGeometries(node.a, {
        x: bounds.x,
        y: bounds.y,
        width: leftWidth,
        height: bounds.height,
      }),
      ...buildLeafGeometries(node.b, {
        x: bounds.x + leftWidth,
        y: bounds.y,
        width: bounds.width - leftWidth,
        height: bounds.height,
      }),
    ]
  }

  const topHeight = bounds.height * node.ratio
  return [
    ...buildLeafGeometries(node.a, {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: topHeight,
    }),
    ...buildLeafGeometries(node.b, {
      x: bounds.x,
      y: bounds.y + topHeight,
      width: bounds.width,
      height: bounds.height - topHeight,
    }),
  ]
}

function centerOf(rect: Rect): Center {
  return {
    x: rect.x + rect.width / 2,
    y: rect.y + rect.height / 2,
  }
}

function distanceSquared(a: Center, b: Center): number {
  const dx = a.x - b.x
  const dy = a.y - b.y
  return dx * dx + dy * dy
}

/**
 * Geometric neighbor lookup for pane navigation (alt-hjkl / alt-arrows).
 *
 * WHY geometry instead of tree traversal: the original `findNeighbor` in
 * treeOps walked the tree, matched a split whose axis agreed with the
 * direction, then called `firstLeaf` on the opposite side. `firstLeaf`
 * always descends into `.a` — so crossing a row boundary in a 2×3 grid
 * (rows built first, then columns) landed the user at the leftmost
 * column of the target row, regardless of which column they started in.
 * tmux doesn't do that; users don't expect it; geometry makes it go
 * away because it only cares about where panes actually ARE on screen,
 * not how the tree happens to be shaped.
 *
 * Algorithm (normalized 0..1 coordinate space):
 *   1. Build leaf rects; locate the source rect.
 *   2. Candidates = leaves strictly on the far side of the source's
 *      relevant edge (use an epsilon; shared boundaries must not
 *      match the source itself).
 *   3. Score each: primary-axis gap (smallest = physically adjacent),
 *      then cross-axis overlap (largest = best column/row alignment),
 *      then cross-axis center distance (fallback when nothing
 *      overlaps — e.g. top row has fewer panes than the source's row).
 *   4. Return the best-scored leaf's sessionId, or null at the edge.
 *
 * Returns null when there is no pane in the requested direction.
 * Ratios are clamped to [0.1, 0.9] upstream, so EPS at shared edges
 * is safe — no candidate pane is ever epsilon-close to the source
 * on the same axis.
 */
export function findDirectionalNeighbor(
  root: TileNode,
  focusedSessionId: SessionId,
  direction: 'left' | 'right' | 'up' | 'down',
): SessionId | null {
  const bounds = { x: 0, y: 0, width: 1, height: 1 }
  const leaves = buildLeafGeometries(root, bounds)
  const source = leaves.find(l => l.sessionId === focusedSessionId)
  if (!source) return null

  const EPS = 1e-6
  const src = source.rect
  const srcRight = src.x + src.width
  const srcBottom = src.y + src.height
  const isVerticalMove = direction === 'up' || direction === 'down'

  const candidates = leaves.filter(l => {
    if (l.sessionId === focusedSessionId) return false
    const r = l.rect
    switch (direction) {
      case 'up':    return r.y + r.height <= src.y + EPS
      case 'down':  return r.y >= srcBottom - EPS
      case 'left':  return r.x + r.width <= src.x + EPS
      case 'right': return r.x >= srcRight - EPS
    }
  })
  if (candidates.length === 0) return null

  type Score = { gap: number; overlap: number; crossDist: number }
  function score(r: Rect): Score {
    if (isVerticalMove) {
      const gap = direction === 'up'
        ? src.y - (r.y + r.height)
        : r.y - srcBottom
      const ovStart = Math.max(r.x, src.x)
      const ovEnd = Math.min(r.x + r.width, srcRight)
      return {
        gap,
        overlap: Math.max(0, ovEnd - ovStart),
        crossDist: Math.abs((r.x + r.width / 2) - (src.x + src.width / 2)),
      }
    }
    const gap = direction === 'left'
      ? src.x - (r.x + r.width)
      : r.x - srcRight
    const ovStart = Math.max(r.y, src.y)
    const ovEnd = Math.min(r.y + r.height, srcBottom)
    return {
      gap,
      overlap: Math.max(0, ovEnd - ovStart),
      crossDist: Math.abs((r.y + r.height / 2) - (src.y + src.height / 2)),
    }
  }

  // Nearest-adjacent wins (smallest gap); among ties, most cross-axis
  // overlap wins; final fallback is cross-axis center distance for
  // asymmetric layouts where nothing overlaps the source at all.
  let best = candidates[0]
  let bestScore = score(best.rect)
  for (let i = 1; i < candidates.length; i++) {
    const s = score(candidates[i].rect)
    const gapDelta = s.gap - bestScore.gap
    if (gapDelta < -EPS) { best = candidates[i]; bestScore = s; continue }
    if (gapDelta > EPS) continue
    if (s.overlap > bestScore.overlap + EPS) { best = candidates[i]; bestScore = s; continue }
    if (s.overlap < bestScore.overlap - EPS) continue
    if (s.crossDist < bestScore.crossDist) { best = candidates[i]; bestScore = s }
  }
  return best.sessionId
}

export function findBestRemainingFocus(
  previousRoot: TileNode,
  nextRoot: TileNode,
  removedSessionId: SessionId,
): SessionId | null {
  const bounds = { x: 0, y: 0, width: 1, height: 1 }
  const previousLeaves = buildLeafGeometries(previousRoot, bounds)
  const removedLeaf = previousLeaves.find(leaf => leaf.sessionId === removedSessionId)
  if (!removedLeaf) return null

  const nextLeafIds = new Set(buildLeafGeometries(nextRoot, bounds).map(leaf => leaf.sessionId))
  const candidates = previousLeaves.filter(leaf =>
    leaf.sessionId !== removedSessionId && nextLeafIds.has(leaf.sessionId),
  )
  if (candidates.length === 0) return null

  const removedCenter = centerOf(removedLeaf.rect)
  candidates.sort((a, b) => (
    distanceSquared(centerOf(a.rect), removedCenter) -
    distanceSquared(centerOf(b.rect), removedCenter)
  ))
  return candidates[0]?.sessionId ?? null
}
