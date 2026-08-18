import type {
  BuriedPaneRecord,
  DetachedSessionRecord,
  DispatchModeState,
  SessionId,
  SessionMeta,
  TabId,
  TileNode,
} from '@renderer/workspace/types'
import { closeLeaf, collectLeaves } from '@renderer/workspace/tile-tree/treeOps'
import { keepTiledLaneSessions } from '@renderer/workspace/dispatch/tiledDispatchSelectors'

type SessionOwnershipTab = {
  id: TabId
  root: TileNode
}

export type SessionOwnershipInput = {
  tabs: SessionOwnershipTab[]
  sessions: Record<SessionId, SessionMeta>
  detachedSessions?: Record<SessionId, DetachedSessionRecord>
  buried?: BuriedPaneRecord[]
}

export type PrunedSessionOwnership = {
  sessions: Record<SessionId, SessionMeta>
  detachedSessions: Record<SessionId, DetachedSessionRecord>
  buried: BuriedPaneRecord[]
  dispatchMode: DispatchModeState | null | undefined
  droppedSessionIds: SessionId[]
}

// WHY this module exists — and why TWO ownership sets, not one:
//
// Workspace persistence has three independent ownership surfaces for a session:
// visible tile leaves, detached non-grid surfaces (dispatch parking), and
// buried panes. The `sessions` map is deliberately only metadata for those
// owners. Treating the map itself as authority creates a fourth hidden state:
// "metadata exists but no UI/surface owns it". The original OOM bug was the
// inverse direction of that same conflation: orphan metadata getting respawned
// into invisible backend processes/proxies during startup.
//
// The first fix collapsed everything into a single `owned` set and used it for
// BOTH persistence pruning AND rehydrate spawn filtering. That solved orphan
// metadata, but it also meant every detached session — which the user has
// explicitly removed from their visible workspace — got a full claude/codex
// process plus mitmdump on every restart. After weeks of "park this agent in
// dispatch for later", the detached pool grew to 40+ records and each app
// launch spawned the whole herd in parallel via rehydrate's Promise.all.
//
// The fix is to split the two concepts the previous code conflated:
//
//   collectOwnedSessionIds  → metadata-preservation set.
//                             Tile leaves + detached + buried.
//                             Used by `pruneSessionOwnership` to decide which
//                             rows in `sessions`, `detachedSessions`, and
//                             `buried` survive a save cycle. Detached and
//                             buried records are durable user state; losing
//                             them would lose the cwd/providerSessionId needed
//                             to revive a parked agent later.
//
//   collectLiveProcessIds   → rehydrate-spawn set.
//                             Tile leaves ONLY. The question this answers is
//                             "which sessions does the user currently see on
//                             screen, such that a backend process must exist
//                             for typing/scrolling/streaming to work?". A
//                             detached or buried session can be revived later
//                             by an explicit user action; until then it is
//                             metadata only and must NOT spawn a PTY, a
//                             mitmdump, an MCP host, or any other runtime
//                             resource.
//
// Dispatch focus is intentionally excluded from both sets. It is a selection
// pointer, not ownership; allowing it to keep a session alive would let a
// stale focus id resurrect work the user can no longer see or manage.
export function collectOwnedSessionIds(input: SessionOwnershipInput): Set<SessionId> {
  const owned = collectLiveProcessIds(input)
  const existingTabIds = new Set(input.tabs.map(tab => tab.id))

  for (const entry of Object.values(input.detachedSessions ?? {})) {
    // WHY a detached record is not ownership by itself:
    //
    // Dispatch agents are children of a project tab. Closing that tab kills
    // its visible and detached sessions together, but older builds and
    // interrupted saves could leave the detached half behind. Blindly treating
    // that stale record as an owner made it immortal: autosave preserved both
    // the record and its SessionMeta forever, and rehydrate constructed an
    // idle runtime for it on every launch. Real workspaces accumulated dozens
    // of these ghosts even though the user had only a handful of open agents.
    //
    // `projectTabId` is the durable parent relation, so a missing parent means
    // there is no surface from which the agent can be found or managed. Drop
    // that closed ownership island as one unit instead of manufacturing a
    // fourth, invisible workspace surface.
    if (!existingTabIds.has(entry.projectTabId)) continue
    owned.add(entry.sessionId)
  }

  for (const entry of input.buried ?? []) {
    owned.add(entry.sessionId)
  }

  return owned
}

// WHY this is a separate set from `collectOwnedSessionIds`:
//
// See the module header. tl;dr: persistence wants to keep more than rehydrate
// wants to spawn. Tile leaves are the only sessions whose absence would
// produce a broken user-visible pane on startup; everything else is parked
// state that the user must opt back into.
export function collectLiveProcessIds(input: SessionOwnershipInput): Set<SessionId> {
  const live = new Set<SessionId>()
  for (const tab of input.tabs) {
    for (const id of collectLeaves(tab.root)) {
      // WHY a tile leaf with no SessionMeta is excluded from the live set:
      //
      // This set is BOTH the rehydrate spawn list and the denominator of the
      // restore-completion gate (`expectedSessions` in rehydrate.ts). A leaf
      // whose id has no row in `sessions` has no cwd and no kind, so there is
      // literally nothing to spawn for it — rehydrate's respawn loop iterates
      // `persisted.sessions` and can never even reach it. Counting it made
      // `resolvedIds.size === expectedSessions` unsatisfiable FOREVER:
      // restore reported `partial-restore`, autosave stayed locked to protect
      // disk, and because autosave was the only writer of workspace.json the
      // corrupt tree could never be rewritten. A single dangling leaf
      // permanently froze a real user's workspace file for three weeks
      // (observed: expectedCount 4, resolvedCount 3, ok false on every boot).
      //
      // Excluding it here is what makes an already-corrupt file self-heal: the
      // gate becomes satisfiable, autosave unlocks, and the write-side guard
      // (`pruneOrphanTileLeaves`) then serializes a repaired tree. The pane is
      // not silently dropped from view either — the same guard collapses the
      // leaf out of the tree, so the user never sees a pane that cannot exist.
      //
      // This is deliberately NOT "spawn a fresh session for the orphan": we do
      // not know its cwd or provider, and inventing one would resurrect a pane
      // the user never asked for, pointed at the wrong directory.
      if (!input.sessions[id]) continue
      live.add(id)
    }
  }
  return live
}

export function collectUnownedSessionIds(input: SessionOwnershipInput): SessionId[] {
  const owned = collectOwnedSessionIds(input)
  return Object.keys(input.sessions).filter(id => !owned.has(id))
}

export function pickOwnedSessions(
  sessions: Record<SessionId, SessionMeta>,
  ownedIds: Set<SessionId>,
): Record<SessionId, SessionMeta> {
  const out: Record<SessionId, SessionMeta> = {}
  for (const [id, meta] of Object.entries(sessions)) {
    if (ownedIds.has(id)) out[id] = meta
  }
  return out
}

export function pruneSessionOwnership(
  input: SessionOwnershipInput & {
    dispatchMode?: DispatchModeState | null
  },
): PrunedSessionOwnership {
  const ownedIds = collectOwnedSessionIds(input)
  const sessions = pickOwnedSessions(input.sessions, ownedIds)
  const liveIds = new Set(Object.keys(sessions))

  // WHY filter owner records after filtering `sessions`:
  //
  // A corrupted workspace can fail both directions. The OOM bug came from
  // metadata without an owner, but the inverse is also possible after a failed
  // rehydrate or hand-edited workspace.json: an owner points at missing
  // metadata. Persisting that shape means the next load has to reason about a
  // pane whose cwd/kind no longer exists. Pruning owner records to ids that
  // survived in `sessions` keeps the serialized model closed under restore.
  //
  // Detached records are also normalized by session id while we are here. The
  // object key is a lookup convenience, not user data; keeping an old runtime
  // key around a remapped record makes later lifecycle actions target the wrong
  // entry.
  const detachedSessions: Record<SessionId, DetachedSessionRecord> = {}
  for (const entry of Object.values(input.detachedSessions ?? {})) {
    if (!liveIds.has(entry.sessionId)) continue
    const sessionId = entry.sessionId
    detachedSessions[sessionId] = {
      ...entry,
      sessionId,
    }
  }

  const buried = (input.buried ?? []).filter(entry => liveIds.has(entry.sessionId))
  const droppedSessionIds = Object.keys(input.sessions).filter(id => !liveIds.has(id))
  const focusedSessionId = input.dispatchMode?.focusedSessionId
  const dispatchMode = input.dispatchMode
    ? keepTiledLaneSessions({
        // WHY tiled lanes are scrubbed at the same durability boundary as
        // focusedSessionId: autosave must serialize a model closed under
        // restore. Kill/close paths already clear lanes, but corrupt or
        // hand-edited workspace state can reach this persistence guard directly.
        // If we only scrub classic focus, a tiled lane can keep pointing at a
        // pruned session and force rehydrate/auto-fill to repair stale state on
        // every launch.
        ...input.dispatchMode,
        focusedSessionId: focusedSessionId && liveIds.has(focusedSessionId)
          ? focusedSessionId
          : undefined,
      }, liveIds)
    : input.dispatchMode

  return {
    sessions,
    detachedSessions,
    buried,
    dispatchMode,
    droppedSessionIds,
  }
}


/**
 * Drop tile leaves whose session id has no `sessions` row, collapsing each
 * orphaned split into its surviving sibling.
 *
 * WHY this belongs at the autosave boundary and not in a close/kill path:
 *
 * `pruneSessionOwnership` already claims to keep the serialized model "closed
 * under restore", and it scrubs every pointer that aims AT a session —
 * `sessions`, `detachedSessions`, `buried`, dispatch focus, tiled lanes. Tile
 * trees were the one owner class it never validated, because `useAutoSave`
 * serialized `state.tabs` verbatim. That asymmetry is what let a torn
 * in-memory state (a leaf whose metadata had already been removed) become
 * durable, and durable corruption here is uniquely bad: it disables the very
 * autosave that would fix it.
 *
 * There is a self-reference that makes this the ONLY place the repair can
 * happen. Ownership is *derived from* tile leaves — `collectOwnedSessionIds`
 * walks the trees — so an orphan leaf can never be removed by pruning
 * `sessions` against owners. The orphan IS an owner; there is nothing for
 * `pickOwnedSessions` to drop. The tree itself has to be rewritten.
 *
 * A tab that loses every leaf is dropped: its root would be empty, which
 * `TileNode` cannot represent and no pane could render. That is the one
 * destructive branch here, so it is reported in `droppedTabIds` for the caller
 * to log and to repair `activeTabId` against.
 */
export function pruneOrphanTileLeaves<
  TTab extends SessionOwnershipTab & { focusedSessionId?: SessionId },
>(
  tabs: readonly TTab[],
  sessions: Record<SessionId, SessionMeta>,
): { tabs: TTab[]; droppedLeafSessionIds: SessionId[]; droppedTabIds: TabId[] } {
  const droppedLeafSessionIds: SessionId[] = []
  const droppedTabIds: TabId[] = []
  const kept: TTab[] = []

  for (const tab of tabs) {
    const orphans = collectLeaves(tab.root).filter(id => !sessions[id])
    if (orphans.length === 0) {
      kept.push(tab)
      continue
    }
    droppedLeafSessionIds.push(...orphans)

    // closeLeaf is the same primitive the user-facing pane close uses, so a
    // repaired tree has exactly the shape it would have had if the pane had
    // been closed normally — splits collapse into the survivor, ratios of
    // untouched splits are preserved.
    let root: TileNode | null = tab.root
    for (const orphanId of orphans) {
      if (root === null) break
      root = closeLeaf(root, orphanId)
    }
    if (root === null) {
      droppedTabIds.push(tab.id)
      continue
    }

    const survivingLeaves = collectLeaves(root)
    kept.push({
      ...tab,
      root,
      // focusedSessionId is a required field on the persisted tab, and it
      // pointed at the orphan in the real-world case. Leaving it dangling
      // would hand the next launch a focus id that resolves to no pane.
      ...(tab.focusedSessionId !== undefined && !sessions[tab.focusedSessionId]
        ? { focusedSessionId: survivingLeaves[0] }
        : {}),
    })
  }

  return { tabs: kept, droppedLeafSessionIds, droppedTabIds }
}
