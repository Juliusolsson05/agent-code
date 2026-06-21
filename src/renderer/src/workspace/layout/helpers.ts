import type { SessionId, TileNode } from '@renderer/workspace/types'
import type { SlashPickerState, TileTabsState } from '@renderer/workspace/workspaceState'
import type { ClaudeAskUserQuestionState } from '@shared/types/providerConditions'

// Layout & picker utilities for the workspace store.
//
// These are the small pure helpers the useWorkspace hook calls
// inline during layout mutations — tab titling, ratio math, tile-
// tabs state sanitization, picker equality, split-ratio walking.
// Separated out because they're the most easily unit-testable
// shapes in the whole workspace module and don't need any React
// or session-state context.

/** Derive a tab title from a cwd — use the last path segment
 *  ("agent-code"), falling back to the full cwd if none. */
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

/** Structural equality for the live AskUserQuestion state, used by the
 *  screen IPC handler's no-op bail (screen frames fire ~60Hz; without a
 *  cheap equality check every idle frame would churn `runtimes` state).
 *
 *  The transition that MATTERS most for the stale-render fix is
 *  presence↔absence (null ↔ non-null) — that's the edge that mounts or
 *  dismisses the picker row — so we check that first. We then compare the
 *  cursor/toggle fields so the LATER answering PR (which reads them live)
 *  gets fresh state without needing to touch this function. Options are
 *  compared by number+toggled (label changes don't happen mid-picker). */
export function askUserQuestionEqual(
  a: ClaudeAskUserQuestionState | null,
  b: ClaudeAskUserQuestionState | null,
): boolean {
  if (a === b) return true
  if (!a || !b) return false // presence differs — the load-bearing edge
  if (a.mode !== b.mode) return false
  if (a.cursorNumber !== b.cursorNumber) return false
  if (a.submitFocused !== b.submitFocused) return false
  if (a.options.length !== b.options.length) return false
  for (let i = 0; i < a.options.length; i++) {
    if (
      a.options[i].number !== b.options[i].number ||
      a.options[i].toggled !== b.options[i].toggled
    ) {
      return false
    }
  }
  return true
}

/** Walk the tile tree and set the ratio of the split whose `a`
 *  subtree contains aSession and whose `b` subtree contains
 *  bSession. Ratios clamp to [0.1, 0.9] so no pane vanishes. Used
 *  by drag-resize in TileLeaf and the split-ratio palette commands. */
function containsSession(node: TileNode, sessionId: SessionId): boolean {
  if (node.type === 'leaf') return node.sessionId === sessionId
  return containsSession(node.a, sessionId) || containsSession(node.b, sessionId)
}

export function setRatioBetween(
  node: TileNode,
  aSession: SessionId,
  bSession: SessionId,
  ratio: number,
): TileNode {
  if (node.type === 'leaf') return node
  const aContainsA = containsSession(node.a, aSession)
  const bContainsB = containsSession(node.b, bSession)
  if (aContainsA && bContainsB) {
    const nextRatio = Math.min(0.9, Math.max(0.1, ratio))
    return Math.abs(nextRatio - node.ratio) < 0.001 ? node : { ...node, ratio: nextRatio }
  }
  // WHY recurse only into sides that can still contain both endpoints:
  // the old implementation collected both subtree leaf arrays at every
  // split, making divider drag O(N^2) in pane count. Drag is a per-frame
  // path, so repeated array allocation here turns directly into UI jank.
  // Membership checks let us preserve the pure immutable tree update while
  // avoiding most work on branches that cannot possibly hold the target split.
  const aHasBoth = aContainsA && containsSession(node.a, bSession)
  const bHasBoth = containsSession(node.b, aSession) && bContainsB
  if (!aHasBoth && !bHasBoth) return node
  const nextA = aHasBoth ? setRatioBetween(node.a, aSession, bSession, ratio) : node.a
  const nextB = bHasBoth ? setRatioBetween(node.b, aSession, bSession, ratio) : node.b
  if (nextA === node.a && nextB === node.b) return node
  return {
    ...node,
    a: nextA,
    b: nextB,
  }
}
