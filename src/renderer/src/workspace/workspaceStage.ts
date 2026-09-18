import type {
  ProjectRef,
  SessionId,
  TabId,
  TiledDispatchState,
} from '@renderer/workspace/types'
import { normalizeStage } from '@renderer/workspace/dispatch/tiledDispatchSelectors'
import {
  projectAffinityOf,
  type WorkspaceAffinityInput,
} from '@renderer/workspace/workspaceShape'

// ---------------------------------------------------------------------------
// Live v3 views over the current workspace state (#992).
//
// New UI code consumes THESE functions rather than reaching into state, which
// is what lets the remaining v2 structures (tab tile trees, the detached
// bucket) be deleted underneath them without a rewrite of every reader.
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
export function projectsOfWorkspace(state: Pick<WorkspaceAffinityInput, 'tabs'>): ProjectRef[] {
  return state.tabs.map(tab => ({ id: tab.id, title: tab.title }))
}

/** The active project: spawn defaults + index highlight. Owns nothing. */
export function activeProjectIdOfWorkspace(state: Pick<WorkspaceAffinityInput, 'activeTabId'>): TabId {
  return state.activeTabId
}

/**
 * A session's project, live view. Delegates to the shared precedence
 * (leaf → detached → buried → active) with NO ghost-project guard:
 *
 * WHY unguarded when the migration guards: persisted v3 must never store a
 * dangling projectId (it would filter the session out of every index
 * forever), but live state legitimately holds a transient dangling value
 * between "tab closed" and the same-boundary prune that clears its
 * detached records. Index rendering groups by projects that exist, so the
 * transient value is invisible rather than corrupting. Guarding here would
 * silently re-parent sessions mid-interaction — the layout rearranging
 * itself for reasons the user did not ask for (#681's whole bug class).
 */
export function projectIdOfSession(
  state: WorkspaceAffinityInput,
  sessionId: SessionId,
): TabId {
  return projectAffinityOf(state, sessionId) ?? state.activeTabId
}
