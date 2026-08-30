import type {
  BuriedPaneRecord,
  DetachedSessionRecord,
  DispatchModeState,
  SessionId,
  SessionMeta,
  TabId,
  TileNode,
  TileTabsState,
} from '@renderer/workspace/types'
import { closeLeaf, collectLeaves } from '@renderer/workspace/tile-tree/treeOps'
import { sanitizeTileTabsState } from '@renderer/workspace/layout/helpers'
import {
  keepTiledLaneSessions,
  scrubGridRowMetadata,
} from '@renderer/workspace/dispatch/tiledDispatchSelectors'

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
/**
 * Does `sessions` actually carry metadata for this id?
 *
 * WHY an own-property check and not a bare `sessions[id]` truthiness test: a plain
 * index read walks the prototype chain, so a leaf id of `toString`,
 * `constructor`, or `valueOf` resolves to an inherited function and reads as
 * "has metadata". That is precisely inverted from what every caller here
 * wants, and it would make such a leaf invisible to BOTH the restore gate and
 * the repair guard — i.e. it would reproduce the permanent-freeze bug while
 * looking healthy. Session ids are `randomUUID()` today, so this needs a
 * hand-edited workspace.json to reach; hand-edited files are named as an
 * explicit threat model throughout this module, so the check should be total.
 *
 * The value must also be truthy, not merely present: rehydrate decides what to
 * restore with a truthiness test of its own (`freshSessions[id] ?`), so an own
 * key holding `undefined` has to read as "no metadata" on this side too or the
 * two halves disagree about what a pane is.
 */
function hasSessionMeta(
  sessions: Record<SessionId, SessionMeta>,
  id: SessionId,
): boolean {
  // `Object.prototype.hasOwnProperty.call` rather than `Object.hasOwn`: this
  // project's TS lib target predates ES2022, and a own-property check is not
  // worth moving the whole compiler target for.
  return Object.prototype.hasOwnProperty.call(sessions, id) && Boolean(sessions[id])
}

/**
 * Every tile leaf that has real metadata — the ownership half of "visible".
 *
 * WHY this is separate from `collectLiveProcessIds`, which on this branch
 * returns the same thing:
 *
 * Ownership answers "whose SessionMeta must survive a save?" while the live set
 * answers "which sessions need a backend process?". Those coincide today, and
 * `collectOwnedSessionIds` used to be built directly on the live set because of
 * that. But the sets are not the same question, and collapsing them makes any
 * future narrowing of "needs a process" silently narrow ownership too — which
 * deletes user data.
 *
 * That is not hypothetical. The in-flight extension-view work adds panes that
 * are real tile leaves with real metadata but deliberately spawn NO process, by
 * skipping them in `collectLiveProcessIds`. Built on the old shape, that skip
 * also removed them from the owned set, so `pickOwnedSessions` dropped their
 * metadata on the very next autosave — turning them into exactly the orphan
 * leaves this module now repairs, and handing the repair guard a live pane to
 * collapse out of the user's tree. Splitting the two sets here is what makes
 * "excluded from spawning" and "excluded from persistence" independent, so a
 * process-less pane kind is safe to add in one place.
 */
export function collectTileLeafIds(input: SessionOwnershipInput): Set<SessionId> {
  const leaves = new Set<SessionId>()
  for (const tab of input.tabs) {
    for (const id of collectLeaves(tab.root)) {
      if (!hasSessionMeta(input.sessions, id)) continue
      leaves.add(id)
    }
  }
  return leaves
}

export function collectOwnedSessionIds(input: SessionOwnershipInput): Set<SessionId> {
  const owned = collectTileLeafIds(input)
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
//
// WHY leaves without SessionMeta are excluded (via `collectTileLeafIds`):
//
// This set is BOTH the rehydrate spawn list and the denominator of the
// restore-completion gate (`expectedSessions` in rehydrate.ts). A leaf whose id
// has no row in `sessions` has no cwd and no kind, so there is literally
// nothing to spawn for it — rehydrate's respawn loop iterates
// `persisted.sessions` and can never even reach it. Counting it made
// `resolvedIds.size === expectedSessions` unsatisfiable FOREVER: restore
// reported `partial-restore`, autosave stayed locked to protect disk, and
// because autosave is the only writer of workspace.json the corrupt tree could
// never be rewritten. A single dangling leaf permanently froze a real user's
// workspace file for three weeks (observed on every boot: expectedCount 4,
// resolvedCount 3, ok false).
//
// The invariant this restores is `liveProcessIds ⊆ keys(sessions)`, which is
// what makes the gate a real subset-equality test instead of a comparison that
// can never hold. It is deliberately NOT "spawn a fresh session for the
// orphan": we do not know its cwd or provider, and inventing one would
// resurrect a pane the user never asked for, pointed at the wrong directory.
//
// If you add a pane kind that must NOT spawn a process, narrow it HERE and
// nowhere else. Narrowing `collectTileLeafIds` instead would drop its metadata
// on the next save — see the comment on that function.
export function collectLiveProcessIds(input: SessionOwnershipInput): Set<SessionId> {
  return collectTileLeafIds(input)
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
    ? scrubGridRowMetadata(
      keepTiledLaneSessions({
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
      }, liveIds),
      // Grid rows also name a PROJECT and a set of expanded parent sessions.
      // A binding to a closed tab filters that row's index to nothing with no
      // UI path back (the picker only lists tabs that exist), so it has to be
      // scrubbed at the same durability boundary as every other pointer.
      new Set(input.tabs.map(tab => tab.id)),
      liveIds,
    )
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
 * Repair the tab structures that autosave is about to serialize: drop tile
 * leaves whose session id has no `sessions` row, collapsing each orphaned split
 * into its surviving sibling, and fix up the pointers that repair invalidates.
 *
 * WHY this belongs at the autosave boundary and not in a close/kill path:
 *
 * `pruneSessionOwnership` already claims to keep the serialized model "closed
 * under restore", and it scrubs every pointer that aims AT a session —
 * `sessions`, `detachedSessions`, `buried`, dispatch focus, tiled lanes. Tile
 * trees were the one owner class it never validated, because `useAutoSave`
 * serialized `state.tabs` verbatim. That asymmetry is what let a torn in-memory
 * state (a leaf whose metadata had already been removed) become durable, and
 * durable corruption here is uniquely bad: it disables the very autosave that
 * would fix it.
 *
 * There is a self-reference that makes this the ONLY place the repair can
 * happen. Ownership is *derived from* tile leaves — `collectOwnedSessionIds`
 * walks the trees — so an orphan leaf can never be removed by pruning
 * `sessions` against owners. The orphan IS an owner; there is nothing for
 * `pickOwnedSessions` to drop. The tree itself has to be rewritten.
 *
 * WHAT THIS DOES NOT DO — do not let the next reader assume otherwise: it
 * repairs the object being SERIALIZED, not `state.tabs`. For the rest of the
 * session the orphan leaf stays in the live tree and still renders, as a
 * default-provider pane stuck idle with a `?` label (TileTree renderWorkspaceLeaf
 * falls back to DEFAULT_PROVIDER and an empty runtime). So on-screen and
 * on-disk deliberately diverge until the next launch, which is the trade this
 * whole change makes: a pane that cannot be restored must not be allowed to
 * hold the user's entire workspace file hostage.
 *
 * A tab that loses every leaf is dropped: its root would be empty, which
 * `TileNode` cannot represent and no pane could render. That is the one
 * destructive branch here, which is why `activeTabId` and `tileTabs` are
 * repaired in the same pure function rather than at the call site — it keeps
 * the whole destructive path testable without a React harness.
 */
export function repairPersistedTabs<
  TTab extends SessionOwnershipTab & { focusedSessionId?: SessionId },
>(input: {
  tabs: readonly TTab[]
  sessions: Record<SessionId, SessionMeta>
  activeTabId: TabId
  tileTabs: TileTabsState | null
}): {
  tabs: TTab[]
  activeTabId: TabId
  tileTabs: TileTabsState | null
  droppedLeafSessionIds: SessionId[]
  droppedTabIds: TabId[]
} {
  const { sessions } = input
  const droppedLeafSessionIds = new Set<SessionId>()
  const droppedTabIds: TabId[] = []
  const kept: TTab[] = []

  for (const tab of input.tabs) {
    const orphans = collectLeaves(tab.root).filter(id => !hasSessionMeta(sessions, id))
    if (orphans.length === 0) {
      kept.push(tab)
      continue
    }
    for (const id of orphans) droppedLeafSessionIds.add(id)

    // closeLeaf is the same primitive the user-facing pane close uses, so a
    // repaired tree has exactly the shape it would have had if the pane had
    // been closed normally — splits collapse into the survivor, ratios of
    // untouched splits are preserved. It nulls EVERY matching leaf in one
    // pass, so iterating the deduped orphan set is sufficient.
    let root: TileNode | null = tab.root
    for (const orphanId of droppedLeafSessionIds) {
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
      // WHY the test is tree membership and not "is focus still in `sessions`":
      // the invariant a tab owes is that its focus names a leaf IT CONTAINS.
      // Checking the sessions map instead would leave focus pointing at a real
      // session that lives in another tab — rehydrate would not repair that
      // either, because its `idMap.get(focusedSessionId) ?? leaves[0]` fallback
      // only fires for an id it cannot resolve at all.
      ...(tab.focusedSessionId !== undefined
        && !survivingLeaves.includes(tab.focusedSessionId)
        ? { focusedSessionId: survivingLeaves[0] }
        : {}),
    })
  }

  // Pointers that only a dropped TAB can invalidate. Both self-heal on read,
  // but this function's whole claim is that what it returns is closed under
  // restore, and leaving a known-dangling id behind would make that a lie.
  const activeTabId = kept.some(t => t.id === input.activeTabId)
    ? input.activeTabId
    : kept[0]?.id ?? input.activeTabId
  const survivingTabIds = new Set(kept.map(t => t.id))
  const tileTabs = input.tileTabs === null || droppedTabIds.length === 0
    ? input.tileTabs
    // sanitizeTileTabsState re-picks focus, re-derives ratios to match the new
    // tab count, and collapses to null below two tabs — so filtering the ids is
    // all this needs to do.
    : sanitizeTileTabsState({
        ...input.tileTabs,
        tabIds: input.tileTabs.tabIds.filter(id => survivingTabIds.has(id)),
      })

  return {
    tabs: kept,
    activeTabId,
    tileTabs,
    droppedLeafSessionIds: [...droppedLeafSessionIds],
    droppedTabIds,
  }
}
