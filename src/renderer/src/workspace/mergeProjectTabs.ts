import type {
  SessionId,
  SessionMeta,
  TabId,
  WorkspaceState,
} from '@renderer/workspace/types'
import { resolveTabSessions } from '@renderer/workspace/queries'

// Merge Project Tabs (#913): fold source projects into a target project WITHOUT
// touching any process.
//
// WHY a pure planner over WorkspaceState instead of a sequence of existing
// actions: `closeTab` kills every session it owns, which is the one thing a
// merge must never do. Doing the whole re-pointing in one pure function makes
// the invariant testable in isolation: the owned-session set
// (`collectOwnedSessionIds`) is identical before and after, so no session can
// be orphaned and then deleted by the next autosave.
//
// WHAT a merge is now (#992): every session of a source project is re-filed
// under the target — `projectId` changes, nothing else — and the emptied
// source projects are removed. Until the unified layout this was three
// re-pointings over three owner structures (source tile leaves became detached
// records of the target, because attaching them would have turned the target's
// tree into a wall of splits; source detached records got a new
// `projectTabId`; buried records a new `sourceTabId`), plus a refresh of the
// display-index snapshots each record carried.
//
// WHY moved sessions are APPENDED to the target's index, in the order they
// were listed: a merge is "put these in here too". Keeping each session's old
// `joinedAt` would interleave them with the target's own rows by creation
// time — and a migrated v2 tree leaf holds a tiny ordinal, so it would jump
// ABOVE everything the target already had. Appending is predictable and
// leaves the target's existing labels where they were.
//
// WHY there is no undo entry: undo-close exists to bring back sessions that
// were KILLED, by re-spawning them from a captured SessionMeta. A merge kills
// nothing, so there is nothing to re-spawn, and the sessions have kept running
// and may since have been moved or closed. Every moved agent stays reachable
// in the target's index.
//
// What is deliberately left alone, because every session survives and these
// are keyed by session, not project: lanes, lane focus, pins, expanded
// parents, and undo entries anchored on a source project (they resolve as
// stale — see UndoLineage for why a merge never publishes lineage).

export type MergeProjectTabsInput = {
  targetTabId: TabId
  sourceTabIds: readonly TabId[]
  /** Base stamp for the moved sessions' new index positions; injected so
   *  tests are deterministic. */
  now: number
}

export type MergeProjectTabsSummary = {
  targetTabId: TabId
  targetTitle: string
  /** Index of the target in the merged project array (the letter it shows). */
  targetIndex: number
  removedTabIds: TabId[]
  /** Every session re-filed under the target, in its new index order. */
  movedSessionIds: SessionId[]
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

  // Source projects in PROJECT order (not the order the caller named them),
  // each in its own index order: the merged list reads top-to-bottom the way
  // the separate lists did.
  const movedSessionIds = state.tabs
    .filter(tab => sourceSet.has(tab.id))
    .flatMap(tab => resolveTabSessions(state, tab.id))
  // Strictly after everything the target already lists, whatever clock those
  // rows were stamped with.
  const lastTargetPosition = resolveTabSessions(state, target.id)
    .reduce((max, id) => Math.max(max, state.sessions[id]?.joinedAt ?? 0), 0)
  const base = Math.max(input.now, lastTargetPosition + 1)
  const sessions: Record<SessionId, SessionMeta> = { ...state.sessions }
  movedSessionIds.forEach((sessionId, offset) => {
    sessions[sessionId] = { ...sessions[sessionId]!, projectId: target.id, joinedAt: base + offset }
  })

  // Row project filters name tabs; a filter that named a source now names the
  // target once. Lanes are session-keyed and need nothing.
  //
  // `rows` is optional on a stage that predates the grid (a flat lane list);
  // such a stage has no row metadata to re-point, so it is passed through
  // untouched rather than normalized here — normalizing is the reducers' job
  // and doing it as a side effect of a merge would hide the write.
  const stageRows = state.stage.rows
  const stage = stageRows
    ? {
        ...state.stage,
        rows: stageRows.map(row => {
          const bound = row.projectTabIds ?? (row.projectTabId ? [row.projectTabId] : undefined)
          if (!bound || !bound.some(id => sourceSet.has(id))) return row
          const { projectTabId: _legacy, ...rest } = row
          const projectTabIds = [...new Set(bound.map(id => (sourceSet.has(id) ? target.id : id)))]
          return { ...rest, projectTabIds }
        }),
      }
    : state.stage

  return {
    ok: true,
    state: {
      ...state,
      tabs,
      activeTabId: sourceSet.has(state.activeTabId) ? target.id : state.activeTabId,
      sessions,
      stage,
    },
    summary: {
      targetTabId: target.id,
      targetTitle: target.title,
      targetIndex,
      removedTabIds: sources,
      movedSessionIds,
    },
  }
}

