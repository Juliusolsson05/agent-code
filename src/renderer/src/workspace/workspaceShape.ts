import type { LegacyDispatchMode, PersistedWorkspace } from '@renderer/workspace/persistence'
import type {
  ProjectRef,
  SessionId,
  SessionMeta,
  Tab,
  TabId,
  TiledDispatchState,
} from '@renderer/workspace/types'
import { collectLeaves } from '@renderer/workspace/tile-tree/treeOps'
import { collectOwnedSessionIds, type SessionOwnershipInput } from '@renderer/workspace/sessionOwnership'
import {
  keepTiledLaneSessions,
  normalizeStage,
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
 * What the shared affinity/seed helpers need from a workspace: the v2
 * ownership fields (with full tabs — the narrow SessionOwnershipTab drops
 * `title`/`focusedSessionId`, which the seed precedence and the projects
 * mint both read) plus the two focus-ish fields. `PersistedWorkspace`
 * (migration input) and the live `WorkspaceState` (runtime derivation,
 * workspaceStage.ts) both satisfy this structurally — one precedence, two
 * callers, zero drift.
 */
export type WorkspaceAffinityInput = Omit<SessionOwnershipInput, 'tabs'> & {
  tabs: Tab[]
  activeTabId: TabId
  /** v2 files only; live state has no wrapper (it has `stage`). */
  dispatchMode?: LegacyDispatchMode | null | undefined
}

/**
 * Resolve the session that owns lane 0 when a workspace has NO tiled stage
 * (classic Dispatch or pure-grid state): the session the user was
 * commanding when they last looked at this workspace.
 *
 * WHY this precedence and no other: dispatch focus first, then the active
 * tab's grid focus, validated against sessions and buried. It is #977's
 * entry seed. Through stage 2 of #992 the same rule also lived in
 * `dispatchEntrySeedSessionId`, applied every time the user ENTERED Grid
 * Dispatch over a live state, and the two had to be kept from drifting.
 * That action and that helper are deleted: a workspace is migrated once,
 * here, and never entered — so this is now the only copy of the rule and
 * the only moment it runs.
 *
 * WHY seeding does not violate #681: the seed is continuity with the pane
 * the user was just commanding, never a prediction from the index. All
 * other lanes arrive empty and stay empty.
 */
export function resolveEntrySeed(input: WorkspaceAffinityInput): SessionId | null {
  const dispatchFocused = input.dispatchMode?.focusedSessionId ?? null
  const gridFocused =
    input.tabs.find(tab => tab.id === input.activeTabId)?.focusedSessionId ?? null
  const candidate = dispatchFocused ?? gridFocused
  if (!candidate) return null
  if (input.sessions[candidate] === undefined) return null
  if ((input.buried ?? []).some(entry => entry.sessionId === candidate)) return null
  return candidate
}

/**
 * The three v2 ways a session could know its project, as one map lookup
 * with the migration's precedence: leaf membership (the placement the user
 * last arranged), then the detached record's affinity, then the buried
 * record's source, then the active tab. Shared by the persisted migration
 * and the live pool selectors so the precedence cannot fork.
 *
 * WHY this does NOT validate against live project ids: the persisted
 * migration must never emit a dangling projectId (it guards separately
 * against `projects`), while the live view can tolerate a transient
 * dangling value between a tab close and the next reconcile — closing a
 * tab already clears detached records at the same boundary. Validation
 * belongs to the caller with the stronger invariant.
 */
export function projectAffinityOf(
  input: WorkspaceAffinityInput,
  sessionId: SessionId,
): TabId | undefined {
  return (
    leafProjectOf(input).get(sessionId) ??
    detachedProjectOf(input).get(sessionId) ??
    buriedProjectOf(input).get(sessionId) ??
    input.activeTabId
  )
}

function leafProjectOf(input: SessionOwnershipInput): Map<SessionId, TabId> {  const map = new Map<SessionId, TabId>()
  for (const tab of input.tabs) {
    for (const sessionId of collectLeaves(tab.root)) {
      map.set(sessionId, tab.id)
    }
  }
  return map
}

function detachedProjectOf(input: SessionOwnershipInput): Map<SessionId, TabId> {
  const map = new Map<SessionId, TabId>()
  for (const record of Object.values(input.detachedSessions ?? {})) {
    map.set(record.sessionId, record.projectTabId)
  }
  return map
}

function buriedProjectOf(input: SessionOwnershipInput): Map<SessionId, TabId> {
  const map = new Map<SessionId, TabId>()
  for (const record of input.buried ?? []) {
    map.set(record.sessionId, record.sourceTabId)
  }
  return map
}

/**
 * Turn persisted `buried` records into ordinary parked pool sessions.
 *
 * WHY this exists (#992 stage 3a): Bury / Revive / Kill Buried were deleted —
 * "hidden but alive" is simply what an unplaced pool session is — but old
 * workspace files (and a closing window's slice handed to adoptWorkspace)
 * still carry `buried[]`. With the revive UI gone, a record left in that
 * bucket would be alive, owned, and unreachable from any surface. Folding at
 * the READ boundary means live state never holds a buried session at all:
 * they arrive as parked Dispatch rows, listed in their project's index and
 * woken on first placement like any other parked agent.
 *
 * Rules:
 *  - A buried record carries its OWN SessionMeta and that meta can be absent
 *    from `sessions` (control.ts documents "buried metadata can outlive its
 *    sessions entry"), so the fold restores it; an existing row wins.
 *  - v2 ownership kept buried sessions UNCONDITIONALLY, even when their
 *    source tab had been closed (Revive minted a tab for them). A detached
 *    record whose project is gone is dropped by ownership, so a dead source
 *    tab re-parents to the active project instead of silently deleting the
 *    agent. No project at all => nothing can list it; the record is dropped,
 *    exactly as rehydrate would have been unable to show it.
 *  - `buriedAt` becomes `detachedAt`: it is the only ordering key inside a
 *    project group, and "when it left the screen" is the honest value.
 *  - A session that is somehow ALSO a tile leaf or already detached keeps
 *    that placement; the fold never creates a second owner.
 *
 * migrateWorkspaceToStage does NOT call this: it folds buried into the v3
 * pool through projectAffinityOf and must keep excluding a buried session
 * from the entry seed (the user hid it on purpose). Two folds, one outcome —
 * every buried session is a pool member owned by a live project.
 */
export function foldBuriedIntoDetached(persisted: PersistedWorkspace): PersistedWorkspace {
  const buried = persisted.buried ?? []
  if (buried.length === 0) return persisted
  const tabIndexById = new Map(persisted.tabs.map((tab, index) => [tab.id, index]))
  const fallbackTabId = tabIndexById.has(persisted.activeTabId)
    ? persisted.activeTabId
    : persisted.tabs[0]?.id
  const leafIds = new Set(persisted.tabs.flatMap(tab => collectLeaves(tab.root)))
  const sessions = { ...persisted.sessions }
  const detachedSessions = { ...(persisted.detachedSessions ?? {}) }
  for (const record of buried) {
    const projectTabId = tabIndexById.has(record.sourceTabId) ? record.sourceTabId : fallbackTabId
    if (projectTabId === undefined) continue
    if (sessions[record.sessionId] === undefined) sessions[record.sessionId] = record.sessionMeta
    if (leafIds.has(record.sessionId) || detachedSessions[record.sessionId] !== undefined) continue
    const projectTabIndex = tabIndexById.get(projectTabId) ?? 0
    detachedSessions[record.sessionId] = {
      sessionId: record.sessionId,
      surface: 'dispatch',
      projectTabId,
      projectTabTitle: persisted.tabs[projectTabIndex]?.title ?? record.sourceTabTitle,
      projectTabIndex,
      detachedAt: record.buriedAt,
    }
  }
  return { ...persisted, sessions, detachedSessions, buried: [] }
}

/**
 * The default stage minted for a workspace that has no stored one:
 * `[{ length: 2 }]`, lane 0 seeded, focused.
 *
 * Shared by the persisted migration and the live derivation
 * (workspaceStage.ts) so "what a workspace without a stage looks like" has
 * exactly one answer.
 *
 * WHY two lanes and not one: one-lane-first-run is the FRESH-install shape
 * (§4.5 — nothing to explain, the user hasn't asked for space). A migrating
 * or dispatch-less workspace demonstrably works with agents already; the
 * second lane is the smallest honest stage that shows what a lane IS
 * without adding a row. The seed write is the same continuity gesture
 * enterTiledDispatch performs (#977), applied once.
 */
export function defaultSeededStage(seed: SessionId | null): TiledDispatchState {
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

  // --- Rule 2 via the shared precedence (projectAffinityOf): leaf
  // membership first, then detached record, then buried source, then the
  // active tab. One precedence shared with the live selectors so persisted
  // and runtime views can never disagree.
  // --- Rule 7: the pool is the OWNED set, not the raw sessions map.
  const owned = collectOwnedSessionIds(persisted)
  const sessions: Record<SessionId, PoolSession> = {}
  for (const [sessionId, meta] of Object.entries(persisted.sessions)) {
    if (!owned.has(sessionId)) continue
    const named = projectAffinityOf(persisted, sessionId) ?? activeProjectId
    // A recorded affinity naming a project that no longer exists (possible
    // only in corrupt files — v2 ownership rejects those records) must not
    // leak a dangling TabId into v3, where it would filter the session out
    // of every index forever.
    const projectId = projectIds.has(named) ? named : activeProjectId
    sessions[sessionId] = { ...meta, projectId }
  }
  const poolIds = new Set<SessionId>(Object.keys(sessions))

  // --- Rules 4 + 6: the stage. A file that already carries a v3 `stage` wins
  // over a stale v2 wrapper sitting beside it (autosave wrote both for one
  // release of this branch); otherwise the v2 lane grid becomes the stage, and
  // a workspace that never had one gets the seeded default.
  const sourceStage = persisted.stage ?? persisted.dispatchMode?.tiled
  let stage: TiledDispatchState
  if (sourceStage) {
    // Compose the same durability chain rehydrate uses, so a lane pointing
    // at a session the pool dropped cannot survive the migration (the
    // "selected-but-unresolvable lane" bug class), and row metadata naming
    // dead projects/sessions is scrubbed with the exact autosave rule.
    const durable = keepTiledLaneSessions(
      scrubGridRowMetadata(normalizeStage(sourceStage), projectIds, poolIds),
      poolIds,
    )
    stage = {
      // Explicit field projection: drops legacy `userEmptied` and the
      // reserved-but-unused `scrollAnchorKey` from v2 lanes by simply
      // never copying them.
      lanes: durable.lanes.map(lane =>
        lane.selectedSessionId !== undefined
          ? { selectedSessionId: lane.selectedSessionId }
          : {},
      ),
      rows: durable.rows,
      focusedLane: durable.focusedLane,
      ...(durable.laneWeights ? { laneWeights: durable.laneWeights } : {}),
    }
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
