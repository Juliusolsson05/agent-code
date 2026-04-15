import { buildLeafGeometries, sliceRect, type Rect } from '../../../tiles/geometry'
import type { SessionId, SplitDirection, TileNode } from '../../../tiles/types'

export type PlacementTarget =
  | {
      id: string
      kind: 'split-leaf'
      targetSessionId: SessionId
      direction: SplitDirection
      side: 'a' | 'b'
      rect: Rect
      label: string
      scope: 'local'
    }
  | {
      id: string
      kind: 'wrap-root'
      direction: SplitDirection
      side: 'a' | 'b'
      rect: Rect
      label: string
      scope: 'global'
    }

type Center = {
  x: number
  y: number
}

function centerOf(rect: Rect): Center {
  return {
    x: rect.x + rect.width / 2,
    y: rect.y + rect.height / 2,
  }
}

export function buildPlacementTargets(
  root: TileNode,
  anchorSessionId: SessionId,
  bounds: Rect,
): PlacementTarget[] {
  const leaves = buildLeafGeometries(root, bounds)
  const anchor = leaves.find(leaf => leaf.sessionId === anchorSessionId)
  if (!anchor) return []

  const targets: PlacementTarget[] = [
    {
      id: `root:left`,
      kind: 'wrap-root',
      direction: 'vertical',
      side: 'a',
      rect: sliceRect(bounds, 'vertical', 'a'),
      label: 'new left column',
      scope: 'global',
    },
    {
      id: `root:right`,
      kind: 'wrap-root',
      direction: 'vertical',
      side: 'b',
      rect: sliceRect(bounds, 'vertical', 'b'),
      label: 'new right column',
      scope: 'global',
    },
    {
      id: `root:top`,
      kind: 'wrap-root',
      direction: 'horizontal',
      side: 'a',
      rect: sliceRect(bounds, 'horizontal', 'a'),
      label: 'new top row',
      scope: 'global',
    },
    {
      id: `root:bottom`,
      kind: 'wrap-root',
      direction: 'horizontal',
      side: 'b',
      rect: sliceRect(bounds, 'horizontal', 'b'),
      label: 'new bottom row',
      scope: 'global',
    },
    {
      id: `leaf:${anchor.sessionId}:left`,
      kind: 'split-leaf',
      targetSessionId: anchor.sessionId,
      direction: 'vertical',
      side: 'a',
      rect: sliceRect(anchor.rect, 'vertical', 'a'),
      label: 'left of focused pane',
      scope: 'local',
    },
    {
      id: `leaf:${anchor.sessionId}:right`,
      kind: 'split-leaf',
      targetSessionId: anchor.sessionId,
      direction: 'vertical',
      side: 'b',
      rect: sliceRect(anchor.rect, 'vertical', 'b'),
      label: 'right of focused pane',
      scope: 'local',
    },
    {
      id: `leaf:${anchor.sessionId}:top`,
      kind: 'split-leaf',
      targetSessionId: anchor.sessionId,
      direction: 'horizontal',
      side: 'a',
      rect: sliceRect(anchor.rect, 'horizontal', 'a'),
      label: 'above focused pane',
      scope: 'local',
    },
    {
      id: `leaf:${anchor.sessionId}:bottom`,
      kind: 'split-leaf',
      targetSessionId: anchor.sessionId,
      direction: 'horizontal',
      side: 'b',
      rect: sliceRect(anchor.rect, 'horizontal', 'b'),
      label: 'below focused pane',
      scope: 'local',
    },
  ]

  // WHY generate explicit placement targets instead of inferring from
  // arrow "intent":
  //
  // The old model guessed from the focused pane alone, which breaks down as
  // soon as the user wants to insert relative to the whole layout. Example:
  // with two stacked rows, "new bottom row" should wrap the entire root, not
  // try to synthesize something from the focused leaf. These targets are real
  // layout operations, so the preview and commit path can stay identical.
  return dedupeTargets(targets)
}

function dedupeTargets(targets: PlacementTarget[]): PlacementTarget[] {
  // WHY dedupe by target id, not rounded rect:
  //
  // The older version keyed dedupe on Math.round(rect.*) so two
  // logically different placements that happened to round to the same
  // integer rectangle collapsed into one. That was real on small
  // panes with fractional split ratios (e.g. a 401px-wide pane split
  // 50/50 produces two targets whose rounded rects both start at the
  // same x because the integer-halving is the same). The id already
  // encodes kind+scope+target+side, which is the actual identity we
  // care about; dropping the rounding collision trap also drops the
  // silent "which sibling wins?" non-determinism.
  //
  // We still keep a dedupe pass (rather than trusting callers) because
  // wrap-root and split-leaf can generate the same id in edge cases
  // where the anchor IS the root leaf and "left of focused pane" is
  // visually equivalent to "new left column". Same-id targets are
  // genuinely redundant and the first one wins.
  const seen = new Set<string>()
  const out: PlacementTarget[] = []
  for (const target of targets) {
    if (seen.has(target.id)) continue
    seen.add(target.id)
    out.push(target)
  }
  return out
}

export function defaultPlacementTargetId(
  targets: PlacementTarget[],
  anchorSessionId: SessionId,
): string | null {
  return (
    targets.find(target => (
      target.kind === 'split-leaf' &&
      target.targetSessionId === anchorSessionId &&
      target.direction === 'vertical' &&
      target.side === 'b'
    ))?.id ??
    targets[0]?.id ??
    null
  )
}

export function findNearestPlacementTarget(
  targets: PlacementTarget[],
  selectedId: string | null,
  direction: 'left' | 'right' | 'up' | 'down',
): string | null {
  const current =
    targets.find(target => target.id === selectedId) ??
    targets[0]
  if (!current) return null

  const currentCenter = centerOf(current.rect)
  const candidates = targets
    .filter(target => target.id !== current.id)
    .map(target => ({
      target,
      center: centerOf(target.rect),
    }))
    .filter(candidate => {
      if (direction === 'left') return candidate.center.x < currentCenter.x - 1
      if (direction === 'right') return candidate.center.x > currentCenter.x + 1
      if (direction === 'up') return candidate.center.y < currentCenter.y - 1
      return candidate.center.y > currentCenter.y + 1
    })

  if (candidates.length === 0) return current.id

  const ranked = candidates.sort((a, b) => {
    const primaryA = primaryAxisDistance(currentCenter, a.center, direction)
    const primaryB = primaryAxisDistance(currentCenter, b.center, direction)
    if (primaryA !== primaryB) return primaryA - primaryB

    const crossA = crossAxisDistance(currentCenter, a.center, direction)
    const crossB = crossAxisDistance(currentCenter, b.center, direction)
    if (crossA !== crossB) return crossA - crossB

    return euclideanDistance(currentCenter, a.center) - euclideanDistance(currentCenter, b.center)
  })

  return ranked[0]?.target.id ?? current.id
}

function primaryAxisDistance(
  from: Center,
  to: Center,
  direction: 'left' | 'right' | 'up' | 'down',
): number {
  if (direction === 'left') return from.x - to.x
  if (direction === 'right') return to.x - from.x
  if (direction === 'up') return from.y - to.y
  return to.y - from.y
}

function crossAxisDistance(
  from: Center,
  to: Center,
  direction: 'left' | 'right' | 'up' | 'down',
): number {
  return direction === 'left' || direction === 'right'
    ? Math.abs(to.y - from.y)
    : Math.abs(to.x - from.x)
}

function euclideanDistance(a: Center, b: Center): number {
  const dx = a.x - b.x
  const dy = a.y - b.y
  return Math.hypot(dx, dy)
}
