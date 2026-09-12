import type {
  DetachedSessionRecord,
  SessionId,
  TabId,
  TileTabsState,
  WorkspaceState,
} from '@renderer/workspace/types'
import { collectLeaves } from '@renderer/workspace/tile-tree/treeOps'
import { sanitizeTileTabsState } from '@renderer/workspace/layout/helpers'

// Merge Project Tabs (#913): fold source tabs into a target tab WITHOUT
// touching any process.
//
// WHY a pure planner over WorkspaceState instead of a sequence of existing
// actions (detach, close tab): `closeTab` kills every session it owns, which
// is the one thing a merge must never do, and `detachSession` refuses the last
// grid pane of a tab because a tab cannot exist without a tile tree. A merge
// removes the tab itself, so that guard does not apply; the leaf simply
// becomes a detached record of the target. Doing the whole re-pointing in one
// pure function makes the invariant testable in isolation: the owned-session
// set (`collectOwnedSessionIds`) is identical before and after, so no session
// can be orphaned and then deleted by the next autosave.
//
// WHY source grid panes go to Dispatch rather than into the target's grid:
// `Tab.root` is a tile tree the user built. Attaching every source pane would
// turn one tab into a wall of splits, and `buildDispatchGroups` already lists
// detached sessions under their tab, so nothing is hidden. The user attaches
// what they want afterwards.

export type MergeProjectTabsInput = {
  targetTabId: TabId
  sourceTabIds: readonly TabId[]
  /** Stamp for the new detached records; injected so tests are deterministic. */
  now: number
}

export type MergeProjectTabsSummary = {
  targetTabId: TabId
  targetTitle: string
  /** Index of the target in the merged tab array (the letter Dispatch shows). */
  targetIndex: number
  removedTabIds: TabId[]
  /** Source grid panes that became detached records of the target. */
  detachedFromGrid: SessionId[]
  /** Source detached records re-pointed at the target. */
  repointedDetached: SessionId[]
  /** Buried records re-pointed at the target. */
  repointedBuried: SessionId[]
}

export type MergeProjectTabsResult =
  | { ok: true; state: WorkspaceState; summary: MergeProjectTabsSummary }
  | { ok: false; reason: 'unknown_tab' | 'target_is_source' | 'nothing_to_merge' }

export function mergeProjectTabs(
  state: WorkspaceState,
  input: MergeProjectTabsInput,
): MergeProjectTabsResult {
  const sources = [...new Set(input.sourceTabIds)]
  if (sources.length === 0) return { ok: false, reason: 'nothing_to_merge' }
  if (sources.includes(input.targetTabId)) return { ok: false, reason: 'target_is_source' }
  const known = new Set(state.tabs.map(tab => tab.id))
  if (!known.has(input.targetTabId) || sources.some(id => !known.has(id))) {
    return { ok: false, reason: 'unknown_tab' }
  }
  const sourceSet = new Set(sources)

  const tabs = state.tabs.filter(tab => !sourceSet.has(tab.id))
  const targetIndex = tabs.findIndex(tab => tab.id === input.targetTabId)
  const target = tabs[targetIndex]!
  const affinity = {
    projectTabId: target.id,
    projectTabTitle: target.title,
    projectTabIndex: targetIndex,
  }

  const detachedSessions: Record<SessionId, DetachedSessionRecord> = {}
  const repointedDetached: SessionId[] = []
  for (const [sessionId, record] of Object.entries(state.detachedSessions)) {
    if (sourceSet.has(record.projectTabId)) {
      detachedSessions[sessionId] = { ...record, ...affinity }
      repointedDetached.push(sessionId)
    } else {
      detachedSessions[sessionId] = record
    }
  }
  const detachedFromGrid: SessionId[] = []
  for (const tab of state.tabs) {
    if (!sourceSet.has(tab.id)) continue
    for (const sessionId of collectLeaves(tab.root)) {
      // A leaf with no SessionMeta is already an orphan the ownership rules
      // would drop; carrying it as a detached record would only resurrect it.
      if (!state.sessions[sessionId]) continue
      detachedSessions[sessionId] = {
        sessionId,
        surface: 'dispatch',
        ...affinity,
        detachedAt: input.now,
      }
      detachedFromGrid.push(sessionId)
    }
  }

  const repointedBuried: SessionId[] = []
  const buried = state.buried.map(record => {
    if (!sourceSet.has(record.sourceTabId)) return record
    repointedBuried.push(record.sessionId)
    return {
      ...record,
      sourceTabId: target.id,
      sourceTabTitle: target.title,
      sourceTabIndex: targetIndex,
    }
  })

  // Row project filters name tabs; a filter that named a source now names the
  // target once. Lanes are session-keyed and need nothing.
  const tiledRows = state.dispatchMode?.tiled?.rows
  const dispatchMode = state.dispatchMode?.tiled && tiledRows
    ? {
        ...state.dispatchMode,
        tiled: {
          ...state.dispatchMode.tiled,
          rows: tiledRows.map(row => {
            const bound = row.projectTabIds ?? (row.projectTabId ? [row.projectTabId] : undefined)
            if (!bound || !bound.some(id => sourceSet.has(id))) return row
            const { projectTabId: _legacy, ...rest } = row
            const projectTabIds = [...new Set(bound.map(id => (sourceSet.has(id) ? target.id : id)))]
            return { ...rest, projectTabIds }
          }),
        },
      }
    : state.dispatchMode

  return {
    ok: true,
    state: {
      ...state,
      tabs,
      activeTabId: sourceSet.has(state.activeTabId) ? target.id : state.activeTabId,
      detachedSessions,
      buried,
      dispatchMode,
    },
    summary: {
      targetTabId: target.id,
      targetTitle: target.title,
      targetIndex,
      removedTabIds: sources,
      detachedFromGrid,
      repointedDetached,
      repointedBuried,
    },
  }
}

/**
 * The tiled-tabs half of a merge, shaped as a functional update so the hook
 * can apply it through `setTileTabs(prev => ...)` against the live value
 * rather than a render-time snapshot. Sources leave the tiled set; focus moves
 * to the target when it was on a source and the target is tiled, else to the
 * first remaining tab; `sanitizeTileTabsState` exits tiled tabs below two.
 */
export function retargetTileTabsAfterMerge(
  tileTabs: TileTabsState | null,
  sourceTabIds: readonly TabId[],
  targetTabId: TabId,
): TileTabsState | null {
  if (!tileTabs) return null
  const sourceSet = new Set(sourceTabIds)
  const kept = tileTabs.tabIds
    .map((id, index) => ({ id, ratio: tileTabs.ratios[index] }))
    .filter(item => !sourceSet.has(item.id))
  const tabIds = kept.map(item => item.id)
  const ratios = kept.map(item => item.ratio).filter((ratio): ratio is number => typeof ratio === 'number')
  const focusedTabId = sourceSet.has(tileTabs.focusedTabId)
    ? (tabIds.includes(targetTabId) ? targetTabId : (tabIds[0] ?? tileTabs.focusedTabId))
    : tileTabs.focusedTabId
  return sanitizeTileTabsState({
    ...tileTabs,
    tabIds,
    focusedTabId,
    ratios: ratios.length === tabIds.length ? ratios : [],
  })
}
