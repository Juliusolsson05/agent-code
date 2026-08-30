import type { DispatchAgentRow } from '@renderer/workspace/dispatch/dispatchSelectors'
import type { DispatchGridRow, SessionId } from '@renderer/workspace/types'

// ============================================================================
// What ONE grid row shows.
//
// A grid row is a complete dispatch view: it can be bound to a single project,
// and it can collapse an orchestration parent's children. Both are properties
// of the ROW, so two rows over the same workspace legitimately show different
// lists.
//
// CRITICAL: this is a PRESENTATION filter. It never reaches
// buildVisibleDispatchRows, so labels, globalIndex, cmd+N targeting, lane
// resolution, and command targeting are all computed from the full canonical
// row set exactly as before. A filtered row therefore shows GAPS — D12, D15,
// D17 — which is correct and readable, and an agent's label never changes
// because a view was toggled.
//
// buildVisibleDispatchRows' own header is the reason: keyboard navigation,
// command targeting, and the rendered list must agree on one linear order or
// "the highlighted row and the acted-on session drift apart". Renumbering on
// collapse would break exactly that.
// ============================================================================

/**
 * Children shown before a parent collapses.
 *
 * TUNABLE, NOT A FINDING. No recording in this repository contains a parent
 * with more than two children, so this threshold has never fired on real data —
 * see docs/decomposition/grid-dispatch.md, U1. It is a starting value chosen
 * because three children is about where a parent stops reading as one item in
 * a scanned list. Do not defend the number; change it if real use disagrees.
 */
export const ORCHESTRATION_CHILD_CAP = 3

export type RowScopedItem =
  | { kind: 'agent'; row: DispatchAgentRow; hidden?: undefined }
  | { kind: 'more'; parentSessionId: SessionId; hidden: number }
  | { kind: 'fewer'; parentSessionId: SessionId; hidden?: undefined }

/**
 * Project-filter and child-collapse the canonical rows for one grid row.
 *
 * Filtering happens BEFORE capping. A project filter can remove a parent's
 * siblings but never its children (a child lives in its parent's tab), so
 * capping first would count children the row does not even show.
 */
export function rowScopedRows(
  rows: DispatchAgentRow[],
  gridRow: Pick<DispatchGridRow, 'projectTabId' | 'capChildren' | 'expandedParents'>,
): RowScopedItem[] {
  const visible = gridRow.projectTabId === undefined
    ? rows
    : rows.filter(row => row.tabId === gridRow.projectTabId)

  // Absent means capped: one orchestration parent can spawn ten reviewers, and
  // ten depth-1 rows push every other project off-screen for agents the user is
  // not watching.
  if (gridRow.capChildren === false) {
    return visible.map(row => ({ kind: 'agent', row }))
  }

  const expanded = new Set(gridRow.expandedParents ?? [])
  const items: RowScopedItem[] = []

  for (let i = 0; i < visible.length; i++) {
    const row = visible[i]!
    items.push({ kind: 'agent', row })
    if (row.depth !== 0) continue

    // The children of this parent are the run of depth-1 rows that follows it.
    //
    // WHY grouping is positional rather than by a parent id: DispatchAgentRow
    // carries `depth`, not a parent reference, and depth is precisely what the
    // list renders as nesting. Following the visual structure is also what makes
    // the orphan case correct — buildDispatchGroups emits a child at depth 0
    // when its parent is absent from the group (scope filter, closed parent, or
    // a PINNED parent, since pins are pulled into their own section). Such a row
    // is indistinguishable from an ordinary agent, and hiding it under a "+N
    // more" belonging to a parent the user cannot see would be strictly worse
    // than showing it. So it is not capped, by construction.
    let end = i + 1
    while (end < visible.length && visible[end]!.depth === 1) end += 1
    const children = visible.slice(i + 1, end)
    i = end - 1

    if (children.length === 0) continue

    if (expanded.has(row.sessionId)) {
      for (const child of children) items.push({ kind: 'agent', row: child })
      items.push({ kind: 'fewer', parentSessionId: row.sessionId })
      continue
    }
    if (children.length <= ORCHESTRATION_CHILD_CAP) {
      for (const child of children) items.push({ kind: 'agent', row: child })
      continue
    }
    for (const child of children.slice(0, ORCHESTRATION_CHILD_CAP)) {
      items.push({ kind: 'agent', row: child })
    }
    items.push({
      kind: 'more',
      parentSessionId: row.sessionId,
      hidden: children.length - ORCHESTRATION_CHILD_CAP,
    })
  }

  return items
}
