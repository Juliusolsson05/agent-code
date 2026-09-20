import type {
  ProjectRef,
  SessionId,
  TabId,
  TiledDispatchState,
  WorkspaceState,
} from '@renderer/workspace/types'
import { normalizeStage } from '@renderer/workspace/dispatch/tiledDispatchSelectors'

// ---------------------------------------------------------------------------
// Live v3 views over the current workspace state (#992).
//
// New UI code consumes THESE functions rather than reaching into state. That
// indirection is what let the v2 structures (tab tile trees, the detached and
// buried buckets) be deleted underneath their readers in #992, and it is what
// will let the in-memory `tabs`/`activeTabId` names be changed later.
//
// History: through stage 2 of the merge the lane grid lived in an optional
// `dispatchMode.tiled`, and `stageOfWorkspace` DERIVED a seeded default for a
// workspace that had none, behind a one-slot reference cache. The stage is a
// required field now (`WorkspaceState.stage`), so there is nothing to derive
// and no cache to keep coherent.
// ---------------------------------------------------------------------------

/**
 * The stage, shape-normalized. `normalizeStage` returns the SAME reference
 * when the stored grid is already current, which is the identity contract the
 * lane memos downstream rely on.
 */
export function stageOfWorkspace(state: { stage: TiledDispatchState }): TiledDispatchState {
  return normalizeStage(state.stage)
}

/**
 * Projects (former tabs) as grouping-only references: id + title. Ids are the
 * old TabIds, so labels, row bindings and `A1/B7` letters are stable across
 * the merge.
 */
export function projectsOfWorkspace(state: Pick<WorkspaceState, 'tabs'>): ProjectRef[] {
  return state.tabs.map(tab => ({ id: tab.id, title: tab.title }))
}

/** The active project: spawn defaults + index highlight. Owns nothing. */
export function activeProjectIdOfWorkspace(state: Pick<WorkspaceState, 'activeTabId'>): TabId {
  return state.activeTabId
}

/**
 * A session's project, falling back to the active project.
 *
 * The row's own `projectId` is the answer. The fallback covers exactly one
 * case: the instant between `spawn` writing a session's row and its caller
 * filing it (pool.ts), when a reader that needs SOME project — a spawn-cwd
 * default, a label — is better served by "where the user is" than by nothing.
 *
 * It is deliberately NOT validated against the projects that exist. A value
 * naming a project that is gone is a ghost the ownership prune will drop; the
 * index groups by projects that exist, so it is invisible rather than
 * corrupting, and re-parenting it here would be the layout rearranging itself
 * for reasons the user did not ask for (#681's whole bug class).
 *
 * (Until #992 this delegated to a shared precedence over three owner
 * structures: tile leaf, then detached record, then buried record.)
 */
export function projectIdOfSession(
  state: Pick<WorkspaceState, 'sessions' | 'activeTabId'>,
  sessionId: SessionId,
): TabId {
  return state.sessions[sessionId]?.projectId ?? state.activeTabId
}
