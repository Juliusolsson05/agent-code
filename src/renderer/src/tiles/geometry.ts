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
