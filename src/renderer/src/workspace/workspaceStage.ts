import type {
  DispatchModeState,
  ProjectRef,
  SessionId,
  TabId,
  TiledDispatchState,
} from '@renderer/workspace/types'
import { normalizeDispatchModeGrid } from '@renderer/workspace/dispatch/tiledDispatchSelectors'
import {
  defaultSeededStage,
  projectAffinityOf,
  resolveEntrySeed,
  type WorkspaceAffinityInput,
} from '@renderer/workspace/workspaceShape'

// ---------------------------------------------------------------------------
// Live v3 views over the current workspace state (#992, stage 2).
//
// WHY derivation instead of a second source of truth: during the staged
// merge the v2 structures (tabs trees, detachedSessions, dispatchMode) are
// still the STORED state that actions mutate. Rather than dual-writing a
// parallel v3 state on every action, the stage/projects/pool-affinity views
// are derived here with the SAME precedence the persisted migration uses
// (workspaceShape.ts exports the shared helpers). Stage 3 inverts this:
// v3 becomes stored, v2 is deleted, and these selectors collapse into
// plain field reads.
//
// Every new UI code should consume THESE functions, never
// `state.dispatchMode?.tiled` or tab trees directly — that is what makes
// stage 3 a deletion instead of a rewrite.
// ---------------------------------------------------------------------------

/**
 * The stage: ragged rows of lanes. A stored tiled grid passes through
 * normalized (same repair chain rehydrate applies); a workspace with no
 * grid gets the seeded default — which is #977's entry continuity, derived
 * rather than written, so it can never go stale or desync from disk.
 */
export function stageOfWorkspace(state: WorkspaceAffinityInput): TiledDispatchState {
  const normalized = normalizeDispatchModeGrid(state.dispatchMode ?? null)
  if (normalized?.tiled) return normalized.tiled
  return derivedDefaultStage(state)
}

// One-slot reference cache for the derived default stage. WHY: components
// memoize on the returned object; recomputing a fresh (deep-equal) stage on
// every unrelated state change would defeat every downstream memo and
// remount lanes for free. The cache key is the two inputs the derivation
// actually reads — the dispatchMode reference and the resolved seed id —
// so any change to either produces a new stage object while everything
// else returns the cached one. A stored grid never enters this cache
// (normalizeDispatchModeGrid already returns a stable reference).
let derivedStageCache: {
  dispatchMode: DispatchModeState | null | undefined
  seed: SessionId | null
  stage: TiledDispatchState
} | null = null

function derivedDefaultStage(state: WorkspaceAffinityInput): TiledDispatchState {
  const seed = resolveEntrySeed(state)
  if (
    derivedStageCache &&
    derivedStageCache.dispatchMode === state.dispatchMode &&
    derivedStageCache.seed === seed
  ) {
    return derivedStageCache.stage
  }
  const stage = defaultSeededStage(seed)
  derivedStageCache = { dispatchMode: state.dispatchMode, seed, stage }
  return stage
}

/**
 * Projects (former tabs) as grouping-only references: id + title. Live
 * derivation from tabs keeps ids identical to the persisted migration's,
 * so labels, row bindings, and `A1/B7` letters are stable across the merge.
 */
export function projectsOfWorkspace(state: WorkspaceAffinityInput): ProjectRef[] {
  return state.tabs.map(tab => ({ id: tab.id, title: tab.title }))
}

/** The active project: spawn defaults + index highlight. Owns nothing. */
export function activeProjectIdOfWorkspace(state: WorkspaceAffinityInput): TabId {
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
