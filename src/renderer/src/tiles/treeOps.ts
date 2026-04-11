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
} from './types'

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
  if (node.type === 'leaf') {
    if (node.sessionId !== targetSessionId) return node
    return {
      type: 'split',
      direction,
      ratio: RATIO_DEFAULT,
      a: node,
      b: { type: 'leaf', sessionId: newSessionId },
    }
  }
  return {
    ...node,
    a: splitLeaf(node.a, targetSessionId, direction, newSessionId),
    b: splitLeaf(node.b, targetSessionId, direction, newSessionId),
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
 * Find the split that contains `sessionId` (directly or transitively)
 * and update its ratio by `delta`. Returns a new tree.
 *
 * Used for `alt-=` / `alt--` resize keybinds — the user grows or
 * shrinks the split that the focused pane sits inside.
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
 * Geometric neighbor lookup — given a focused session and a direction
 * (left/right/up/down), return the sessionId of the pane the user would
 * expect to land on.
 *
 * Algorithm: walk up the tree until we find a split whose direction
 * matches the move (vertical for left/right, horizontal for up/down)
 * AND we're on the "wrong side" (i.e., moving right means we need to
 * currently be in the `a` side of a vertical split). Then descend into
 * the opposite side, always picking the pane closest to the original
 * via a simple heuristic: first leaf we hit. Good enough for binary
 * trees; tmux uses the same strategy.
 *
 * Returns null if there's no neighbor in that direction (edge of tab).
 */
export function findNeighbor(
  root: TileNode,
  focusedSessionId: SessionId,
  direction: 'left' | 'right' | 'up' | 'down',
): SessionId | null {
  // First, build a path from root to the focused leaf so we can walk
  // back up. Each path entry records which child (`a` or `b`) we
  // descended into.
  const path: Array<{ node: TileNode & { type: 'split' }; side: 'a' | 'b' }> = []
  const found = buildPath(root, focusedSessionId, path)
  if (!found) return null

  const wantDirection: SplitDirection =
    direction === 'left' || direction === 'right' ? 'vertical' : 'horizontal'
  const wantSide: 'a' | 'b' =
    direction === 'right' || direction === 'down' ? 'a' : 'b'
  // When moving right/down we want to be currently in side `a`, so we
  // can jump to `b`. Moving left/up we want to be currently in side `b`.

  // Walk back up the path looking for a matching split.
  for (let i = path.length - 1; i >= 0; i--) {
    const { node, side } = path[i]
    if (node.direction !== wantDirection) continue
    if (side !== wantSide) continue
    // Found one. Descend into the opposite side and return its first leaf.
    const target = side === 'a' ? node.b : node.a
    return firstLeaf(target)
  }
  return null
}

function buildPath(
  node: TileNode,
  target: SessionId,
  path: Array<{ node: TileNode & { type: 'split' }; side: 'a' | 'b' }>,
): boolean {
  if (node.type === 'leaf') return node.sessionId === target
  path.push({ node, side: 'a' })
  if (buildPath(node.a, target, path)) return true
  path.pop()
  path.push({ node, side: 'b' })
  if (buildPath(node.b, target, path)) return true
  path.pop()
  return false
}

/**
 * Return the sessionId of the first leaf found by a depth-first walk
 * into side `a`. Used by `findNeighbor` to pick a concrete landing pane
 * after deciding which subtree we're jumping into.
 */
export function firstLeaf(node: TileNode): SessionId {
  if (node.type === 'leaf') return node.sessionId
  return firstLeaf(node.a)
}
