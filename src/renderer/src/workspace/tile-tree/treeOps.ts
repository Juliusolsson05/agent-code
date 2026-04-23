// Pure tree operations on TileNode.
//
// All functions are pure: they take a tree (and sometimes extra args)
// and return a new tree. No mutations. Testable in isolation without
// React, without IPC, without any store — which is why they live in
// their own file.
//
// The store (workspaceStore.ts) wraps these in React state and action
// dispatch. Keeping the ops pure means the store is ~100 lines of
// boilerplate instead of a tangled reducer with tree logic inline.

import {
  RATIO_DEFAULT,
  RATIO_MAX,
  RATIO_MIN,
  type SessionId,
  type SplitDirection,
  type TileNode,
} from '@renderer/workspace/types'

/**
 * Walk a tree and return every leaf's sessionId in depth-first order.
 * Useful for "find the Nth pane" and "enumerate all panes for cleanup".
 */
export function collectLeaves(node: TileNode): SessionId[] {
  if (node.type === 'leaf') return [node.sessionId]
  return [...collectLeaves(node.a), ...collectLeaves(node.b)]
}

/**
 * Clamp a ratio into the safe range. Used everywhere splits are
 * created or resized so a pane can never become invisibly small.
 */
export function clampRatio(r: number): number {
  if (!Number.isFinite(r)) return RATIO_DEFAULT
  return Math.min(RATIO_MAX, Math.max(RATIO_MIN, r))
}

/**
 * Split a specific leaf in the tree into two leaves: the original +
 * a new one with `newSessionId`. The new pane goes on the `b` side
 * (right of vertical / bottom of horizontal).
 *
 * Returns a new tree. If the targetSessionId isn't found, returns the
 * input unchanged — callers should treat that as a bug and guard upstream.
 */
export function splitLeaf(
  node: TileNode,
  targetSessionId: SessionId,
  direction: SplitDirection,
  newSessionId: SessionId,
): TileNode {
  return insertBesideLeaf(
    node,
    targetSessionId,
    direction,
    RATIO_DEFAULT,
    'b',
    newSessionId,
  )
}

/**
 * Wrap the whole existing layout in a new split and place a new leaf on one
 * side of it. Used by layout-aware insertion flows where the user wants a new
 * top/bottom row or left/right column for the entire tab, not just beside the
 * currently focused pane.
 */
export function wrapRootWithLeaf(
  node: TileNode,
  direction: SplitDirection,
  side: 'a' | 'b',
  newSessionId: SessionId,
): TileNode {
  const newLeaf: TileNode = { type: 'leaf', sessionId: newSessionId }
  return {
    type: 'split',
    direction,
    ratio: RATIO_DEFAULT,
    a: side === 'a' ? newLeaf : node,
    b: side === 'b' ? newLeaf : node,
  }
}

/**
 * Insert a new leaf beside an existing one with explicit geometry.
 * Used by revive flows that want to preserve an older split ratio/side
 * as closely as possible instead of always creating a default 50/50
 * right/bottom split.
 */
export function insertBesideLeaf(
  node: TileNode,
  targetSessionId: SessionId,
  direction: SplitDirection,
  ratio: number,
  side: 'a' | 'b',
  newSessionId: SessionId,
): TileNode {
  if (node.type === 'leaf') {
    if (node.sessionId !== targetSessionId) return node
    const newLeaf: TileNode = { type: 'leaf', sessionId: newSessionId }
    return {
      type: 'split',
      direction,
      ratio: clampRatio(ratio),
      a: side === 'a' ? newLeaf : node,
      b: side === 'b' ? newLeaf : node,
    }
  }
  return {
    ...node,
    a: insertBesideLeaf(
      node.a,
      targetSessionId,
      direction,
      ratio,
      side,
      newSessionId,
    ),
    b: insertBesideLeaf(
      node.b,
      targetSessionId,
      direction,
      ratio,
      side,
      newSessionId,
    ),
  }
}

/**
 * Close a leaf: find it and replace its parent split with the surviving
 * sibling. If the closed leaf IS the root, returns null — the caller
 * interprets that as "this tab is now empty, close it too".
 */
export function closeLeaf(
  node: TileNode,
  targetSessionId: SessionId,
): TileNode | null {
  if (node.type === 'leaf') {
    return node.sessionId === targetSessionId ? null : node
  }
  const newA = closeLeaf(node.a, targetSessionId)
  const newB = closeLeaf(node.b, targetSessionId)
  if (newA === null && newB === null) return null
  if (newA === null) return newB
  if (newB === null) return newA
  return { ...node, a: newA, b: newB }
}

/**
 * Find the innermost split that contains `sessionId` and grow the
 * focused pane by `delta` (shrink if delta is negative). Returns a new
 * tree.
 *
 * Used for the axis-less `alt-=` / `alt--` resize keybinds — the user
 * just wants the focused pane bigger or smaller, regardless of which
 * direction the parent split runs. This is NOT the same primitive as
 * `resizeInDirection`:
 *   - `adjustNearestSplitRatio(delta)` is "bigger/smaller me" —
 *     delta is relative to the focused pane, so its sign is
 *     inverted for panes on the `b` side of their parent split
 *     (because the split ratio is the `a` fraction).
 *   - `resizeInDirection(direction, delta)` is "move the divider in
 *     this physical direction" — delta is anchored to the arrow, not
 *     to which side of the split the focused pane is on.
 *
 * Both coexist on purpose. Keep them separate; don't fold this into
 * `resizeInDirection` — the axis-less form is the simpler UX for
 * "just make me bigger" without the user having to think about which
 * arrow key to hit.
 */
export function adjustNearestSplitRatio(
  node: TileNode,
  focusedSessionId: SessionId,
  delta: number,
): TileNode {
  if (node.type === 'leaf') return node
  // Recurse into children first so we adjust the INNERMOST split that
  // contains the focused session — the one the user most recently
  // interacted with.
  const leavesA = collectLeaves(node.a)
  const leavesB = collectLeaves(node.b)
  const inA = leavesA.includes(focusedSessionId)
  const inB = leavesB.includes(focusedSessionId)
  if (inA) {
    const adjustedA = adjustNearestSplitRatio(node.a, focusedSessionId, delta)
    // If the focused leaf is DIRECTLY a child of this split (it's `a`
    // and `a` is a leaf) we're the innermost split containing it.
    if (node.a.type === 'leaf') {
      return { ...node, ratio: clampRatio(node.ratio + delta) }
    }
    return { ...node, a: adjustedA }
  }
  if (inB) {
    const adjustedB = adjustNearestSplitRatio(node.b, focusedSessionId, delta)
    if (node.b.type === 'leaf') {
      // Growing `b` means DECREASING `ratio` (because ratio is the
      // fraction given to `a`). Invert the sign.
      return { ...node, ratio: clampRatio(node.ratio - delta) }
    }
    return { ...node, b: adjustedB }
  }
  return node
}

/**
 * Navigation neighbor lookup moved to geometry.ts::findDirectionalNeighbor
 * on 2026-04-20. The tree-walking version here always landed on the
 * leftmost/topmost leaf of the target subtree (via `firstLeaf`), which
 * was wrong whenever the user's source column didn't align with the
 * `.a`-side spine of the target subtree — e.g. moving ↑ from bottom-
 * right of a 2×3 grid landed on top-LEFT instead of top-right.
 *
 * Geometry-based selection is strictly more correct and doesn't care
 * how the tree happens to be shaped, so the tree-walk and its helpers
 * (`buildPath`, `firstLeaf`) are deleted rather than left as dead code.
 */

/**
 * Build a path from root to leaf as an array of side choices
 * (`'a' | 'b'` per level). Unlike buildPath, this doesn't carry the
 * node references — it's a purely structural description that survives
 * immutable tree rebuilds. Returned via the `out` param for consistency
 * with buildPath's mutate-in-place style.
 */
function buildSidePath(
  node: TileNode,
  target: SessionId,
  out: Array<'a' | 'b'>,
): boolean {
  if (node.type === 'leaf') return node.sessionId === target
  out.push('a')
  if (buildSidePath(node.a, target, out)) return true
  out.pop()
  out.push('b')
  if (buildSidePath(node.b, target, out)) return true
  out.pop()
  return false
}

/**
 * Walk a tree following a side path for `depth` steps and return the
 * node at that position. Forward iteration from root: step 0 is root,
 * step 1 is one level in, etc. Used by resizeInDirection to look up
 * the split we want to adjust without re-walking from scratch.
 */
function nodeAtPath(
  root: TileNode,
  sides: Array<'a' | 'b'>,
  depth: number,
): TileNode {
  let n: TileNode = root
  for (let i = 0; i < depth; i++) {
    if (n.type !== 'split') return n
    n = sides[i] === 'a' ? n.a : n.b
  }
  return n
}

/**
 * Return a new tree with the split at depth `targetDepth` having its
 * ratio replaced. Pure — builds a new spine down to the target split,
 * leaves unrelated subtrees shared with the input.
 *
 * Indexing invariant (important): walk FORWARD from the root, reading
 * sides[0], sides[1], sides[2]… until `offset === targetDepth`. An
 * earlier version of this used `sides[sides.length - pathLen]` which
 * indexed from the END of the path and shifted wrongly between
 * recursion levels — it happened to land correctly for paths made of
 * uniform `a`s or `b`s (top pane with sides=['a'], or the bottom-of-
 * bottom chain with sides=['b','b']) but silently dropped writes for
 * every mixed path in between. That was the "only the bottom pane's
 * ↓ resize does anything" symptom.
 */
function replaceRatioAtPath(
  node: TileNode,
  sides: Array<'a' | 'b'>,
  offset: number,
  targetDepth: number,
  newRatio: number,
): TileNode {
  if (offset === targetDepth) {
    if (node.type !== 'split') return node
    return { ...node, ratio: newRatio }
  }
  if (node.type !== 'split') return node
  const side = sides[offset]
  if (side === 'a') {
    return {
      ...node,
      a: replaceRatioAtPath(node.a, sides, offset + 1, targetDepth, newRatio),
    }
  }
  return {
    ...node,
    b: replaceRatioAtPath(node.b, sides, offset + 1, targetDepth, newRatio),
  }
}

/**
 * Direction-aware resize: the divider of the innermost matching split
 * moves in the arrow direction. The focused pane grows or shrinks as a
 * consequence of which side of the divider it's on.
 *
 * Why this "divider moves" model beats the "grow focused toward" model
 * I tried first:
 *   - The arrow direction is a physical compass, not a relationship
 *     to the focused pane. Pressing ← always moves boundaries left.
 *   - The user's intuition is: "the left arrow should visibly move
 *     things left." If focused is on the left side of a vertical
 *     split, ← shrinks me (my right edge moves left). If focused is on
 *     the right side, ← grows me (my left edge moves left). Same
 *     arrow, opposite-feeling effect, but a consistent underlying
 *     rule that matches every physical UI the user has ever touched.
 *   - No need to check which side the focused pane is on — the arrow
 *     alone determines the sign. The split-selection step just picks
 *     "the innermost split in this axis that contains me."
 *
 * Sign table (ratio is the fraction given to side `a` = left/top):
 *   ← : ratio -= delta  (vertical split's divider moves left)
 *   → : ratio += delta  (vertical split's divider moves right)
 *   ↑ : ratio -= delta  (horizontal split's divider moves up)
 *   ↓ : ratio += delta  (horizontal split's divider moves down)
 *
 * If no split in the matching axis is found walking up from the
 * focused leaf, the move is a no-op — there's nothing to resize.
 */
export function resizeInDirection(
  root: TileNode,
  focusedSessionId: SessionId,
  direction: 'left' | 'right' | 'up' | 'down',
  delta: number,
): TileNode {
  const sides: Array<'a' | 'b'> = []
  if (!buildSidePath(root, focusedSessionId, sides)) return root

  const wantAxis: SplitDirection =
    direction === 'left' || direction === 'right' ? 'vertical' : 'horizontal'
  // Sign is determined by the arrow alone — ratio is the `a` (left/top)
  // fraction, so moving the divider left or up means LESS `a`.
  const sign = direction === 'right' || direction === 'down' ? +1 : -1

  // Walk from the innermost split (deepest) outward, returning the
  // first one whose direction matches the arrow axis. That's the
  // split whose divider is closest to the focused pane on that axis.
  //
  // `targetDepth` is the depth of the candidate split — 0 means root,
  // sides.length - 1 means the innermost split on the path (parent of
  // the focused leaf). We check them in order innermost → outermost.
  for (let targetDepth = sides.length - 1; targetDepth >= 0; targetDepth--) {
    const parent = nodeAtPath(root, sides, targetDepth)
    if (parent.type !== 'split') continue
    if (parent.direction !== wantAxis) continue
    const newRatio = clampRatio(parent.ratio + sign * delta)
    return replaceRatioAtPath(root, sides, 0, targetDepth, newRatio)
  }

  return root
}

/**
 * Equalize spacing across the tree, preserving the existing structure
 * (directions, nesting, leaf order). This is the "soft" normalize.
 *
 * The tricky part: binary splits compound. A chain of 3 leaves in the
 * same direction with ratio 0.5 at each split gives 50/25/25 — not
 * 33/33/33. And the chain is not guaranteed to lean only on one side:
 * repeated splits can build the same-direction subtree through either
 * `a` or `b`.
 *
 * Algorithm: for each split, count how many effective "lanes" each
 * child contributes in this axis. A child split in the SAME direction
 * contributes the sum of its descendants' lanes; a leaf or an
 * opposite-direction subtree contributes exactly 1 lane in this axis.
 * The split ratio then becomes `lanes(a) / (lanes(a) + lanes(b))`.
 *
 * This preserves structure but makes every pane in a same-direction
 * group occupy the same visual share, regardless of whether the tree
 * is left-leaning, right-leaning, or mixed.
 *
 * Two columns at 50/50, each with 3 rows: the top-level vertical
 * split gets 0.5 (2 columns). Each column's horizontal chain of 3
 * gets 1/3, 1/2 — giving 33/33/33.
 */
export function equalizeRatios(node: TileNode): TileNode {
  if (node.type === 'leaf') return node
  const lanesA = countAxisLanes(node.a, node.direction)
  const lanesB = countAxisLanes(node.b, node.direction)
  return {
    ...node,
    ratio: clampRatio(lanesA / (lanesA + lanesB)),
    a: equalizeRatios(node.a),
    b: equalizeRatios(node.b),
  }
}

/**
 * Count how many effective panes this subtree contributes along one
 * axis. Opposite-direction subtrees count as a single lane because
 * they stack panes in the other dimension; same-direction subtrees
 * expand the lane count by both children.
 */
function countAxisLanes(node: TileNode, axis: SplitDirection): number {
  if (node.type === 'leaf') return 1
  if (node.direction !== axis) return 1
  return (
    countAxisLanes(node.a, axis) +
    countAxisLanes(node.b, axis)
  )
}

/**
 * Flip every split's direction: vertical ↔ horizontal. Turns rows into
 * columns and vice versa. Ratios and leaf order stay the same.
 */
export function rotateTree(node: TileNode): TileNode {
  if (node.type === 'leaf') return node
  return {
    ...node,
    direction: node.direction === 'vertical' ? 'horizontal' : 'vertical',
    a: rotateTree(node.a),
    b: rotateTree(node.b),
  }
}

/**
 * Build a balanced grid tree from a flat list of session ids.
 *
 * The grid has `cols = ceil(sqrt(N))` columns and `rows = ceil(N/cols)`
 * rows. Every pane gets equal space. The last row may have fewer panes
 * than the others — those panes simply get wider (they share fewer
 * vertical splits).
 *
 * The tree is built from binary splits only (our tile model is binary).
 * To give N items equal width in a row, we chain them with ratios
 * 1/N, 1/(N-1), 1/(N-2), … so each pane gets exactly 1/N of the row.
 * Rows are stacked the same way with horizontal splits.
 *
 * Pure function — no side effects, no session spawning.
 */
export function normalizeTree(leaves: SessionId[]): TileNode {
  if (leaves.length === 0) throw new Error('normalizeTree: no leaves')
  if (leaves.length === 1) return { type: 'leaf', sessionId: leaves[0] }

  const cols = Math.ceil(Math.sqrt(leaves.length))
  const rows = Math.ceil(leaves.length / cols)

  // Chunk leaves into rows.
  const rowChunks: SessionId[][] = []
  for (let r = 0; r < rows; r++) {
    rowChunks.push(leaves.slice(r * cols, (r + 1) * cols))
  }

  // Build each row as a chain of vertical splits.
  const rowNodes: TileNode[] = rowChunks.map(chunk => chainSplits(chunk, 'vertical'))

  // Stack rows as a chain of horizontal splits.
  return chainSplits(rowNodes, 'horizontal')
}

/**
 * Chain N items (leaves or subtrees) into a right-leaning binary split
 * tree with equal sizing. The ratio at each level is 1/remaining so
 * every item gets exactly 1/N of the total space.
 *
 * Works for both TileNode[] (stacking row subtrees) and SessionId[]
 * (building a single row).
 */
function chainSplits(
  items: (TileNode | SessionId)[],
  direction: SplitDirection,
): TileNode {
  const toNode = (item: TileNode | SessionId): TileNode =>
    typeof item === 'string' ? { type: 'leaf', sessionId: item } : item

  if (items.length === 1) return toNode(items[0])

  // Build right-to-left so the chain leans right:
  //   split(a, split(b, split(c, d)))
  // Ratios: 1/4, 1/3, 1/2 for 4 items → each gets 25%.
  let node = toNode(items[items.length - 1])
  for (let i = items.length - 2; i >= 0; i--) {
    const remaining = items.length - i
    node = {
      type: 'split',
      direction,
      ratio: clampRatio(1 / remaining),
      a: toNode(items[i]),
      b: node,
    }
  }
  return node
}
