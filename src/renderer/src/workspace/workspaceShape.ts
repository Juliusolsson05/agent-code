import type { PersistedWorkspace } from '@renderer/workspace/persistence'
import type {
  ProjectRef,
  SessionId,
  SessionMeta,
  TabId,
  TiledDispatchState,
  WorkspaceState,
} from '@renderer/workspace/types'
import {
  hasSessionMeta,
  legacyEntrySeed,
  legacyMemberships,
} from '@renderer/workspace/legacyWorkspaceV2'
import {
  keepTiledLaneSessions,
  normalizeStage,
  scrubGridRowMetadata,
} from '@renderer/workspace/dispatch/tiledDispatchSelectors'
import { normalizeGridShape } from '@renderer/workspace/dispatch/gridShape'
import { titleFromCwd } from '@renderer/workspace/layout/helpers'

// ---------------------------------------------------------------------------
// Read-time normalization of workspace.json into the unified shape (#992).
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
// ONE function reads every generation: a v2 file, a v3 file, and the hybrid
// the intermediate #992 builds wrote (v2 owners beside a v3 triple). Rehydrate
// and window adoption both call it and neither ever sees a v2 field again.
//
// WHAT THIS IS NOT: it does not touch live renderer state, spawn or wake.
// ---------------------------------------------------------------------------

/**
 * A session as it lives in the pool: SessionMeta with its membership made
 * explicit. Both fields are optional on `SessionMeta` because that one type
 * also describes v2 rows that predate them; this is what the pool guarantees
 * once a file has been through `migrateWorkspaceToStage`.
 */
export type PoolSession = SessionMeta & { projectId: TabId; joinedAt: number }

/**
 * The unified workspace: the fleet pool plus the stage. Everything the old
 * shape spread across tabs[].root, detachedSessions, buried, and dispatchMode
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
 * Was this file written with a stage? WHY shape and not a number: additive
 * fields with an unambiguous meaning get read-time normalization here; a
 * version integer would promise downgrade-compatibility nobody has tested.
 */
export function isStageWorkspace(persisted: PersistedWorkspace): boolean {
  return persisted.stage !== undefined
}

/**
 * The default stage minted for a workspace that has no stored one:
 * `[{ length: 2 }]`, lane 0 seeded, focused.
 *
 * WHY two lanes and not one: one-lane-first-run is the FRESH-install shape
 * (§4.5 — nothing to explain, the user hasn't asked for space). A migrating
 * workspace demonstrably works with agents already; the second lane is the
 * smallest honest stage that shows what a lane IS without adding a row. The
 * seed write is #977's continuity gesture, applied once.
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
 * Normalize a persisted workspace of any generation to the unified shape.
 *
 * Rules (plan §6), each with its enforcement below:
 *  1. projects: a v3 `projects` list wins; otherwise v2 tabs become projects
 *     (id and title kept — TabIds are reused so lane bindings, row project
 *     bindings and A1/B7 labels survive; trees are NOT reconstructed).
 *  2. membership: a row's own `projectId` wins when it names a live project;
 *     otherwise the v2 owners decide (leaf, then detached, then buried — see
 *     legacyWorkspaceV2.ts for why each rule exists). A buried session whose
 *     project is gone re-parents to the active project; every other session
 *     whose project is gone is a ghost and is dropped.
 *  3. order: `joinedAt` — the row's own value, else the v2 position (tree
 *     ordinal, `detachedAt`, `buriedAt`). It is the only key ordering rows
 *     inside a project.
 *  4. stage: a v3 `stage` wins over a v2 `dispatchMode.tiled`; a file with
 *     neither gets `defaultSeededStage` with #977's entry seed.
 *  5. ACCEPTED LOSS (recorded in the plan): multi-pane tab arrangements are
 *     pooled, not reconstructed. Live data showed 1-pane tabs; inventing
 *     rows from trees would surprise far more than it preserves.
 *  6. tileTabs, legacy `ratios`, `userEmptied`, bury placement hints: dropped.
 *  7. unowned session rows are dropped — metadata is never an owner, so the
 *     migration can never resurrect a row into a backend process (the #258
 *     fork-bomb shape).
 */
export class MalformedWorkspaceContainerError extends Error {}

export function migrateWorkspaceToStage(
  persisted: PersistedWorkspace,
  // Only a file with zero projects AND parked sessions to rehome needs this;
  // injected so the test does not have to match a random id.
  mintProjectId: () => TabId = () => crypto.randomUUID(),
): StageWorkspace {
  // Rule 8 (#1030 item 3): a container that is PRESENT but not a list is
  // corruption, not an empty workspace. Migrating it to an empty pool let
  // rehydrate mint a fresh tab and report `complete`, which unlocks autosave —
  // so the next 400 ms tick overwrote whatever the real file held. v2 threw
  // here, and the throw is what put bootstrap into its locked fallback with
  // the disk file untouched. `undefined` is not corruption: a v2 file has no
  // `projects`, and a v3 file has no `tabs`.
  for (const [field, value] of [['projects', persisted.projects], ['tabs', persisted.tabs]] as const) {
    if (value !== undefined && !Array.isArray(value)) {
      throw new MalformedWorkspaceContainerError(
        `workspace.json has a malformed \`${field}\`; refusing to migrate it to an empty pool`,
      )
    }
  }
  // --- Rule 1.
  const projects: ProjectRef[] = Array.isArray(persisted.projects)
    ? persisted.projects
        .filter(project => project && typeof project.id === 'string' && project.id.length > 0)
        .map(project => ({
          id: project.id,
          title: typeof project.title === 'string' ? project.title : '',
          ...(typeof project.cwd === 'string' ? { cwd: project.cwd } : {}),
        }))
    : (persisted.tabs ?? []).map(tab => ({ id: tab.id, title: tab.title }))
  const projectIds = new Set<TabId>(projects.map(project => project.id))
  // Degenerate guard: every writer keeps >=1 project (rehydrate mints one), but
  // a hand-emptied file must still migrate to something renderable. '' is
  // never a project id; readers treat it as "no active project".
  const recordedActive = persisted.activeProjectId ?? persisted.activeTabId ?? ''
  let activeProjectId = projectIds.has(recordedActive)
    ? recordedActive
    : (projects[0]?.id ?? '')

  // --- Rules 2, 3, 7.
  const legacy = legacyMemberships(persisted)
  // Rule 9 (#1030 item 2): a v2 file with zero tabs still carried its buried
  // panes — burial was independent of tabs there. Here every session needs a
  // project to live in, so with none left the re-parent target was '' and
  // every buried row was dropped: the one place some sessions' metadata
  // existed, deleted on upgrade. Mint one project to receive them instead.
  // Only for files that genuinely have parked rows; an empty file stays empty.
  if (projects.length === 0) {
    // WHY membership rather than `restoredMeta` (#1048 Codex review):
    // `restoredMeta` is set ONLY when the metadata is missing from `sessions`,
    // because it exists to carry the copy a buried record holds. The common
    // case is the opposite — the row is buried AND still listed in `sessions`
    // — and keying the mint on `restoredMeta` dropped exactly those rows,
    // which is the bug this clause exists to fix. Any parked membership at
    // all is enough; the metadata is then resolved from either source, as the
    // loop below already does.
    //
    // WHY `projectId === null` and not "any membership" (#1048 re-review): a
    // minted project only ever receives rows that RE-PARENT into it, and only
    // a membership whose own project is gone does that (`null` is exactly that
    // state; a membership naming a live v2 tab keeps that name and is dropped
    // below when the name is not a project). A hybrid file — `projects: []`
    // beside stale v2 tabs — satisfied the looser test, so migration minted a
    // project, then dropped every session because their tab ids still were not
    // project ids. The result was an empty phantom project, which also hid the
    // file from bootstrap's empty-workspace fallback: the user got a nameless
    // project instead of the first-run path.
    const rehomed = [...legacy.entries()].find(([sessionId, membership]) =>
      (membership.projectId ?? null) === null
      && (membership.restoredMeta !== undefined || hasSessionMeta(persisted.sessions ?? {}, sessionId)))
    if (rehomed) {
      const [sessionId, membership] = rehomed
      const meta = membership.restoredMeta ?? (persisted.sessions ?? {})[sessionId]
      const id = mintProjectId()
      const cwd = meta?.cwd
      projects.push({ id, title: typeof cwd === 'string' ? titleFromCwd(cwd) : '', ...(typeof cwd === 'string' ? { cwd } : {}) })
      projectIds.add(id)
      activeProjectId = id
    }
  }
  const sessions: Record<SessionId, PoolSession> = {}
  const candidateIds = new Set<SessionId>([
    ...Object.keys(persisted.sessions ?? {}),
    // A buried record can be the ONLY place a session's metadata lives.
    ...[...legacy.entries()].filter(([, m]) => m.restoredMeta).map(([id]) => id),
  ])
  for (const sessionId of candidateIds) {
    const membership = legacy.get(sessionId)
    const meta = hasSessionMeta(persisted.sessions ?? {}, sessionId)
      ? persisted.sessions[sessionId]!
      : membership?.restoredMeta
    if (!meta) continue

    const stamped = typeof meta.projectId === 'string' && projectIds.has(meta.projectId)
      ? meta.projectId
      : undefined
    let projectId: TabId | undefined = stamped
    if (projectId === undefined && membership) {
      // `null` = owned, but its project is gone: only a buried session can be
      // in that state (v2 kept them unconditionally), and it re-parents.
      projectId = membership.projectId ?? (activeProjectId || undefined)
    }
    // Neither a live stamp nor a v2 owner: a ghost. It must NOT fall back to
    // the active project — that is exactly how 82 dead records would become
    // 82 rows in someone's index, one click from being spawned.
    if (projectId === undefined || !projectIds.has(projectId)) continue

    const joinedAt = typeof meta.joinedAt === 'number' && Number.isFinite(meta.joinedAt)
      ? meta.joinedAt
      : (membership?.joinedAt ?? 0)
    sessions[sessionId] = { ...meta, projectId, joinedAt }
  }
  const poolIds = new Set<SessionId>(Object.keys(sessions))

  // --- Rule 4. A file that already carries a `stage` wins over a stale v2
  // envelope sitting beside it (the intermediate #992 builds wrote both).
  const sourceStage = persisted.stage ?? persisted.dispatchMode?.tiled
  let stage: TiledDispatchState
  // A stage whose `lanes` is not a list carries no usable layout at all; it
  // takes the seeded default below like a file with no stage (#1245). Only
  // layout is lost: every session lives in the pool, not in a lane. Unlike a
  // malformed `projects`/`tabs` (rule 8), nothing the next autosave writes
  // can destroy data the file still held.
  if (sourceStage && Array.isArray(sourceStage.lanes)) {
    // Compose the same durability chain autosave uses, so a lane pointing at
    // a session the pool dropped cannot survive the migration (the
    // "selected-but-unresolvable lane" bug class), and row metadata naming
    // dead projects/sessions is scrubbed with the exact autosave rule.
    const durable = keepTiledLaneSessions(
      scrubGridRowMetadata(normalizeStage(sourceStage), projectIds, poolIds),
      poolIds,
    )
    stage = {
      // Explicit field projection: drops legacy `userEmptied` and the
      // reserved-but-unused `scrollAnchorKey` from v2 lanes by simply never
      // copying them.
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
    const seed = legacyEntrySeed(persisted)
    stage = defaultSeededStage(seed !== null && poolIds.has(seed) ? seed : null)
  }

  // --- Pins: drop phantoms, preserve order, dedupe.
  const pinned: SessionId[] = []
  const seen = new Set<SessionId>()
  for (const id of Array.isArray(persisted.pinnedSessionIds) ? persisted.pinnedSessionIds : []) {
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

/**
 * A persisted workspace of any generation, as LIVE state: the normalized pool,
 * its projects under the in-memory names (`tabs` / `activeTabId`), and the
 * stage.
 *
 * WHY this exists beside `migrateWorkspaceToStage`: that function's output is
 * the ON-DISK vocabulary (`projects`, `activeProjectId`), because it is also
 * what autosave's shape is checked against. Live state still says `tabs` —
 * renaming ~200 call sites is cleanup, not behavior — so everything that
 * turns a FILE into something selectors can run on needs this one renaming
 * step, and three hand-written copies of it (rehydrate's restore shell, the
 * test recording loader, the fixture extraction script) would drift.
 *
 * It does no recovery and spawns nothing: rehydrate layers id remapping and
 * backend outcomes on top of the same fields.
 */
export function liveWorkspaceFromPersisted(persisted: PersistedWorkspace): WorkspaceState {
  const migrated = migrateWorkspaceToStage(persisted)
  return {
    tabs: migrated.projects.map(project => ({ id: project.id, title: project.title })),
    activeTabId: migrated.activeProjectId,
    stage: migrated.stage,
    sessions: migrated.sessions,
    pinnedSessionIds: migrated.pinnedSessionIds,
  }
}
