import type { SessionId, TileNode } from '@renderer/workspace/types'
import type { SlashPickerState, TileTabsState } from '@renderer/workspace/workspaceState'
import { collectLeaves } from '@renderer/workspace/tile-tree/treeOps'

// Layout & picker utilities for the workspace store.
//
// These are the small pure helpers the useWorkspace hook calls
// inline during layout mutations — tab titling, ratio math, tile-
// tabs state sanitization, picker equality, split-ratio walking.
// Separated out because they're the most easily unit-testable
// shapes in the whole workspace module and don't need any React
// or session-state context.

/** Derive a tab title from a cwd — use the last path segment
 *  ("cc-shell"), falling back to the full cwd if none. */
export function titleFromCwd(cwd: string): string {
  const parts = cwd.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? cwd
}

/** Evenly-divided ratios summing to 1 for `count` tabs. */
export function equalRatios(count: number): number[] {
  if (count <= 0) return []
  return Array.from({ length: count }, () => 1 / count)
}

/** Renormalize ratios so they sum to exactly 1. Recovers from
 *  rounding drift or malformed persisted state. */
export function normalizeRatios(ratios: number[]): number[] {
  if (ratios.length === 0) return []
  const total = ratios.reduce((sum, value) => sum + value, 0)
  if (total <= 0) return equalRatios(ratios.length)
  return ratios.map(value => value / total)
}

/** Float-tolerant ratio equality — used to skip setState when a
 *  tile-tab resize hasn't produced a visible change. */
export function ratiosEqual(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i] - b[i]) > 0.0001) return false
  }
  return true
}

/** Sanitize TileTabsState against invariants:
 *    - At least 2 tile-tabs (single-tab tiled mode is a no-op).
 *    - Deduplicate tabIds.
 *    - focusedTabId must be one of tabIds (falls back to head).
 *    - Ratios count matches tabIds count (rebuild equal ratios
 *      otherwise).
 *  Returns null when the state collapses to an invalid shape — the
 *  caller clears tile-tabs mode. */
export function sanitizeTileTabsState(tileTabs: TileTabsState): TileTabsState | null {
  if (tileTabs.tabIds.length < 2) return null
  const tabIds = Array.from(new Set(tileTabs.tabIds))
  if (tabIds.length < 2) return null
  const focusedTabId = tabIds.includes(tileTabs.focusedTabId)
    ? tileTabs.focusedTabId
    : tabIds[0]
  const ratios = tileTabs.ratios.length === tabIds.length
    ? normalizeRatios(tileTabs.ratios)
    : equalRatios(tabIds.length)
  return {
    ...tileTabs,
    tabIds,
    focusedTabId,
    ratios,
  }
}

/**
 * Cheap structural comparison for SlashPickerState. The picker object
 * itself is always fresh (parsed anew from each terminal snapshot in
 * main), so reference equality never holds — we have to look at the
 * visible flag, the item count, and the per-item id + selected bit.
 * IDs are short strings, items cap at ~15, so this runs in microseconds
 * and is still vastly cheaper than letting a no-op screen frame
 * propagate into a React render.
 */
export function pickerEqual(
  a: SlashPickerState,
  b: SlashPickerState,
): boolean {
  if (a.visible !== b.visible) return false
  if (a.items.length !== b.items.length) return false
  for (let i = 0; i < a.items.length; i++) {
    const x = a.items[i]
    const y = b.items[i]
    if (x.id !== y.id || x.selected !== y.selected) return false
  }
  return true
}

/** Walk the tile tree and set the ratio of the split whose `a`
 *  subtree contains aSession and whose `b` subtree contains
 *  bSession. Ratios clamp to [0.1, 0.9] so no pane vanishes. Used
 *  by drag-resize in TileLeaf and the split-ratio palette commands. */
export function setRatioBetween(
  node: TileNode,
  aSession: SessionId,
  bSession: SessionId,
  ratio: number,
): TileNode {
  if (node.type === 'leaf') return node
  const leavesA = collectLeaves(node.a)
  const leavesB = collectLeaves(node.b)
  if (leavesA.includes(aSession) && leavesB.includes(bSession)) {
    return { ...node, ratio: Math.min(0.9, Math.max(0.1, ratio)) }
  }
  return {
    ...node,
    a: setRatioBetween(node.a, aSession, bSession, ratio),
    b: setRatioBetween(node.b, aSession, bSession, ratio),
  }
}
