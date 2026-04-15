import type { SessionId, SplitDirection, TileNode } from '../../../tiles/types'

export type Rect = {
  x: number
  y: number
  width: number
  height: number
}

export type PlacementIntent = {
  vertical: 'up' | 'down' | null
  horizontal: 'left' | 'right' | null
}

export type PlacementTarget = {
  targetSessionId: SessionId
  direction: SplitDirection
  side: 'a' | 'b'
  rect: Rect
  reason: 'adjacent' | 'synthesized'
}

type LeafGeometry = {
  sessionId: SessionId
  rect: Rect
}

const BAND_EPSILON = 4

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

export function resolvePlacementTarget(
  root: TileNode,
  anchorSessionId: SessionId,
  intent: PlacementIntent,
  bounds: Rect,
): PlacementTarget | null {
  const leaves = buildLeafGeometries(root, bounds)
  const anchor = leaves.find(leaf => leaf.sessionId === anchorSessionId)
  if (!anchor) return null

  const vertical = intent.vertical
  const horizontal = intent.horizontal

  if (!vertical && !horizontal) return null

  if (vertical && horizontal) {
    const verticalCandidates = leaves.filter(leaf => {
      if (leaf.sessionId === anchorSessionId) return false
      return vertical === 'down'
        ? leaf.rect.y >= anchor.rect.y + anchor.rect.height - BAND_EPSILON
        : leaf.rect.y + leaf.rect.height <= anchor.rect.y + BAND_EPSILON
    })

    if (verticalCandidates.length > 0) {
      const bandEdge = vertical === 'down'
        ? Math.min(...verticalCandidates.map(leaf => leaf.rect.y))
        : Math.max(...verticalCandidates.map(leaf => leaf.rect.y + leaf.rect.height))
      const band = verticalCandidates.filter(leaf => (
        vertical === 'down'
          ? Math.abs(leaf.rect.y - bandEdge) < BAND_EPSILON
          : Math.abs(leaf.rect.y + leaf.rect.height - bandEdge) < BAND_EPSILON
      ))
      const targetLeaf = [...band].sort((a, b) => (
        horizontal === 'left'
          ? a.rect.x - b.rect.x
          : b.rect.x - a.rect.x
      ))[0]
      if (targetLeaf) {
        return {
          targetSessionId: targetLeaf.sessionId,
          direction: 'horizontal',
          side: vertical === 'down' ? 'a' : 'b',
          rect: sliceRect(targetLeaf.rect, 'horizontal', vertical === 'down' ? 'a' : 'b'),
          reason: 'synthesized',
        }
      }
    }
  }

  if (horizontal) {
    return {
      targetSessionId: anchorSessionId,
      direction: 'vertical',
      side: horizontal === 'left' ? 'a' : 'b',
      rect: sliceRect(anchor.rect, 'vertical', horizontal === 'left' ? 'a' : 'b'),
      reason: 'adjacent',
    }
  }

  if (vertical) {
    return {
      targetSessionId: anchorSessionId,
      direction: 'horizontal',
      side: vertical === 'up' ? 'a' : 'b',
      rect: sliceRect(anchor.rect, 'horizontal', vertical === 'up' ? 'a' : 'b'),
      reason: 'adjacent',
    }
  }

  return null
}

function sliceRect(
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
