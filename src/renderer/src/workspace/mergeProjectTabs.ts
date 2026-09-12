import type {
  DetachedSessionRecord,
  SessionId,
  TabId,
  TileTabsState,
  WorkspaceState,
} from '@renderer/workspace/types'
import { collectLeaves } from '@renderer/workspace/tile-tree/treeOps'
import { sanitizeTileTabsState } from '@renderer/workspace/layout/helpers'
import { hasSessionMeta } from '@renderer/workspace/sessionOwnership'

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
//
// WHY there is no undo entry: undo-close exists to bring back sessions that
// were KILLED, by re-spawning them from a captured SessionMeta. A merge kills
// nothing, so there is nothing to re-spawn; reversing it would mean rebuilding
// the removed tabs' tile trees from a snapshot while the sessions inside them
// have kept running and may since have been attached, buried or closed. Every
// moved agent stays reachable in the target's Dispatch list, so the manual
// reverse (new tab, attach) is always available and never lossy.
//
// A consequence worth knowing before relying on "nothing restarts": it is true
// for the running app only. Grid panes are the only sessions rehydrate spawns
// at launch (`collectLiveProcessIds`); a merged pane is now a detached record,
// so after the next launch it is hibernated like every other Dispatch agent
// and wakes on its first use instead of being live from the start.
//
// What is deliberately left alone, because every session survives and these
// are keyed by session, not tab: Dispatch lanes, lane focus, pins, expanded
// parents, `gridRelatedSelections` (only read for grid panes, and
// `detachSessionToDispatch` leaves them too), and pane-close undo entries
// anchored on a source pane (they resolve as stale, exactly as after a
// detach).

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
  // Removing tabs shifts the index of every tab after them, and the records
  // of SURVIVING tabs carry that index as a snapshot (`projectTabIndex`,
  // `sourceTabIndex`). `buildDispatchGroups` recomputes it at render, but the
  // agent-status model reads the raw value, and a merge that leaves the
  // target's own records one letter behind the ones it just received would
  // show two letters for one tab. `closeTab` leaves these stale and relies on
  // the recompute; here the whole state is in hand, so refreshing is free.
  const indexOf = new Map(tabs.map((tab, index) => [tab.id, index] as const))

  const detachedSessions: Record<SessionId, DetachedSessionRecord> = {}
  const repointedDetached: SessionId[] = []
  for (const [sessionId, record] of Object.entries(state.detachedSessions)) {
    if (sourceSet.has(record.projectTabId)) {
      detachedSessions[sessionId] = { ...record, ...affinity }
      repointedDetached.push(sessionId)
      continue
    }
    const index = indexOf.get(record.projectTabId)
    detachedSessions[sessionId] = index === undefined || index === record.projectTabIndex
      ? record
      : { ...record, projectTabIndex: index }
  }
  const detachedFromGrid: SessionId[] = []
  for (const tab of state.tabs) {
    if (!sourceSet.has(tab.id)) continue
    for (const sessionId of collectLeaves(tab.root)) {
      // A leaf with no SessionMeta is already an orphan the ownership rules
      // would drop; carrying it as a detached record would only resurrect it.
      // Same own-property test as ownership, so the two never disagree about
      // what counts as metadata.
      if (!hasSessionMeta(state.sessions, sessionId)) continue
      // A pane that already has a detached record is a pre-existing
      // ownership violation (a session cannot be both a grid leaf and
      // detached). The merge ends it: the pane is no longer a leaf, so the
      // record becomes its only owner. Keep the record's own stamp and count
      // the session once, under whichever list already claimed it.
      const existing = detachedSessions[sessionId]
      if (existing) {
        detachedSessions[sessionId] = { ...existing, ...affinity }
        if (!repointedDetached.includes(sessionId)) repointedDetached.push(sessionId)
        continue
      }
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
    if (sourceSet.has(record.sourceTabId)) {
      repointedBuried.push(record.sessionId)
      return {
        ...record,
        sourceTabId: target.id,
        sourceTabTitle: target.title,
        sourceTabIndex: targetIndex,
      }
    }
    const index = indexOf.get(record.sourceTabId)
    return index === undefined || index === record.sourceTabIndex
      ? record
      : { ...record, sourceTabIndex: index }
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
 * rather than a render-time snapshot.
 *
 * WHY a tiled source is REPLACED by the target rather than dropped when the
 * target is not itself tiled: the user was looking at that source's tile, and
 * after the merge its agents belong to the target. Dropping the slot would
 * leave `activeTabId` on the target while `MainSurface` keeps rendering the
 * tiled set (it renders tiled tabs whenever the layout is set), so the tab the
 * user just kept would be the one tab not on screen. Only the first tiled
 * source takes the slot; the rest leave, and `sanitizeTileTabsState` exits
 * tiled tabs below two. Focus follows the same rule, so a focus that sat on a
 * source always lands on the target, which is tiled in either branch.
 */
export function retargetTileTabsAfterMerge(
  tileTabs: TileTabsState | null,
  sourceTabIds: readonly TabId[],
  targetTabId: TabId,
): TileTabsState | null {
  if (!tileTabs) return null
  const sourceSet = new Set(sourceTabIds)
  let slotTaken = tileTabs.tabIds.includes(targetTabId)
  const kept = tileTabs.tabIds
    .map((id, index) => ({ id, ratio: tileTabs.ratios[index] }))
    .flatMap(item => {
      if (!sourceSet.has(item.id)) return [item]
      if (slotTaken) return []
      slotTaken = true
      return [{ id: targetTabId, ratio: item.ratio }]
    })
  const tabIds = kept.map(item => item.id)
  const ratios = kept.map(item => item.ratio).filter((ratio): ratio is number => typeof ratio === 'number')
  const focusedTabId = sourceSet.has(tileTabs.focusedTabId) ? targetTabId : tileTabs.focusedTabId
  return sanitizeTileTabsState({
    ...tileTabs,
    tabIds,
    focusedTabId,
    ratios: ratios.length === tabIds.length ? ratios : [],
  })
}
