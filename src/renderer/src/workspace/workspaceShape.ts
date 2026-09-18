import type { PersistedWorkspace } from '@renderer/workspace/persistence'
import type {
  DispatchModeState,
  ProjectRef,
  SessionId,
  SessionMeta,
  TabId,
  TiledDispatchState,
} from '@renderer/workspace/types'
import { collectLeaves } from '@renderer/workspace/tile-tree/treeOps'
import { collectOwnedSessionIds } from '@renderer/workspace/sessionOwnership'
import {
  keepTiledLaneSessions,
  normalizeDispatchModeGrid,
  scrubGridRowMetadata,
} from '@renderer/workspace/dispatch/tiledDispatchSelectors'
import { normalizeGridShape } from '@renderer/workspace/dispatch/gridShape'

// ---------------------------------------------------------------------------
// Unified-layout v2→v3 shape migration (#992).
//
// Plan: docs/superpowers/plans/2026-09-17-unified-stage-layout.md §6.
//
// WHY a pure function instead of schema-version bumping: the repo's standing
// discipline (proven by `normalizeGridShape` and the legacy `ratios` split)
// is that an unambiguous target shape migrates at read time as a pure,
// independently-tested transform. Hand-edited or half-written workspace files
// must repair rather than crash, and every rule below must be assertable from
// a recorded fixture rather than from imagination.
//
// WHAT THIS IS NOT: it does not touch live renderer state, spawn, wake, or
// rehydrate. Stage 1 ships it dormant; stage 2 wires it into the read path.
// ---------------------------------------------------------------------------

/**
 * A session as it lives in the v3 pool: SessionMeta with the project
 * membership made explicit. `SessionMeta.projectId` stays optional during
 * the staged merge (v2 sources don't have it); this type is what the pool
 * guarantees once the migration has run.
 */
export type PoolSession = SessionMeta & { projectId: TabId }

/**
 * The v3 workspace: the fleet pool plus the stage. Everything the old shape
 * spread across tabs[].root, detachedSessions, buried, and dispatchMode
 * collapses into `sessions` (pool) + `stage` (placement) + `projects`
 * (grouping).
 */
export type StageWorkspace = {
  projects: ProjectRef[]
  activeProjectId: TabId
  stage: TiledDispatchState
  sessions: Record<SessionId, PoolSession>
  pinnedSessionIds: SessionId[]
  /** Persisted composer drafts, filtered to surviving pool sessions. */
  drafts?: Record<SessionId, string>
}

/**
 * The v3 discriminant. Presence of `stage` means the file was written by
 * the unified layout; absence means v2 and `migrateWorkspaceToStage` applies.
 * WHY shape and not a number: additive fields with an unambiguous meaning
 * get read-time normalization here; a version integer would promise
 * downgrade-compatibility nobody has tested.
 */
export function isStageWorkspace(persisted: PersistedWorkspace): boolean {
  return persisted.stage !== undefined
}

/**
 * Resolve the session that owns lane 0 when a v2 workspace had NO tiled
 * stage (classic Dispatch or pure-grid user): the session the user was
 * commanding when they last looked at this workspace.
 *
 * WHY this precedence and no other: it mirrors `dispatchEntrySeedSessionId`
 * (tiledDispatchSelectors.ts) exactly — dispatch focus first, then the
 * active tab's grid focus, validated against sessions and buried. The two
 * must not drift: entering Grid Dispatch over a live state and migrating
 * the same state off disk must pick the same agent, or a reload changes
 * what the user sees relative to their last session. Stage 2 should
 * collapse the pair by making the live selector delegate here.
 *
 * WHY seeding does not violate #681: the seed is continuity with the pane
 * the user was just commanding, never a prediction from the index. All
 * other lanes arrive empty and stay empty.
 */
function resolveEntrySeed(persisted: PersistedWorkspace): SessionId | null {
  const dispatchFocused = persisted.dispatchMode?.focusedSessionId ?? null
  const gridFocused =
    persisted.tabs.find(tab => tab.id === persisted.activeTabId)?.focusedSessionId ?? null
  const candidate = dispatchFocused ?? gridFocused
  if (!candidate) return null
  if (persisted.sessions[candidate] === undefined) return null
  if ((persisted.buried ?? []).some(entry => entry.sessionId === candidate)) return null
  return candidate
}

/**
 * The default stage minted for a workspace that never had one:
 * `[{ length: 2 }]`, lane 0 seeded, focused.
 *
 * WHY two lanes and not one: one-lane-first-run is the FRESH-install shape
 * (§4.5 — nothing to explain, the user hasn't asked for space). A migrating
 * user demonstrably works with agents already; the second lane is the
 * smallest honest stage that shows what a lane IS without adding a row.
 * The seed write is the same continuity gesture enterTiledDispatch performs
 * (#977), applied once at migration.
 */
function defaultSeededStage(seed: SessionId | null): TiledDispatchState {
  const grid = normalizeGridShape({
    lanes: [seed ? { selectedSessionId: seed } : {}, {}],
    rows: [{ length: 2 }],
    focusedLane: 0,
  })
  return {
    lanes: grid.lanes,
    rows: grid.rows,
    focusedLane: grid.focusedLane,
    ...(grid.laneWeights ? { laneWeights: grid.laneWeights } : {}),
  }
}

/**
 * Migrate a v2 persisted workspace to the unified stage-over-fleet shape.
 *
 * Rules (plan §6), each with its enforcement below:
 *  1. tabs → projects (id/title kept; root trees are NOT reconstructed).
 *  2. every surviving session gets `projectId` (leaf membership, then
 *     detached record, then buried source, then activeTabId fallback).
 *  3. detached + buried fold into the pool — buried sessions were already
 *     live-while-hidden; the pool does not change that, it just stops
 *     pretending they are a different kind of thing.
 *  4. dispatchMode.tiled → stage; absent tiled → defaultSeededStage.
 *  5. ACCEPTED LOSS (recorded in the plan): multi-pane tab arrangements are
 *     pooled, not reconstructed. Live data showed 1-pane tabs; inventing
 *     rows from trees would surprise far more than it preserves.
 *  6. tileTabs, legacy `ratios`, `userEmptied`: dropped.
 *  7. unowned session rows are dropped — the same ownership rule rehydrate
 *     already enforces, so the migration can never resurrect what rehydrate
 *     would immediately delete (the #258 fork-bomb shape).
 */
export function migrateWorkspaceToStage(persisted: PersistedWorkspace): StageWorkspace {
  const projects: ProjectRef[] = persisted.tabs.map(tab => ({
    id: tab.id,
    title: tab.title,
  }))
  const projectIds = new Set<TabId>(projects.map(project => project.id))
  // Degenerate guard: v2 writers always keep >=1 tab (rehydrate mints one),
  // but a hand-emptied file must still migrate to something renderable. ''
  // is never a project id; stage-2 readers treat it as "no active project".
  const activeProjectId = projectIds.has(persisted.activeTabId)
    ? persisted.activeTabId
    : (projects[0]?.id ?? '')

  // --- Rule 2 inputs: the three v2 ways a session could know its project.
  // Leaf membership wins because it is the placement the user last arranged;
  // detached/buried carry their own affinity; the fallback keeps a corrupt
  // orphan at least inside the workspace's active group.
  const leafProject = new Map<SessionId, TabId>()
  for (const tab of persisted.tabs) {
    for (const sessionId of collectLeaves(tab.root)) {
      leafProject.set(sessionId, tab.id)
    }
  }
  const detachedProject = new Map<SessionId, TabId>()
  for (const record of Object.values(persisted.detachedSessions ?? {})) {
    detachedProject.set(record.sessionId, record.projectTabId)
  }
  const buriedProject = new Map<SessionId, TabId>()
  for (const record of persisted.buried ?? []) {
    buriedProject.set(record.sessionId, record.sourceTabId)
  }

  // --- Rule 7: the pool is the OWNED set, not the raw sessions map.
  const owned = collectOwnedSessionIds(persisted)
  const sessions: Record<SessionId, PoolSession> = {}
  for (const [sessionId, meta] of Object.entries(persisted.sessions)) {
    if (!owned.has(sessionId)) continue
    const named =
      leafProject.get(sessionId) ??
      detachedProject.get(sessionId) ??
      buriedProject.get(sessionId) ??
      activeProjectId
    // A recorded affinity naming a project that no longer exists (possible
    // only in corrupt files — v2 ownership rejects those records) must not
    // leak a dangling TabId into v3, where it would filter the session out
    // of every index forever.
    const projectId = projectIds.has(named) ? named : activeProjectId
    sessions[sessionId] = { ...meta, projectId }
  }
  const poolIds = new Set<SessionId>(Object.keys(sessions))

  // --- Rules 4 + 6: the stage.
  let stage: TiledDispatchState
  const normalizedDispatch = normalizeDispatchModeGrid(persisted.dispatchMode ?? null)
  if (normalizedDispatch?.tiled) {
    // Compose the same durability chain rehydrate uses, so a lane pointing
    // at a session the pool dropped cannot survive the migration (the
    // "selected-but-unresolvable lane" bug class), and row metadata naming
    // dead projects/sessions is scrubbed with the exact autosave rule.
    const dispatchMode: DispatchModeState = normalizedDispatch
    const durable = keepTiledLaneSessions(
      scrubGridRowMetadata(dispatchMode, projectIds, poolIds),
      poolIds,
    )
    const tiled = durable?.tiled
    stage = tiled
      ? {
          // Explicit field projection: drops legacy `userEmptied` and the
          // reserved-but-unused `scrollAnchorKey` from v2 lanes by simply
          // never copying them.
          lanes: tiled.lanes.map(lane =>
            lane.selectedSessionId !== undefined
              ? { selectedSessionId: lane.selectedSessionId }
              : {},
          ),
          rows: tiled.rows,
          focusedLane: tiled.focusedLane,
          ...(tiled.laneWeights ? { laneWeights: tiled.laneWeights } : {}),
        }
      : defaultSeededStage(resolveEntrySeed(persisted))
  } else {
    stage = defaultSeededStage(resolveEntrySeed(persisted))
  }

  // --- Pins: drop phantoms, preserve order, dedupe — the same contract
  // rehydrate's buildRemappedPinnedSessionIds holds, minus id remapping
  // (this migration never mints new ids).
  const pinned: SessionId[] = []
  const seen = new Set<SessionId>()
  for (const id of persisted.pinnedSessionIds ?? []) {
    if (typeof id !== 'string' || id.length === 0) continue
    if (!poolIds.has(id) || seen.has(id)) continue
    seen.add(id)
    pinned.push(id)
  }

  // --- Drafts: a draft for a dropped session is dead weight that would
  // otherwise ride every autosave forever.
  const draftEntries = Object.entries(persisted.drafts ?? {}).filter(
    ([sessionId]) => poolIds.has(sessionId),
  )

  return {
    projects,
    activeProjectId,
    stage,
    sessions,
    pinnedSessionIds: pinned,
    ...(draftEntries.length > 0
      ? { drafts: Object.fromEntries(draftEntries) as Record<SessionId, string> }
      : {}),
  }
}
