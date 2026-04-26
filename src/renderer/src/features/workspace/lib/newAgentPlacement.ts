import { buildLeafGeometries, sliceRect, type Rect } from '@renderer/workspace/tile-tree/geometry'
import type { SessionId, SplitDirection, TileNode } from '@renderer/workspace/types'

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

  // WHY keep explicit placement target records instead of deriving the
  // commit operation directly from the key press:
  //
  // The placement UI shows ONE preview at a time now, but the selected
  // preview still has to carry the real layout operation to commit. A
  // plain arrow maps to a split-leaf target; Shift+arrow maps to a
  // wrap-root target. Keeping those as addressable records means preview
  // geometry and commit payload stay identical, instead of rebuilding
  // "left/right/top/bottom" meaning in two different places.
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
  // In the one-leaf case, global and local placements can be visually
  // identical, but their ids remain intentionally different because
  // they represent different commands from the UI's perspective
  // (Shift+arrow vs plain arrow). The pass remains a cheap guard
  // against accidental duplicate records from future target builders.
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

export function placementTargetIdForArrow(
  targets: PlacementTarget[],
  anchorSessionId: SessionId,
  arrow: 'left' | 'right' | 'up' | 'down',
  scope: 'local' | 'global',
): string | null {
  const direction: SplitDirection =
    arrow === 'left' || arrow === 'right' ? 'vertical' : 'horizontal'
  const side: 'a' | 'b' =
    arrow === 'left' || arrow === 'up' ? 'a' : 'b'

  return (
    targets.find(target => {
      if (target.direction !== direction || target.side !== side) return false
      if (scope === 'global') return target.kind === 'wrap-root'
      return target.kind === 'split-leaf' && target.targetSessionId === anchorSessionId
    })?.id ??
    defaultPlacementTargetId(targets, anchorSessionId)
  )
}
