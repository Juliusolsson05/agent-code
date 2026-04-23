import type {
  SessionId,
  SessionMeta,
  SplitDirection,
  Tab,
  TileNode,
} from '@renderer/workspace/types'
import { collectLeaves } from '@renderer/workspace/tile-tree/treeOps'

// Undo-close stack — captures enough state to restore a closed pane or
// tab exactly where it was in the tile tree.
//
// Two entry shapes:
//
//   'pane' — a single leaf was removed from a split. To undo we find the
//            surviving sibling in the current tree, re-wrap it in a split
//            with the same direction + ratio, and respawn the session.
//
//   'tab'  — an entire tab was closed. To undo we respawn every session
//            in the tab, rebuild the tree, and re-insert the tab at its
//            original index.
//
// The stack is LIFO — the user undoes the most recent close first, which
// matches Cmd+Shift+T muscle memory from every browser ever. Multiple
// undoes pop successively older entries.
//
// Entries auto-expire after EXPIRY_MS (default 2 minutes). After that
// the session state is too stale to be useful — the user has moved on
// and restoring an ancient split would be confusing. The expiry is
// checked lazily on push/pop so we don't need a timer ticking in the
// background.

const EXPIRY_MS = 2 * 60 * 1000 // 2 minutes
const MAX_ENTRIES = 20

// ---- Entry types ----

/**
 * Captured when a leaf is removed from a split. Records enough to
 * reconstruct the split and respawn the session.
 *
 * `siblingLeafId` is ANY leaf sessionId within the surviving subtree.
 * We use it to locate the surviving node in the (potentially further
 * modified) tree — the surviving subtree might itself be a multi-level
 * split, so we can't reference it by a single "sibling sessionId" in
 * the simple sense. Any leaf that was inside it at close time works as
 * a search anchor.
 *
 * Why a leaf id instead of a tree path (like ['a', 'b', 'a']): the
 * tree mutates after every close, split, and resize. A structural path
 * captured at close time is stale by the time the user undoes — other
 * panes may have been opened or closed in between, shifting every
 * path. A leaf sessionId is stable (it's a UUID that doesn't change
 * until that session is itself closed), so we can always find the
 * surviving node by walking the tree looking for the subtree that
 * contains our anchor leaf.
 */
export type ClosedPane = {
  type: 'pane'
  closedAt: number
  tabId: string
  /** Session metadata for the closed pane — cwd, kind, providerSessionId. */
  sessionMeta: SessionMeta
  /** Split direction the parent had. */
  direction: SplitDirection
  /** Split ratio the parent had. */
  ratio: number
  /** Which side of the split the closed pane was on. */
  side: 'a' | 'b'
  /** Any leaf id inside the surviving sibling subtree. Used to find
   *  where to re-insert the split in the current tree. */
  siblingLeafId: SessionId
}

/**
 * Captured when an entire tab is closed. We store the full tree
 * structure and all session metas so we can rebuild everything.
 */
export type ClosedTab = {
  type: 'tab'
  closedAt: number
  tab: Tab
  /** Index the tab was at before removal — used to re-insert at the
   *  same position (clamped to bounds if other tabs were also closed
   *  in the meantime). */
  tabIndex: number
  sessionMetas: Record<SessionId, SessionMeta>
}

export type ClosedEntry = ClosedPane | ClosedTab

// ---- Stack ----

export class UndoCloseStack {
  private entries: ClosedEntry[] = []

  /** Push a new entry onto the stack. Prunes expired + over-cap. */
  push(entry: ClosedEntry): void {
    this.prune()
    this.entries.push(entry)
    if (this.entries.length > MAX_ENTRIES) {
      this.entries = this.entries.slice(-MAX_ENTRIES)
    }
  }

  /** Pop the most recent non-expired entry. Returns null if empty. */
  pop(): ClosedEntry | null {
    this.prune()
    return this.entries.pop() ?? null
  }

  /** Peek at the most recent entry without removing it. */
  peek(): ClosedEntry | null {
    this.prune()
    return this.entries.at(-1) ?? null
  }

  /** Number of restorable entries. */
  get length(): number {
    this.prune()
    return this.entries.length
  }

  private prune(): void {
    const cutoff = Date.now() - EXPIRY_MS
    this.entries = this.entries.filter(e => e.closedAt > cutoff)
  }
}

// ---- Tree helpers ----

/**
 * Find the parent split of a leaf and return contextual info needed
 * to reconstruct the split on undo.
 *
 * Returns null if the leaf is the root (no parent split — closing it
 * means closing the tab, which is a different undo entry type).
 */
export function findParentSplitInfo(
  root: TileNode,
  targetSessionId: SessionId,
): {
  direction: SplitDirection
  ratio: number
  side: 'a' | 'b'
  siblingLeafId: SessionId
} | null {
  return _findParent(root, targetSessionId)
}

function _findParent(
  node: TileNode,
  target: SessionId,
): {
  direction: SplitDirection
  ratio: number
  side: 'a' | 'b'
  siblingLeafId: SessionId
} | null {
  if (node.type === 'leaf') return null

  // Check if the target is a direct child.
  const aIsTarget =
    node.a.type === 'leaf' && node.a.sessionId === target
  const bIsTarget =
    node.b.type === 'leaf' && node.b.sessionId === target

  if (aIsTarget) {
    // Target is on side 'a', sibling is 'b'.
    const siblingLeafId = collectLeaves(node.b)[0]
    return {
      direction: node.direction,
      ratio: node.ratio,
      side: 'a',
      siblingLeafId,
    }
  }

  if (bIsTarget) {
    const siblingLeafId = collectLeaves(node.a)[0]
    return {
      direction: node.direction,
      ratio: node.ratio,
      side: 'b',
      siblingLeafId,
    }
  }

  // Recurse.
  return _findParent(node.a, target) ?? _findParent(node.b, target)
}

/**
 * Re-insert a closed pane into the tree by finding the surviving
 * sibling (via its anchor leaf id) and wrapping it in a new split
 * with the resurrected leaf on the correct side.
 *
 * Returns the new tree root, or null if the anchor leaf couldn't be
 * found (the sibling was also closed — the undo is stale).
 */
export function reinsertPane(
  root: TileNode,
  siblingLeafId: SessionId,
  newSessionId: SessionId,
  direction: SplitDirection,
  ratio: number,
  side: 'a' | 'b',
): TileNode | null {
  const result = _reinsert(root, siblingLeafId, newSessionId, direction, ratio, side)
  return result
}

function _reinsert(
  node: TileNode,
  siblingLeafId: SessionId,
  newSessionId: SessionId,
  direction: SplitDirection,
  ratio: number,
  side: 'a' | 'b',
): TileNode | null {
  // Walk the tree looking for the subtree that contains the anchor
  // leaf. When we find it, wrap that entire subtree in a new split
  // with the resurrected leaf on the correct side.
  //
  // We need to find the node whose SUBTREE contains the anchor —
  // that subtree is what was the sibling at close time, and it might
  // have grown (new splits added inside it) or shrunk (sub-panes
  // closed) since then. The right move is to find the SHALLOWEST
  // ancestor that contains the anchor and was the direct survivor.
  //
  // But we can't know which ancestor was "the direct survivor"
  // because the tree has been rebuilt since then. The safe heuristic:
  // find the shallowest node that contains the anchor leaf AND is
  // itself a direct child of a split (or is the root). We do this by
  // checking at each level: does this node contain the anchor? If so,
  // wrap it.

  if (node.type === 'leaf') {
    if (node.sessionId === siblingLeafId) {
      // Found the anchor leaf — wrap it in a split.
      const newLeaf: TileNode = { type: 'leaf', sessionId: newSessionId }
      return {
        type: 'split',
        direction,
        ratio,
        a: side === 'a' ? newLeaf : node,
        b: side === 'b' ? newLeaf : node,
      }
    }
    return null // not in this subtree
  }

  // Split node. Check children.
  const aLeaves = collectLeaves(node.a)
  const bLeaves = collectLeaves(node.b)
  const inA = aLeaves.includes(siblingLeafId)
  const inB = bLeaves.includes(siblingLeafId)

  if (!inA && !inB) return null // anchor not in this subtree

  // The anchor is somewhere in this subtree. If we're at a split
  // whose DIRECT child (a or b) is the anchor leaf itself, we need
  // to descend into that child so the wrap happens around the leaf,
  // not around this whole split. But if the anchor is deeper, we
  // still descend — we always wrap at the leaf level.
  //
  // Actually, let me reconsider. The sibling at close time could have
  // been a split node (not just a leaf). In that case, the anchor is
  // somewhere inside the original sibling. We want to wrap the
  // original sibling — which after the close became a direct child of
  // wherever the parent split used to be. The problem is we don't
  // know which node in the current tree corresponds to the original
  // sibling.
  //
  // Safest approach: always descend to the leaf and wrap there. This
  // means we always re-split at the leaf level, not at the original
  // split level. For the common case (sibling was a leaf), this is
  // perfect. For the rare case (sibling was a split), the restored
  // pane ends up next to one specific leaf inside the old sibling
  // instead of next to the whole sibling — slightly wrong in theory,
  // but visually close and much simpler than trying to detect the
  // original sibling boundary.

  if (inA) {
    const newA = _reinsert(node.a, siblingLeafId, newSessionId, direction, ratio, side)
    if (newA === null) return null
    return { ...node, a: newA }
  }

  const newB = _reinsert(node.b, siblingLeafId, newSessionId, direction, ratio, side)
  if (newB === null) return null
  return { ...node, b: newB }
}
