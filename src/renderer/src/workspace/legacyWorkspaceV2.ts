import type {
  SessionId,
  SessionMeta,
  TabId,
  TiledDispatchState,
} from '@renderer/workspace/types'

// ---------------------------------------------------------------------------
// The v2 workspace, as old files carry it (#992).
//
// WHY this file exists: the unified layout deleted the tile tree, the
// `detachedSessions` bucket, the `buried` bucket and the `dispatchMode`
// envelope from LIVE state. Users' workspace.json files still contain all four,
// and will for as long as anyone upgrades from a build older than this one.
// Every v2 type and every v2 reading rule lives HERE and nowhere else, so that:
//
//   - the live types (`types.ts`) describe only what exists at runtime, and a
//     grep for `TileNode` or `DetachedSessionRecord` outside this file and the
//     migration means someone is reasoning about state that no longer exists;
//   - the ownership rules v2 earned the hard way (below) stay attached to the
//     data they were learned from, instead of surviving as folklore in
//     modules that no longer have the fields the rules are about.
//
// Nothing here is imported by a reducer, a selector or a component. The ONE
// consumer is `migrateWorkspaceToStage` (workspaceShape.ts). If a second one
// appears, it is reading a dead shape and should be reading the pool.
// ---------------------------------------------------------------------------

export type LegacySplitDirection = 'vertical' | 'horizontal'

/** A v2 tile tree. Vertical = `a` left / `b` right; horizontal = top / bottom. */
export type LegacyTileNode =
  | { type: 'leaf'; sessionId: SessionId }
  | {
      type: 'split'
      direction: LegacySplitDirection
      ratio: number
      a: LegacyTileNode
      b: LegacyTileNode
    }

/** A v2 project tab: a title plus the tree that OWNED its visible sessions. */
export type LegacyTab = {
  id: TabId
  title: string
  focusedSessionId: SessionId
  root: LegacyTileNode
}

/** A v2 session that was live but placed in no tile tree ("parked in Dispatch"). */
export type LegacyDetachedSessionRecord = {
  sessionId: SessionId
  surface: 'dispatch'
  /** Project affinity — the durable parent relation. */
  projectTabId: TabId
  projectTabTitle: string
  projectTabIndex: number
  /** The ONLY key that ordered rows inside a project group in v2. */
  detachedAt: number
}

/** A v2 hidden-but-live pane. Carries its OWN SessionMeta (see below). */
export type LegacyBuriedPaneRecord = {
  id: string
  sessionId: SessionId
  sessionMeta: SessionMeta
  buriedAt: number
  sourceTabId: TabId
  sourceTabTitle: string
  sourceTabIndex: number
  direction?: LegacySplitDirection
  ratio?: number
  side?: 'a' | 'b'
  siblingLeafId?: SessionId
  note?: string
}

/**
 * The v2 "Dispatch Mode" envelope. `scope` and the classic `focusedSessionId`
 * are read for the entry seed and otherwise discarded; `tiled` becomes the
 * stage.
 */
export type LegacyDispatchMode = {
  scope?: 'project' | 'global'
  focusedSessionId?: SessionId
  tiled?: TiledDispatchState
}

/** The v2 fields a persisted workspace may carry. All optional: a v3 file has none. */
export type LegacyWorkspaceV2Fields = {
  tabs?: LegacyTab[]
  activeTabId?: TabId
  dispatchMode?: LegacyDispatchMode | null
  detachedSessions?: Record<SessionId, LegacyDetachedSessionRecord>
  buried?: LegacyBuriedPaneRecord[]
}

/**
 * Depth-first leaves of a v2 tree — the order the grid showed them in, and
 * therefore the order the index listed them in.
 *
 * Total on malformed input on purpose: a hand-edited file can hold a node with
 * no `type`, or a split missing a child (the old `collectLeaves` threw on
 * that, and a throw at boot is a lost workspace). Anything that is not a
 * recognizable node contributes no leaves.
 */
export function collectLegacyLeaves(node: LegacyTileNode | null | undefined): SessionId[] {
  if (!node || typeof node !== 'object') return []
  if (node.type === 'leaf') {
    return typeof node.sessionId === 'string' && node.sessionId.length > 0 ? [node.sessionId] : []
  }
  if (node.type === 'split') {
    return [...collectLegacyLeaves(node.a), ...collectLegacyLeaves(node.b)]
  }
  return []
}

/**
 * Does `sessions` actually carry metadata for this id?
 *
 * WHY an own-property check and not a bare `sessions[id]` truthiness test: a
 * plain index read walks the prototype chain, so a leaf id of `toString`,
 * `constructor`, or `valueOf` resolves to an inherited function and reads as
 * "has metadata". Session ids are `randomUUID()` today, so this needs a
 * hand-edited workspace.json to reach; hand-edited files are an explicit
 * threat model for everything that reads that file, so the check is total.
 * The value must also be truthy: an own key holding `undefined` is "no
 * metadata".
 */
export function hasSessionMeta(
  sessions: Record<SessionId, SessionMeta>,
  id: SessionId,
): boolean {
  // `Object.prototype.hasOwnProperty.call` rather than `Object.hasOwn`: this
  // project's TS lib target predates ES2022.
  return Object.prototype.hasOwnProperty.call(sessions, id) && Boolean(sessions[id])
}

/** How one v2 session belonged to the workspace, in pool terms. */
export type LegacyMembership = {
  /**
   * The project that owned it. `null` means "owned, but its project is gone":
   * only a buried session can be in that state (see rule 3), and the migration
   * re-parents it to the active project.
   */
  projectId: TabId | null
  /**
   * Its position inside that project's index. v2 listed a project as
   * `[...treeLeaves (depth-first), ...detached (oldest detachedAt first)]`.
   * Leaves get their depth-first ORDINAL (0, 1, 2, …) and detached/buried
   * sessions get their millisecond timestamp, so one ascending sort over this
   * number reproduces the v2 order exactly: every ordinal is smaller than
   * every timestamp, which is what "leaves first" meant.
   */
  joinedAt: number
  /** Buried metadata can outlive its `sessions` row; carry it so it is restored. */
  restoredMeta?: SessionMeta
}

/**
 * Which v2 sessions were OWNED, by which project, in what order.
 *
 * These rules are v2's, preserved exactly, because each one was a production
 * incident before it was a rule:
 *
 *  1. A tile leaf is owned by its tab — but ONLY if `sessions` has metadata
 *     for it. A leaf with no metadata has no cwd and no kind; there is nothing
 *     to restore. Counting it once froze a real user's workspace for three
 *     weeks: restore could never complete, so autosave (the file's only
 *     writer) stayed locked and the corrupt tree could never be rewritten.
 *
 *  2. A detached record is owned by `projectTabId` — but ONLY if that project
 *     still exists. Closing a tab killed its visible and detached sessions
 *     together, yet older builds and interrupted saves left the detached half
 *     behind, and blindly treating the record as an owner made it immortal.
 *     Real workspaces accumulated 80+ such ghosts; the #258 fork bomb was 40
 *     of them being SPAWNED at boot. A missing parent means there is no
 *     surface from which the agent can be found or managed: it is dropped.
 *
 *  3. A buried record is owned UNCONDITIONALLY, even when its source tab is
 *     gone (v2's Revive minted a tab for it). Hence `projectId: null` rather
 *     than a drop. Its metadata may live only in the record.
 *
 *  4. Metadata that none of the above claims is UNOWNED and is dropped. The
 *     `sessions` map is metadata for owners, never an owner itself — "metadata
 *     exists but nothing owns it" is how orphan rows became invisible backend
 *     processes.
 *
 *  5. Dispatch focus and lane selections are POINTERS, not ownership. A stale
 *     focus id must never resurrect work the user can no longer see.
 *
 * Precedence when a session is claimed twice (it never should be): leaf, then
 * detached, then buried — the placement the user most recently arranged wins,
 * and the fold never creates a second owner.
 */
export function legacyMemberships(
  input: LegacyWorkspaceV2Fields & { sessions: Record<SessionId, SessionMeta> },
): Map<SessionId, LegacyMembership> {
  const tabs = input.tabs ?? []
  const liveProjectIds = new Set<TabId>(tabs.map(tab => tab.id))
  const out = new Map<SessionId, LegacyMembership>()

  for (const tab of tabs) {
    let ordinal = 0
    for (const sessionId of collectLegacyLeaves(tab.root)) {
      const position = ordinal++
      if (out.has(sessionId)) continue
      if (!hasSessionMeta(input.sessions, sessionId)) continue
      out.set(sessionId, { projectId: tab.id, joinedAt: position })
    }
  }

  // A damaged ENTRY (null, or no sessionId) still names its session: the
  // record is keyed by session id. Dropping it made the agent unowned, and the
  // migration then deleted it, and the next autosave made that permanent (one
  // agent per damaged entry on the owner's real workspace, #1245 review). It
  // is re-homed to the active project instead, the way rule 9 re-homes parked
  // rows; only its placement was lost, never the agent.
  const rehomeProjectId = liveProjectIds.has(input.activeTabId ?? '') ? input.activeTabId! : tabs[0]?.id
  for (const [key, record] of Object.entries(input.detachedSessions ?? {})) {
    const intact = record !== null && typeof record === 'object' && typeof record.sessionId === 'string'
    const sessionId = intact ? record.sessionId : key
    if (out.has(sessionId)) continue
    if (!hasSessionMeta(input.sessions, sessionId)) continue
    if (intact) {
      if (!liveProjectIds.has(record.projectTabId)) continue
      out.set(sessionId, {
        projectId: record.projectTabId,
        joinedAt: Number.isFinite(record.detachedAt) ? record.detachedAt : 0,
      })
    } else if (rehomeProjectId !== undefined) {
      out.set(sessionId, { projectId: rehomeProjectId, joinedAt: 0 })
    }
  }

  for (const record of input.buried ?? []) {
    if (!record || out.has(record.sessionId)) continue
    const meta = hasSessionMeta(input.sessions, record.sessionId)
      ? undefined
      : record.sessionMeta
    if (!meta && !hasSessionMeta(input.sessions, record.sessionId)) continue
    out.set(record.sessionId, {
      projectId: liveProjectIds.has(record.sourceTabId) ? record.sourceTabId : null,
      // "When it left the screen" is the honest order key for a hidden pane.
      joinedAt: Number.isFinite(record.buriedAt) ? record.buriedAt : 0,
      ...(meta ? { restoredMeta: meta } : {}),
    })
  }

  return out
}

/**
 * The session v2's user was commanding — #977's entry seed — or null.
 *
 * Precedence: the classic-Dispatch focus, then the active tab's tree focus.
 * A BURIED session is never the seed: the user hid it on purpose, and the
 * first thing an upgrade does must not be to put it back on screen.
 *
 * WHY seeding does not violate #681: it is continuity with the pane the user
 * was just commanding, never a prediction from the index. It fills lane 0 of
 * a workspace that had no lanes and nothing else; all other lanes arrive
 * empty and stay empty.
 */
export function legacyEntrySeed(
  input: LegacyWorkspaceV2Fields & { sessions: Record<SessionId, SessionMeta> },
): SessionId | null {
  const dispatchFocused = input.dispatchMode?.focusedSessionId ?? null
  const treeFocused =
    (input.tabs ?? []).find(tab => tab.id === input.activeTabId)?.focusedSessionId ?? null
  const candidate = dispatchFocused ?? treeFocused
  if (!candidate) return null
  if (!hasSessionMeta(input.sessions, candidate)) return null
  if ((input.buried ?? []).some(entry => entry?.sessionId === candidate)) return null
  return candidate
}
